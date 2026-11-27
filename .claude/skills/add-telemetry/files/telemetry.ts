/**
 * OpenTelemetry tracing → Arize Phoenix. Opt-in per agent group.
 *
 * OFF unless the group has `/workspace/agent/otel.json`; without it nothing here
 * runs and the OTel packages are never imported. That file lives in the group
 * directory, which is install state upstream does not version, so toggling it
 * never conflicts on merge.
 *
 * Dependencies load through a DYNAMIC import inside try/catch because `/app/src`
 * is a live mount of the checkout while `node_modules` lives in the image: a
 * group pinned to a stale `imageTag` would crash-loop on boot with "Cannot find
 * module". Dynamic import degrades to telemetry-off instead.
 *
 * Spans are emitted by hand rather than through Arize auto-instrumentation:
 * `providers/claude.ts` imports the Agent SDK via a static `import { query }`,
 * ESM bindings are live and read-only, and Bun has no Node loader hooks — so the
 * patch never lands. We delegate from the hooks the provider already registers.
 *
 * Parenting is explicit (tool under turn) rather than relying on an async
 * context manager. Background work (subagents, monitors) outlives the turn's
 * `result` and therefore runs with no open turn; those spans must not become
 * roots. A `SpanContext` stays valid for parenting after `span.end()` — only the
 * duration freezes, which is what we want, since holding the turn open until
 * background drains would inflate it. `turnEnd()` stashes the context in
 * `detachedTurnCtx` and late spans are stitched into the originating trace,
 * flagged `nanoclaw.detached_from_turn` to separate legitimate background from a
 * parenting bug.
 *
 * Subagent nesting: `SubagentStart` carries no `tool_use_id`, so `subagent.*`
 * hangs under the turn. Worker llm steps carry `parent_tool_use_id` (the open
 * `Agent` call in `toolSpans`) and hang there; worker tools carry `agent_id` and
 * hang under the subagent span. All three converge on the same turn — the SDK
 * exposes no direct `agent_id` ↔ `tool_use_id` link to unify them.
 */
import fs from 'fs';

import type { Context, Span, SpanKind, Tracer } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
// Type-only, and load-bearing as a GUARD rather than for the types: the four OTel
// packages are otherwise reached by dynamic import inside a try/catch, so dropping
// one from package.json would disable telemetry in silence instead of failing.
// These two lines put all four under typecheck, where a missing package goes red
// (`error TS2307: Cannot find module`). The imported symbols are deliberately
// unused: resolution is the whole point, so do not "clean up" these lines.
import type { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { resourceFromAttributes } from '@opentelemetry/resources';

import { loadConfig } from './config.js';

/** Always the group's file in production; the env var lets the suite point at a
 * fixture, since the module initializes on import. */
const CONFIG_PATH = process.env.NANOCLAW_OTEL_CONFIG ?? '/workspace/agent/otel.json';

/** Per-attribute cap. Turns carry whole transcripts; uncapped, a span reaches megabytes. */
const MAX_ATTR_CHARS = 12_000;

/**
 * `<internal>…</internal>` scratchpad, the same expression `poll-loop.ts` uses to
 * blank it before deciding whether anything was delivered. A local copy rather
 * than an import: importing the poll loop would pull the whole runner in here.
 * Flag `g` — use with `.replace`, never `.test` (lastIndex would leak).
 */
const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;

interface OtelFileConfig {
  endpoint?: string;
  /** Shorthand for `resourceAttributes['openinference.project.name']`. */
  projectName?: string;
  headers?: Record<string, string>;
  /**
   * Extra attributes merged into every span's resource — routing or labelling
   * for any collector (`deployment.environment`, a tenant id, a different
   * `service.name`). Overrides the defaults above; never the `nanoclaw.*`
   * identity keys, which are the group's and are written last.
   */
  resourceAttributes?: Record<string, string | number | boolean>;
  /**
   * Opt-in to reasoning TEXT. Off by default because, unlike everything else
   * here, it is not just observation: it changes the agent's inference config
   * and records raw reasoning over the group's real content.
   */
  thinkingText?: boolean;
}

/** Anthropic token counts — cache reads/writes are separate from input tokens. */
interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Slice of `SDKAssistantMessage` — one step of the agent loop, and where
 * reasoning lives: `content` is a union of blocks and `thinking` is one of them,
 * which `claude.ts` drops since it forwards only `text` to the user.
 */
interface AssistantMessage {
  session_id?: string;
  parent_tool_use_id?: string | null;
  subagent_type?: string;
  message?: {
    model?: string;
    stop_reason?: string | null;
    content?: Array<{ type?: string; text?: string; thinking?: string; name?: string }>;
    usage?: TokenUsage;
  };
}

/**
 * Slice of the `QueryInput` `claude.ts` passes when opening a turn: the prompt
 * (who asked and why) and the continuation flag (fresh session vs resumed).
 */
interface TurnInput {
  prompt?: string;
  continuation?: string;
}

interface ToolHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  session_id?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  duration_ms?: number;
  error?: string;
  is_interrupt?: boolean;
  /**
   * Tool output. SIZE only, never content: this is raw `Bash` output, file
   * bodies, scraped pages. Size answers "did the tool return anything?" and "how
   * much context did that inject?" without shipping real content to Phoenix.
   */
  tool_response?: unknown;
}

function log(msg: string): void {
  console.error(`[telemetry] ${msg}`);
}

function truncate(value: string): string {
  return value.length > MAX_ATTR_CHARS ? `${value.slice(0, MAX_ATTR_CHARS)}…[truncated]` : value;
}

/**
 * Provider in OpenInference vocabulary, which is what Phoenix groups by.
 * `runner.provider` is NanoClaw's name (`claude`); `llm.provider` wants the
 * vendor (`anthropic`). An unknown provider passes through rather than becoming
 * a guess.
 */
const PROVIDER_ALIASES: Record<string, string> = { claude: 'anthropic' };
let llmProvider = 'anthropic';
let agentName = 'nanoclaw';

/**
 * Who asked for the turn and why, parsed from the prompt the poll-loop builds:
 *
 *   <message id="123" from="telegram-mg-1" sender="Jane Doe" time="…">
 *   <task time="…">Instructions: weekly report…
 *
 * `from` and `sender` are NOT the same thing and conflating them corrupts the
 * analysis. `formatter.ts` builds `from` out of the routing DESTINATION — it is
 * a route, never a person, and on an agent-triggered turn it holds the sending
 * agent's name. `sender` falls back to `'Unknown'` when there is no human author.
 *
 * So `user.id` is emitted only for a real human sender; the route goes to
 * `nanoclaw.source`, which is honest about being a route. Agent-to-agent traffic
 * landing in `user.id` would show up as a person in Phoenix and inflate
 * cost-per-user with work no human requested.
 *
 * `message` vs `task` separates cost someone asked for from cost the agents
 * generate on their own. One prompt can batch several messages
 * (`maxMessagesPerPrompt`), so distinct origins are counted rather than
 * silently collapsed to the first.
 */
function parsePromptOrigin(prompt: string): {
  trigger: string | null;
  source: string | null;
  sourceCount: number;
  userId: string | null;
} {
  const sources = [...prompt.matchAll(/<message\b[^>]*\bfrom="([^"]*)"/g)].map((m) => m[1]);
  const distinct = [...new Set(sources)];
  const humanSender = [...prompt.matchAll(/<message\b[^>]*\bsender="([^"]*)"/g)]
    .map((m) => m[1])
    .find((s) => s && s !== 'Unknown');
  // `<task>` marks a scheduled run. A scheduled prompt can drag pending messages
  // along, so it wins: what triggered the turn was the schedule.
  const trigger = /<task\b/.test(prompt) ? 'task' : /<message\b/.test(prompt) ? 'message' : null;
  return {
    trigger,
    source: distinct[0] ?? null,
    sourceCount: distinct.length,
    userId: humanSender ?? null,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[not serializable]';
  }
}

/**
 * Instrumentation must never fail the runner. Every exported entry point runs
 * inside this guard: a throw is logged once per entry, so a repeating failure
 * cannot flood the log, and then dropped — the hook or turn it came from carries
 * on as if telemetry were off.
 */
const swallowed = new Set<string>();
function swallow(entry: string, err: unknown): void {
  if (swallowed.has(entry)) return;
  swallowed.add(entry);
  log(`${entry} failed, instrumentation skipped: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Resolves to the promise's value, or to `undefined` once `ms` have passed,
 * whichever comes first. A rejection also resolves to `undefined`. The timer
 * never keeps the process alive.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Reads and validates the config file. `null` = telemetry off for this group. */
function readFileConfig(): OtelFileConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return null; // the normal path: a group without telemetry
  }
  try {
    const cfg = JSON.parse(raw) as OtelFileConfig;
    if (!cfg.endpoint) throw new Error('missing "endpoint"');
    if (cfg.resourceAttributes !== undefined) {
      const ra = cfg.resourceAttributes as unknown;
      const flat =
        typeof ra === 'object' &&
        ra !== null &&
        !Array.isArray(ra) &&
        Object.values(ra).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
      if (!flat)
        throw new Error('invalid "resourceAttributes" (expected a flat object of string/number/boolean values)');
    }
    return cfg;
  } catch (err) {
    log(`invalid config at ${CONFIG_PATH}, telemetry off: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

interface Runtime {
  tracer: Tracer;
  flush: () => Promise<void>;
  close: () => Promise<void>;
  errorStatus: number;
  /** OTel `SpanKind.CLIENT`, for spans that are an outbound call to a service. */
  clientKind: SpanKind;
  childContext: (parent: Span) => Context;
  /** Parent context from a W3C `traceparent` sent by another agent. */
  remoteContext: (traceparent: string) => Context | undefined;
}

let rt: Runtime | null = null;
let turnSpan: Span | null = null;
/**
 * In-flight tool spans, keyed by `tool_use_id`. Keyed, not a LIFO stack: the SDK
 * runs tools in parallel, so a stack cannot tell which tool is closing and would
 * pair durations with the wrong span.
 */
/**
 * Tools that DELIVER to the user. They write to `outbound.db` from inside the MCP
 * server — a separate process, out of reach of the poll-loop's delivery
 * instrumentation — so the tool-exit hook, which runs in the runner, is where
 * this delivery path becomes countable.
 */
const DELIVERY_TOOLS = new Set(['mcp__nanoclaw__send_message', 'mcp__nanoclaw__send_file', 'mcp__nanoclaw__send_card']);

const toolSpans = new Map<
  string,
  {
    span: Span;
    startedAt: number;
    name: string;
    /** Segmentation seeds — see the checkpoint block below. */
    seedAttrs: Record<string, string | number | boolean>;
    parentCtx: Context | undefined;
    /** First segment's context — where worker llm steps anchor. */
    anchorCtx: Context;
    segment: number;
    segmentStartedAt: number;
  }
>();

/** Context key for the main thread in the boundary map. */
const MAIN_CTX = '__main__';
/**
 * End of the last known activity, PER EXECUTION CONTEXT. An assistant message
 * arrives as an instant — the SDK never says when the model started producing
 * it. But between the previous activity ending and the message arriving, the
 * model is what was working, so that interval is the LLM span's duration. This
 * is declared INFERENCE, not measurement; tools have their own spans and are
 * not charged here.
 *
 * Keyed, not a single number: the main thread and subagent workers produce
 * INTERLEAVED messages, so one side would steal the other's boundary and the
 * durations swapped owners.
 *
 * Key is the worker's `parent_tool_use_id`, or `MAIN_CTX`. The SDK does not link
 * `agent_id` to `tool_use_id`, so worker tools (which carry only `agent_id`) use
 * their own key — what matters is that none of them write to the main one.
 */
const boundaries = new Map<string, number>();
/**
 * Reasoning-token estimate.
 *
 * By default the thinking block arrives EMPTY — just `{type:'thinking'}`, no
 * text and no signature. That is not API redaction but configuration: Claude
 * Code resolves `thinking.display` to `omitted`, and the SDK hands over this
 * count precisely so the phase stays measurable. `thinkingOption()` flips that
 * per group, and then the text really appears.
 *
 * The count holds in both modes: `estimated_tokens` is the block's running
 * total, `estimated_tokens_delta` the per-frame increment.
 */
let thinkingTokensBlock = 0;
let thinkingTokensTurn = 0;
/**
 * When THIS runner process loaded the module — i.e. the container's age. Module
 * `const`, never reset: it is not turn state.
 *
 * Separates the two causes of a large `inbound_wait_ms`: low uptime means the
 * message waited for the container to START, high uptime that it queued on the
 * host with the container already up. A measurement rather than a `cold_start`
 * boolean, which would lie about a container that started and sat idle.
 */
const MODULE_LOADED_AT = Date.now();
/**
 * Per-turn counters: events that matter by HOW MANY TIMES they happened, not
 * individually — a span each would only fill the trace with noise.
 */
let apiRetries = 0;
let lastRetryStatus: number | null = null;
let memoryRecalls = 0;
/**
 * Destination deliveries this turn. Zero on a chat turn that produced text is the
 * silent failure worth hunting: the turn closes OK and the user got nothing. As a
 * turn attribute, "which turns delivered nothing" needs no join with children.
 */
let deliveredCount = 0;
/**
 * Tool calls this turn, and WHICH skills / MCP servers they went through. The
 * per-span attributes answer "what did this call cost"; these answer "did this
 * turn touch skill X" without a join against the children — the question you
 * actually ask when scanning a list of turns.
 *
 * Sets, not counters: the same skill invoked four times is one fact here, and
 * the count already lives in the child spans.
 */
let toolCalls = 0;
const skillsUsed = new Set<string>();
const mcpServersUsed = new Set<string>();
/** Start of the open turn — lower bound for spans with a backdated duration. */
let turnStartedAt: number | null = null;
/**
 * Provider session id, learned from the first turn signal that carries it (tool
 * hook or assistant message). Guards the cost cursor: subtracting a previous
 * total only makes sense if it came from the SAME session.
 */
let currentSessionId: string | null = null;
/**
 * Running cost total of the CURRENT `claude` process, for `recordCost`.
 *
 * In memory and reset by `turnStart`, deliberately not persisted. `total_cost_usd`
 * is the running total of the Claude Code PROCESS, and a process lives exactly
 * one `query()`: the total restarts with every container and never drops inside
 * a live one. A cursor persisted across containers therefore subtracts a dead
 * process's total from the first turn of the next container, or labels an exact
 * number a ceiling; a cursor that dies with the process is exact.
 */
let processCostCursor: number | null = null;
/**
 * Running API-time total of the CURRENT `claude` process, for `recordApiDuration`.
 * Same shape, lifetime and reset point as `processCostCursor`: `duration_api_ms`
 * is the same kind of number, a running total of the process.
 */
let processApiCursor: number | null = null;
/** In-flight subagent spans, keyed by `agent_id`. */
const subagentSpans = new Map<string, SubagentEntry>();
/** In-flight subagent contexts — where worker tools hang. */
const subagentCtxs = new Map<string, Context>();
interface SubagentEntry {
  span: Span;
  name: string;
  seedAttrs: Record<string, string | number | boolean>;
  parentCtx: Context | undefined;
  segment: number;
  segmentStartedAt: number;
}

/* -------------------------------------------------------------------------- *
 * Checkpoint segmentation.
 *
 * The one crash the flush handlers cannot cover is a NATIVE death (a SIGTRAP,
 * exit 133): no JS runs, and every OPEN span dies unexported. Children that
 * already exported keep referencing those span ids — orphans with no turn and no
 * subagent to hang from, and a long investigation becomes unreadable.
 *
 * The fix is to get the parent ids OUT early. A long-lived span (turn, tool,
 * subagent) open past `SEGMENT_AFTER_MS` is ended and REOPENED as a sibling
 * segment under the same parent: segment 1 exports, and every later child
 * anchors to segment 1's context (`SpanContext` stays valid after `end()`, the
 * same property `detachedTurnCtx` relies on). After the first checkpoint,
 * nothing new can orphan; the designed loss bound is the current open segment.
 *
 * Intermediate segments carry `nanoclaw.segment` and `nanoclaw.segment_continues`;
 * the FINAL segment is the one the normal close paths (`turnEnd`, `toolEnd`,
 * subagent stop, `shutdownTelemetry`) operate on, so counters, cost, output and
 * status land there exactly once. "Real turn ends" = spans WITHOUT
 * `segment_continues`. Short spans (< 2 min) never segment and keep today's
 * single clean span.
 * -------------------------------------------------------------------------- */
const SEGMENT_AFTER_MS = 120_000;
const CHECKPOINT_INTERVAL_MS = 60_000;
/** Seed attributes of the open turn — what a new segment reopens with. */
let turnSeedAttrs: Record<string, string | number | boolean> | null = null;
/**
 * Parent the turn was opened under — the FALLBACK anchor for a new segment, not
 * the usual one.
 *
 * Segments hang off `turnAnchorCtx` (segment 1) and only fall back to this when
 * there is no anchor. The reason is at the rotation site: for a ROOT turn this is
 * `undefined`, so anchoring segments here opened a new trace per rotation. Read
 * that block before changing where a segment parents.
 */
let turnParentCtx: Context | undefined;
/**
 * FIRST segment of the open turn — the crash-safe anchor. Everything that
 * parents to "the turn" (children, `publishTraceparent`, `detachedTurnCtx`)
 * goes through this span, never the current segment: once the first checkpoint
 * exports it, no later child can orphan.
 */
let turnAnchorSpan: Span | null = null;
let turnAnchorCtx: Context | null = null;
let turnSegment = 1;
let turnSegmentStartedAt: number | null = null;
/**
 * Context of the last closed turn. A `SpanContext` stays valid for parenting
 * after `span.end()` — only the duration freezes. This is what stitches
 * post-`result` background work into the trace that produced it, instead of
 * letting it scatter into single-span root traces.
 */
let detachedTurnCtx: Context | null = null;
/**
 * `traceparent` of the most recent turn, for the runner's delivery leg.
 *
 * The MCP server cannot use this — it runs in another process and reads the same
 * value from `session_state`. The poll-loop runs in the runner, so it reads the
 * value straight from memory: no DB round-trip and no age cap to expire.
 */
let currentTraceparent: string | null = null;

/**
 * Parent for a new span: the open turn, or the just-closed one. `detached` marks
 * the second case; the caller stamps `nanoclaw.detached_from_turn`.
 */
function parentContext(): { ctx: Context | undefined; detached: boolean } {
  if (!rt) return { ctx: undefined, detached: false };
  // The ANCHOR (first segment), not the current segment: after the first
  // checkpoint the anchor is exported, so children survive a native crash.
  if (turnSpan) return { ctx: turnAnchorCtx ?? rt.childContext(turnSpan), detached: false };
  return { ctx: detachedTurnCtx ?? undefined, detached: detachedTurnCtx !== null };
}

/**
 * Point-in-time event span, child of the open turn.
 *
 * `durationMs` backdates the start so the span covers the real window; without
 * it the span collapses to an instant. `errMessage` marks the span failed.
 *
 * The attribute type is deliberately wide. A `Record<string, string>` forces
 * callers to wrap numbers in `String()`, and the collector then stores them as
 * TEXT — the span still appears, but the attribute no longer sums or sorts
 * numerically. OTel accepts numbers natively; never stringify one.
 */
function pointSpan(
  name: string,
  attributes: Record<string, string | number | boolean>,
  opts?: { durationMs?: number; errMessage?: string },
): void {
  if (!rt) return;
  const now = Date.now();
  const durationMs = opts?.durationMs;
  let start = typeof durationMs === 'number' && durationMs > 0 ? now - durationMs : now;
  // Without the clamp, a reported duration longer than the turn's own elapsed
  // time starts the child before its parent — Phoenix draws that as a negative
  // offset and the tree becomes unreadable.
  if (turnStartedAt !== null && start < turnStartedAt) start = turnStartedAt;
  const { ctx, detached } = parentContext();
  const span = rt.tracer.startSpan(name, { startTime: start, attributes }, ctx);
  if (detached) span.setAttribute('nanoclaw.detached_from_turn', true);
  if (opts?.errMessage) span.setStatus({ code: rt.errorStatus, message: truncate(opts.errMessage) });
  span.end(now);
}

/**
 * Writes the call's token counts in the OpenInference convention.
 *
 * Anthropic's `input_tokens` does NOT include cache tokens — those arrive in
 * their own fields. In OpenInference `prompt_details.*` is a SUBSET of `prompt`,
 * so `prompt` must sum all three. Without that sum Phoenix reports a small
 * fraction of real consumption, because these agents spend on re-read context,
 * not generated text.
 *
 * The input side is trustworthy: summing `prompt` over a trace's `llm.call` spans
 * reproduces the turn's own total, so it belongs in the vendor namespace.
 *
 * THE OUTPUT SIDE IS NOT, and is deliberately absent here. `usage.output_tokens`
 * on an assistant message is a partial streaming value — a handful of tokens on a
 * span whose own `output.value` runs to thousands of characters. Published as
 * `llm.token_count.completion` it makes a cost engine price a fraction of the
 * real output spend — a wrong number wearing the costume of a measurement. It
 * ships as `nanoclaw.output_tokens_partial` instead, where no cost engine reads
 * it.
 *
 * DO NOT "fix" this by reading the last message instead of the first: the
 * grouping identity in `usageIdentity` INCLUDES `output_tokens`, so messages
 * only merge while that field is identical. If the real count ever arrived it
 * would open a span of its own — and none does. The authoritative per-call
 * number would require `includePartialMessages: true` and the `message_delta`
 * stream event. The turn's `result` is the only place the true total exists
 * today; see `setTurnTokenAttrs`.
 *
 * `total` is omitted for the same reason: prompt + a bogus completion is not a
 * total of anything.
 */
function setCallTokenAttrs(span: Span, u: TokenUsage): void {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const promptTok = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  span.setAttribute('llm.token_count.prompt', promptTok);
  span.setAttribute('gen_ai.usage.input_tokens', promptTok);
  span.setAttribute('nanoclaw.output_tokens_partial', n(u.output_tokens));
  if (typeof u.cache_read_input_tokens === 'number') {
    span.setAttribute('llm.token_count.prompt_details.cache_read', u.cache_read_input_tokens);
  }
  if (typeof u.cache_creation_input_tokens === 'number') {
    span.setAttribute('llm.token_count.prompt_details.cache_write', u.cache_creation_input_tokens);
  }
}

/**
 * Writes the TURN's token counts — the authoritative ones, from the SDK's
 * `result.usage`. This is the only place a true output count exists.
 *
 * Deliberately OUTSIDE `llm.token_count.*` / `gen_ai.usage.*`, and the reason is
 * empirical rather than stylistic. Phoenix reports `tokenCountTotal: 0` for
 * these spans: its cost engine only prices spans of kind LLM, and a turn is
 * AGENT, so it never read these attributes at all — it builds the turn's figure
 * by rolling up children (`cumulativeTokenCountTotal`). Langfuse does NOT skip
 * them: it bills the turn ON TOP of what it bills the same turn's children,
 * double counting the one consumption.
 *
 * So the vendor namespace bought nothing here and cost correctness in a second
 * backend. Under `nanoclaw.*` the numbers stay queryable, Phoenix is unaffected,
 * and no cost engine can double count them.
 */
function setTurnTokenAttrs(span: Span, u: TokenUsage): void {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const promptTok = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  const outTok = n(u.output_tokens);
  span.setAttribute('nanoclaw.turn_tokens_prompt', promptTok);
  span.setAttribute('nanoclaw.turn_tokens_completion', outTok);
  span.setAttribute('nanoclaw.turn_tokens_total', promptTok + outTok);
  if (typeof u.cache_read_input_tokens === 'number') {
    span.setAttribute('nanoclaw.turn_tokens_cache_read', u.cache_read_input_tokens);
  }
  if (typeof u.cache_creation_input_tokens === 'number') {
    span.setAttribute('nanoclaw.turn_tokens_cache_write', u.cache_creation_input_tokens);
  }
}
// Declared BEFORE the init block: init calls registerFlushHandlers(), and a
// later `let` would fall in the temporal dead zone.
let flushHandlersRegistered = false;
/** Interval driving `checkpointOpenSpans`; unref'd, cleared on shutdown. */
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
/** In-memory exporter for the suite; `null` in production. See the seam in init. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memoryExporter: any = null;
/**
 * Session DB layer and `telemetry-state.js`, loaded dynamically during init.
 *
 * Typed with `typeof import(...)` — a TYPE-ONLY reference that emits no runtime
 * import, so the dynamic load below keeps its degrade-to-off behavior. What it
 * buys is the compiler: a renamed or removed export (`getOutboundDb`,
 * `openInboundDb`, the state helpers) goes red in typecheck instead of failing at
 * runtime as an `undefined is not a function` inside a `catch`. Columns inside
 * the SQL strings stay unguarded; those are the unit tests' job.
 */
let dbMod: typeof import('./mailbox/sqlite/connection.js') | null = null;
/** The runner → MCP server channel (another process). */
let stateMod: typeof import('./telemetry-state.js') | null = null;
/** Message ids already attributed to a turn within this `query()` lifetime. */
const attributedIds = new Set<string>();

/** An inbound message, as telemetry sees it. */
interface InboundOrigin {
  kind: string;
  text: string;
  senderName: string | null;
  traceparent: string | null;
  /**
   * When the message became ELIGIBLE: `max(timestamp, process_after)`, on the
   * HOST clock. Not the same as `timestamp` — `insertTaskRow` writes `timestamp`
   * when a task is ARMED and `process_after` when it comes DUE, and a recurring
   * task puts days between them. Using `timestamp` alone invents phantom waits.
   */
  dueAtMs: number | null;
  /**
   * When the container claimed the message, on the CONTAINER clock.
   *
   * Only the claim instant in the `pendingOnly` branch. `markCompleted` does an
   * `INSERT OR REPLACE` on the same `processing_ack` row, so once the turn ends
   * this is OVERWRITTEN with the completion time — in the `sinceMs` branch
   * (continuation origin, in `turnEnd`) the rows are already `completed` and the
   * field measures something else. Do not reuse outside `turnStart`.
   */
  claimedAtMs: number | null;
}

/** `Date.parse` returning `null` instead of `NaN`, which would poison a span attribute. */
function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Messages claimed since `sinceMs` (or still `processing`), read from `inbound.db`.
 *
 * `openInboundDb()` is the right reader and `getInboundDb()` is NOT: the host
 * writes `messages_in` continuously, and the cached singleton would freeze this
 * reader on a stale snapshot — `connection.ts` documents that as the cause of
 * virtiofs stalls. The caller closes (try/finally).
 */
function readClaimedMessages(opts: { sinceMs?: number; pendingOnly?: boolean }): InboundOrigin[] {
  if (!dbMod) return [];
  const outbound = dbMod.getOutboundDb();
  const rows = (
    opts.pendingOnly
      ? outbound.prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'processing'").all()
      : // STRING comparison, not `datetime()`. CLAUDE.md says to wrap
        // both sides in `datetime()` to normalize mixed formats — but here both
        // are ISO-8601 UTC from `new Date().toISOString()`
        // (`markProcessing`/`markCompleted`), and `datetime()` TRUNCATES to
        // seconds, which would drop every continuation that happens in the same
        // second the previous turn closed — the common case in a fluid
        // conversation. ISO with milliseconds sorts lexicographically the same as
        // chronologically.
        //
        // `>=`, not `>`: the timestamp is a coarse filter and the real guard is
        // the id dedupe below, since the previous turn's batch was consumed in
        // `turnStart`. With `>`, an exchange closing on the same instant as the
        // previous turn would be discarded.
        outbound
          .prepare('SELECT message_id, status_changed FROM processing_ack WHERE status_changed >= ?')
          .all(new Date(opts.sinceMs ?? 0).toISOString())
  ) as Array<{ message_id: string; status_changed: string }>;

  const claimedAt = new Map(rows.map((r) => [r.message_id, parseMs(r.status_changed)]));
  const ids = rows.map((r) => r.message_id).filter((id) => !attributedIds.has(id));
  if (ids.length === 0) return [];

  const inbound = dbMod.openInboundDb();
  try {
    const msgs = inbound
      .prepare(
        `SELECT id, kind, content, timestamp, process_after FROM messages_in WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY timestamp`,
      )
      .all(...ids) as Array<{
      id: string;
      kind: string;
      content: string;
      timestamp: string;
      process_after: string | null;
    }>;

    const out: InboundOrigin[] = [];
    for (const m of msgs) {
      attributedIds.add(m.id);
      let c: Record<string, unknown> = {};
      try {
        c = JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        /* non-JSON content: the kind is all that survives */
      }
      const author = c.author as { isBot?: boolean } | undefined;
      // `max`, not `??`: a recurring task carries BOTH fields and the due time is
      // what counts. Outside tasks, `process_after` is null and the timestamp wins.
      const enqueued = parseMs(m.timestamp);
      const due = parseMs(m.process_after);
      out.push({
        kind: m.kind,
        text: String(c.text ?? c.prompt ?? ''),
        // Only a HUMAN sender becomes a user — see the note in `parsePromptOrigin`.
        senderName: author?.isBot === true ? null : ((c.senderName ?? c.sender ?? null) as string | null),
        traceparent: typeof c.traceparent === 'string' ? c.traceparent : null,
        dueAtMs: enqueued === null && due === null ? null : Math.max(enqueued ?? 0, due ?? 0),
        claimedAtMs: claimedAt.get(m.id) ?? null,
      });
    }
    return out;
  } finally {
    inbound.close();
  }
}

/**
 * Failure class, derived from what already arrives (exit code, error text,
 * interrupt). Without it, grouping failures means reading strings — and nobody does.
 *
 * Knowing THAT something failed prioritizes nothing; knowing most failures are
 * `tool_not_found` points at a missing image dependency, which is a concrete fix.
 *
 * `other` is deliberate: an honest "unknown" class avoids forcing new failures
 * into existing labels and masking an emerging pattern.
 */
function classifyFailure(text: string, exitCode: number | null, isInterrupt: boolean): string {
  if (isInterrupt) return 'interrupted';
  const t = text.toLowerCase();
  // A PENDING APPROVAL is not a failure, and goes first because the text carries
  // "Exit code 1" and would land in an error class by accident. `approval-pending`
  // is an ncl protocol code (a typed union in `src/cli/frame.ts`), so matching it
  // reads an enum rather than guessing prose. `toolEnd` skips the error status for
  // this class.
  if (/approval-pending/.test(t)) return 'approval_pending';
  // A tool that returned MORE than the harness accepts (`Read` past its token
  // cap). Not `context_overflow`: the context is fine, the single result is not.
  // Before `tool_not_found` because the message names the file that exists.
  if (/exceeds maximum allowed tokens|output too large/.test(t)) return 'output_too_large';
  // Killed from outside — 137 is 128+SIGKILL, the OOM killer's signature. Before
  // `permission`, which would otherwise not match but keeps the class explicit.
  if (exitCode === 137 || /exited with code 137|sigkill/.test(t)) return 'killed';
  // `is not installed` / `ModuleNotFoundError`: a binary that fails politely with
  // its own message, or a missing Python import, are the SAME cause as "command
  // not found" — a dependency absent from the image.
  if (exitCode === 127 || /command not found|no such file or directory|is not installed|modulenotfounderror/.test(t)) {
    return 'tool_not_found';
  }
  if (/timed out|timeout|etimedout/.test(t)) return 'timeout';
  // QUOTA BLOCKS, and BEFORE `permission` — the ordering is the easy thing to get
  // wrong. `permission` matches `forbidden`, and a billing block arrives as "403
  // billing_error"; placed after `permission` that text would send an operator
  // investigating access when the problem is the invoice.
  //
  // Both labels are the ones `classifyRateLimitEvent` already emits from the SDK's
  // structured event — one vocabulary, two sources. Duration deliberately stays
  // out of the name: `retryable` and `resets_at` on `provider.blocked` say whether
  // it clears in seconds or hours, without multiplying classes that then diverge
  // between the two sources.
  //
  // `quota` before `rate_limit`: more specific and more severe first, for a
  // message carrying words from both families.
  if (/out of credits|credits_required|out_of_credits|billing|insufficient (credit|fund)/.test(t)) return 'quota';
  if (/session limit|usage limit|rate.?limit|\b429\b|too many requests/.test(t)) return 'rate_limit';
  if (/permission|denied|eacces|forbidden|not allowed|unauthorized/.test(t)) return 'permission';
  // No `rate.?limit` or `429` here: they moved to `rate_limit` above, leaving a
  // readable boundary — `api_error` is the SERVER failing, `rate_limit` is you
  // being turned away.
  if (/overloaded|\b(500|502|503|529)\b|api error/.test(t)) return 'api_error';
  if (/context (window|length)|too many tokens|maximum context|prompt is too long/.test(t)) return 'context_overflow';
  if (/refus|cannot assist|can't help with|unable to comply/.test(t)) return 'model_refusal';
  return 'other';
}

/**
 * `mcp__<server>__<tool>`, the shape the SDK builds for every MCP tool. Lazy on
 * the server segment, so `mcp__nanoclaw__send_message` splits at the FIRST pair
 * of underscores. A server whose sanitized name itself contains `__` would split
 * in the wrong place — the name alone cannot disambiguate, and no server wired
 * here has one.
 */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * What KIND of tool this is, from the call itself. All of it is already in the
 * trace — the server inside the tool name, the skill inside `tool.parameters` —
 * but only as strings, so "which skills did this agent use" meant a `LIKE` over
 * span names or parsing JSON out of an attribute. Derived here, the same question
 * is a `GROUP BY`.
 *
 * `builtin` is returned rather than left empty: an absent attribute cannot be
 * grouped, and "everything that is not MCP and not a skill" is a real bucket.
 * Subagents deliberately have no class here — the SDK names no constant for its
 * subagent tools, and worker identity already lives in `nanoclaw.agent_id` and
 * the `subagent.*` spans.
 */
function classifyTool(
  toolName: string,
  input?: Record<string, unknown>,
): { kind: string; server?: string; tool?: string; skill?: string } {
  const mcp = MCP_TOOL_NAME.exec(toolName);
  if (mcp) return { kind: 'mcp', server: mcp[1], tool: mcp[2] };
  if (toolName === 'Skill') {
    // The CLI names the field `skill`. Guarded anyway: if a future CLI renames
    // it, the class still lands and the whole
    // input remains in `tool.parameters` — better than a `[object Object]`.
    const skill = input?.skill;
    return typeof skill === 'string' && skill ? { kind: 'skill', skill } : { kind: 'skill' };
  }
  return { kind: 'builtin' };
}

/** `kind` classifies the trigger at the source, with no regex over the built prompt. */
function triggerFromKinds(kinds: string[]): string | null {
  if (kinds.length === 0) return null;
  return kinds.includes('task') ? 'task' : 'message';
}

const fileConfig = readFileConfig();
if (fileConfig) {
  try {
    // Dynamic import: a missing dependency turns telemetry off rather than crashing.
    const [api, exporterMod, resourcesMod, sdkMod] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/exporter-trace-otlp-proto'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-trace-base'),
    ]);

    // DB layer by dynamic import, same idiom as the OTel dependencies: no static
    // coupling, and a missing module only disables origin lookup.
    //
    // Loaded HERE rather than at use time: `turnEnd` is synchronous and calls
    // `span.end()` at the end, so an `await` at query time would resolve after the
    // span closed — and an attribute on a closed span is a SILENT no-op.
    try {
      // `mailbox/sqlite/connection.js` is where the mailbox seam keeps the raw
      // session handles. The catch below turns a future move into a disabled
      // lookup rather than a crash. A missing or
      // renamed EXPORT is caught earlier, by the `typeof import` on the
      // declarations above; a moved MODULE still fails silently into
      // `dbMod = null`, so that path is asserted in telemetry.test.ts.
      dbMod = await import('./mailbox/sqlite/connection.js');
      stateMod = await import('./telemetry-state.js');
    } catch (err) {
      dbMod = null;
      stateMod = null;
      log(
        `database layer unavailable, continuation origin disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const runner = loadConfig();
    llmProvider = PROVIDER_ALIASES[runner.provider] ?? runner.provider ?? 'anthropic';
    agentName = runner.groupName || 'nanoclaw';
    memoryExporter = fileConfig.endpoint === 'memory:' ? new sdkMod.InMemorySpanExporter() : null;

    // Group identity as SPAN attributes, on top of the resource copy below:
    // Phoenix's span API exposes only span attributes, and with every group in
    // one shared project this is what makes per-agent filtering possible.
    // `onStart` is the single funnel over all startSpan call sites, present and
    // future — no per-call-site stamping to forget.
    const groupAttrs: Record<string, string> = {
      'nanoclaw.group_name': runner.groupName || 'nanoclaw',
      // Reasoning effort REQUESTED of the provider, from `container.json`. Unlike
      // `llm.model_name` — which the SDK echoes back, so it is the model that
      // actually ran — nothing echoes effort, so this records intent, not
      // confirmation. Container-level, like the rest of this block: the runner
      // passes it on every query and it cannot change without a respawn.
      //
      // Always written, `'default'` included: an absent attribute could not
      // distinguish "left at the SDK default" from "span predates this
      // instrument", and the first is the biggest bucket — most groups set no
      // effort at all.
      'nanoclaw.effort': runner.effort || 'default',
    };
    if (runner.agentGroupId) groupAttrs['nanoclaw.agent_group_id'] = runner.agentGroupId;
    if (runner.provider) groupAttrs['nanoclaw.provider'] = runner.provider;
    const groupStampProcessor: SpanProcessor = {
      onStart(span) {
        for (const [k, v] of Object.entries(groupAttrs)) span.setAttribute(k, v);
      },
      onEnd() {},
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };

    const provider = new sdkMod.BasicTracerProvider({
      resource: resourcesMod.resourceFromAttributes({
        'service.name': 'nanoclaw-agent',
        // ONE shared Phoenix project for the whole install. Phoenix assigns the
        // project by the trace ROOT, so per-group projects fall apart on any
        // agent-to-agent trace — the delegated agent's spans land in the
        // caller's project and its own project looks empty. Filter per agent
        // with the `nanoclaw.group_name` SPAN attribute instead.
        'openinference.project.name': fileConfig.projectName || 'nanoclaw',
        // Operator-chosen resource keys for any collector. Spread AFTER the two
        // defaults so they can be overridden, and BEFORE the `nanoclaw.*` keys
        // so the group's identity cannot be.
        ...(fileConfig.resourceAttributes ?? {}),
        'nanoclaw.group_name': runner.groupName,
        'nanoclaw.agent_group_id': runner.agentGroupId,
        'nanoclaw.provider': runner.provider,
        'nanoclaw.effort': runner.effort || 'default',
      }),
      // Test seam: `memory:` swaps the OTLP exporter for an in-memory one with a
      // SYNCHRONOUS processor, so the suite reads spans without network or
      // batching. A production endpoint is always an http(s) URL, so this branch
      // is unreachable outside tests.
      spanProcessors: [
        groupStampProcessor,
        memoryExporter
          ? new sdkMod.SimpleSpanProcessor(memoryExporter)
          : new sdkMod.BatchSpanProcessor(
              new exporterMod.OTLPTraceExporter({ url: fileConfig.endpoint, headers: fileConfig.headers }),
              {
                // Shorter export cadence than the 5s default: after a checkpoint
                // segments a span, this is the residual native-crash loss window.
                scheduledDelayMillis: 2000,
                // Both raised off their defaults (2048 / 512): an investigation
                // burst overflows the default queue, and because the drop is
                // uniformly random it takes PARENT spans, orphaning their children.
                // A full queue discards silently, so the only symptom is a broken
                // tree. Sized for a stalled collector rather than for throughput:
                // tens of minutes of a heavy burst fit before anything drops.
                maxQueueSize: 8192,
                maxExportBatchSize: 1024,
              },
            ),
      ],
    });

    rt = {
      tracer: provider.getTracer('nanoclaw-agent-runner'),
      flush: () => provider.forceFlush().then(() => {}),
      close: () => provider.shutdown(),
      errorStatus: api.SpanStatusCode.ERROR,
      clientKind: api.SpanKind.CLIENT,
      childContext: (parent: Span) => api.trace.setSpan(api.context.active(), parent),
      // Explicit parse instead of `propagation.extract`, which needs a registered
      // global propagator that this process does not install.
      remoteContext: (traceparent: string) => {
        const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent);
        if (!m || m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) return undefined;
        return api.trace.setSpanContext(api.context.active(), {
          traceId: m[1],
          spanId: m[2],
          traceFlags: parseInt(m[3], 16),
          isRemote: true,
        });
      },
    };

    registerFlushHandlers();
    // Production plumbing only — the suite calls `checkpointOpenSpans` directly
    // with an injected clock. `unref` so the timer never holds the process open.
    checkpointTimer = setInterval(() => checkpointOpenSpans(), CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
    log(`active — exporting to ${fileConfig.endpoint}`);
  } catch (err) {
    log(
      `unavailable (missing dependency or init failed), continuing without telemetry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    rt = null;
  }
}

/**
 * Containers run with `--rm` and die on SIGTERM. Without draining the
 * BatchSpanProcessor here, the end of every session evaporates with the container
 * — the same loss CLAUDE.md documents for logs.
 *
 * The runner registers no signal handler of its own, so installing one makes
 * this module responsible for exiting the process (see the ownership rule below).
 */
function registerFlushHandlers(): void {
  if (flushHandlersRegistered) return;
  flushHandlersRegistered = true;

  // EXIT OWNERSHIP. The runner registers no handler of its own today, so this
  // module is what turns the signal into an exit. Decided at fire time, not at
  // registration: if an upstream update later installs a graceful shutdown in
  // the runner, that handler is registered after this one, and two handlers
  // both calling `process.exit` would race — ours could cut its cleanup short.
  // When another listener is present, this one only drains and steps aside.
  const ownsExit = (event: string): boolean => process.listenerCount(event) === 1;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void (async () => {
        try {
          await shutdownTelemetry();
        } finally {
          if (ownsExit(signal)) process.exit(signal === 'SIGINT' ? 130 : 143);
        }
      })();
    });
  }

  // JS-level crashes. Registering `uncaughtException` suppresses the runtime's
  // default fatal report, so we own both the stderr print and the non-zero exit
  // — the crash is never swallowed. A NATIVE death (SIGTRAP) skips all of this;
  // that loss is bounded by the checkpoint segmentation instead. Same ownership
  // rule as the signals: with another listener present, it owns the exit.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (errOrReason: unknown) => {
      console.error(`[telemetry] ${event}:`, errOrReason instanceof Error ? errOrReason.stack : errOrReason);
      void (async () => {
        try {
          runnerError('crash', errOrReason, { fatal: true });
          await shutdownTelemetry();
        } finally {
          if (ownsExit(event)) process.exit(1);
        }
      })();
    });
  }
}

/**
 * Finished spans, for the suite. Empty (and harmless) in production, where
 * `memoryExporter` is `null`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __testSpans(): any[] {
  return memoryExporter ? memoryExporter.getFinishedSpans() : [];
}

/** Test-only: arms the continuation anchor at a chosen instant (the suite cannot move `Date.now()`). */
export function __testArmSignal(atMs: number): void {
  pendingSignalAt = atMs;
}

/** Clears collected spans and all state between suite cases. */
export function __testReset(): void {
  memoryExporter?.reset();
  resetTurnState();
  // Everything below outlives a single turn, which is why it is NOT in
  // `resetTurnState`: state scoped to a `query()` lifetime, to background work,
  // or to the provider session.
  pendingCall = null;
  turnIsContinuation = false;
  continuationWindowStartMs = null;
  nudgePending = false;
  processCostCursor = null;
  processApiCursor = null;
  currentSessionId = null;
  noUsageSeq = 0;
  attributedIds.clear();
  toolSpans.clear();
  subagentSpans.clear();
  subagentCtxs.clear();
  // One-way latch in production, but it must not survive between cases: a test
  // that runs the shutdown path would silently turn every later one into a no-op.
  shutdownStarted = false;
}

/**
 * Closes every open span with ERROR status. Split from `shutdownTelemetry` so the
 * suite can exercise it without `rt.close()` poisoning later cases, and so the
 * crash handlers share the exact same close semantics as SIGTERM.
 */
export function closeOpenSpans(message = 'container shut down'): void {
  if (!rt) return;
  // Inline guard rather than the impl split the other entries use: the
  // integration test asserts, by AST, that this body calls `applyTurnCounters`.
  try {
    flushCall();
    for (const entry of toolSpans.values()) {
      entry.span.setStatus({ code: rt.errorStatus, message });
      entry.span.end();
    }
    for (const entry of subagentSpans.values()) {
      entry.span.setStatus({ code: rt.errorStatus, message });
      entry.span.end();
    }
    toolSpans.clear();
    subagentSpans.clear();
    subagentCtxs.clear();
    boundaries.clear();
    detachedTurnCtx = null;
    if (turnSpan) {
      turnSpan.setStatus({ code: rt.errorStatus, message });
      // The turn dies without a `result`, but what it already did lives in the
      // counters — and an interrupted turn is exactly where "did anything go out
      // before it died?" is the question.
      applyTurnCounters(turnSpan);
      turnSpan.end();
      turnSpan = null;
    }
  } catch (err) {
    swallow('closeOpenSpans', err);
  }
}

// Declared before use in the crash handlers; guards SIGTERM and a JS crash
// arriving together — the first caller drains and exits, the second returns.
let shutdownStarted = false;
/** Upper bound on the whole shutdown drain: flush plus exporter close. */
const SHUTDOWN_CAP_MS = 4000;

/**
 * Closes pending spans and drains the exporter. Best-effort, with a time cap.
 *
 * NOT exported: the only callers are the signal and crash handlers below, in
 * this module. Nothing outside owns the container's shutdown path.
 */
async function shutdownTelemetry(): Promise<void> {
  if (!rt) return;
  if (shutdownStarted) return;
  shutdownStarted = true;

  if (checkpointTimer !== null) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
  closeOpenSpans();

  // ONE deadline over flush AND close. A shutdown stuck on a stalled collector
  // is worse than losing the last spans: the host kills the container after its
  // stop grace anyway, and a drain that outlives it saves nothing.
  const drained = await withDeadline(
    rt
      .flush()
      .then(() => rt!.close())
      .then(() => true),
    SHUTDOWN_CAP_MS,
  );
  if (drained !== true) log(`drain did not complete within ${SHUTDOWN_CAP_MS}ms`);
}

/**
 * Segments long-lived open spans — see the checkpoint block near the top.
 * Exported with an injectable clock so the suite drives it directly; production
 * calls it from the interval registered in init.
 */
export function checkpointOpenSpans(now: number = Date.now()): void {
  try {
    checkpointOpenSpansImpl(now);
  } catch (err) {
    swallow('checkpointOpenSpans', err);
  }
}

function checkpointOpenSpansImpl(now: number = Date.now()): void {
  if (!rt) return;
  // `nanoclaw.segment` is stamped in exactly two places, both HERE: on the span
  // being closed, and in the creation attributes of the one replacing it. The
  // close paths (`turnEnd`, `toolEnd`, subagent stop, `closeOpenSpans`) must NOT
  // re-stamp it: a write there would only rewrite the value the span was born
  // with.

  if (turnSpan && turnSeedAttrs && turnSegmentStartedAt !== null && now - turnSegmentStartedAt >= SEGMENT_AFTER_MS) {
    turnSpan.setAttribute('nanoclaw.segment', turnSegment);
    turnSpan.setAttribute('nanoclaw.segment_continues', true);
    turnSpan.end(now);
    turnSegment += 1;
    turnSegmentStartedAt = now;
    // Under the ANCHOR (segment 1), not under `turnParentCtx` and not under the
    // previous segment. Flat either way — every segment is a sibling hanging off
    // segment 1, so depth stays 1 no matter how long the turn runs, which is what
    // the "side by side, not a staircase" rule was after.
    //
    // `turnParentCtx` is wrong as the anchor for a ROOT turn: there it is
    // `undefined`, so each rotation would open a new root — a NEW TRACE. The work
    // stays anchored to segment 1 while `turnEnd` writes cost, tokens and
    // `output.value` onto the LAST segment, so a segmented turn would split into
    // one trace holding the spans and another holding what they cost. Every
    // backend joins on `trace_id`, so the fix belongs here, at emission.
    //
    // The fallback keeps turns that DO have a parent exactly as they were.
    turnSpan = rt.tracer.startSpan(
      'agent.turn',
      { startTime: now, attributes: { ...turnSeedAttrs, 'nanoclaw.segment': turnSegment } },
      turnAnchorCtx ?? turnParentCtx,
    );
  }

  for (const entry of toolSpans.values()) {
    if (now - entry.segmentStartedAt < SEGMENT_AFTER_MS) continue;
    entry.span.setAttribute('nanoclaw.segment', entry.segment);
    entry.span.setAttribute('nanoclaw.segment_continues', true);
    entry.span.end(now);
    entry.segment += 1;
    entry.segmentStartedAt = now;
    entry.span = rt.tracer.startSpan(
      `tool.${entry.name}`,
      { startTime: now, attributes: { ...entry.seedAttrs, 'nanoclaw.segment': entry.segment } },
      entry.parentCtx,
    );
  }

  for (const entry of subagentSpans.values()) {
    if (now - entry.segmentStartedAt < SEGMENT_AFTER_MS) continue;
    entry.span.setAttribute('nanoclaw.segment', entry.segment);
    entry.span.setAttribute('nanoclaw.segment_continues', true);
    entry.span.end(now);
    entry.segment += 1;
    entry.segmentStartedAt = now;
    entry.span = rt.tracer.startSpan(
      entry.name,
      { startTime: now, attributes: { ...entry.seedAttrs, 'nanoclaw.segment': entry.segment } },
      entry.parentCtx,
    );
    // `subagentCtxs` intact: worker tools keep anchoring to segment 1.
  }
}

/**
 * Stamps queue wait on the turn, from the batch already claimed.
 *
 * `turn_duration_ms` covers `query()` → `result`; everything before it — the
 * host sweep, container spawn, poll interval — was invisible, so a fast turn
 * answered minutes after the question looked identical to one answered at once.
 * This closes the user-perceived latency.
 *
 * Only available live: `markCompleted` overwrites `status_changed` as soon as the
 * turn ends, destroying the claim instant, so it cannot be recovered from the DB
 * afterwards.
 */
function applyInboundWait(attributes: Record<string, string | number | boolean>, claimed: InboundOrigin[]): void {
  // MAX of the batch, not the first row: `ORDER BY timestamp` is not due order (a
  // task armed early comes due late), and the question is how long the longest
  // waiter waited.
  let worst: { waitMs: number; claimedAtMs: number } | null = null;
  for (const m of claimed) {
    if (m.dueAtMs === null || m.claimedAtMs === null) continue;
    const waitMs = m.claimedAtMs - m.dueAtMs;
    if (!worst || waitMs > worst.waitMs) worst = { waitMs, claimedAtMs: m.claimedAtMs };
  }
  // ABSENT, not zero. With no claimed message (an `on_wake` turn, a continuation)
  // there is no wait to measure, and `0` would falsely claim there was none. The
  // deliberate opposite of `delivered_count`, where zero IS the finding.
  if (!worst) return;

  // A negative wait is impossible: `dueAtMs` is on the HOST clock and
  // `claimedAtMs` on the CONTAINER clock, so negative means the clocks disagree
  // (Docker's VM drifts after the host sleeps), not latency. Always clamp; flag
  // only beyond 1s, since sub-second negatives are ordinary noise and flagging
  // them would make the signal ignorable exactly when it matters.
  if (worst.waitMs < -1000) attributes['nanoclaw.inbound_clock_skew'] = true;
  attributes['nanoclaw.inbound_wait_ms'] = Math.max(0, worst.waitMs);
  // Same clock on both sides, so immune to the skew above — the control that says
  // whether an absurd `inbound_wait_ms` is a real queue or a lying clock.
  attributes['nanoclaw.runner_lag_ms'] = Math.max(0, Date.now() - worst.claimedAtMs);
}

/**
 * Opens the turn span, closing any pending turn (previous error/abort) first.
 *
 * Takes the whole `QueryInput`, not just the prompt: `continuation` separates a
 * fresh session from a resumed one, and the prompt carries who asked and why.
 */
export function turnStart(queryInput: unknown): void {
  try {
    turnStartImpl(queryInput);
  } catch (err) {
    swallow('turnStart', err);
  }
}

function turnStartImpl(queryInput: unknown): void {
  // A `query()` is a new `claude` process, and its running totals start from zero.
  processCostCursor = null;
  processApiCursor = null;
  if (!rt) return;

  if (turnSpan) {
    turnSpan.setStatus({ code: rt.errorStatus, message: 'turn replaced without a result' });
    applyTurnCounters(turnSpan);
    turnSpan.end();
  }

  const q = (queryInput ?? {}) as TurnInput;
  const prompt = typeof q.prompt === 'string' ? q.prompt : '';
  const origin = parsePromptOrigin(prompt);

  const attributes: Record<string, string | number | boolean> = {
    'openinference.span.kind': 'AGENT',
    'input.value': truncate(prompt),
    'input.mime_type': 'text/plain',
    // A resumed session re-reads accumulated context, which dominates token
    // usage. Without this flag the two populations blur together.
    'nanoclaw.resumed': Boolean(q.continuation),
  };
  if (origin.trigger) attributes['nanoclaw.trigger'] = origin.trigger;
  // Origin route: channel, group, or another agent. Always present, never
  // claiming to be a person.
  if (origin.source) attributes['nanoclaw.source'] = origin.source;
  if (origin.sourceCount > 1) attributes['nanoclaw.source_count'] = origin.sourceCount;
  // `user.id` is the convention Phoenix INDEXES, so per-user filtering comes for
  // free — which is exactly why only humans may go here: agent-to-agent traffic
  // would become a phantom person in the UI.
  if (origin.userId) attributes['user.id'] = origin.userId;

  // DISTRIBUTED TRACE. This turn's messages are already claimed (`markProcessing`
  // runs before `query()`), so we can read the `traceparent` the sending agent
  // stamped and hang this turn in its trace. "What did answering your question
  // cost" then includes, recursively, everything delegated.
  //
  // Reading here also CONSUMES the initial batch ids so the first continuation
  // window does not pick them up again: their `markCompleted` runs on the `result`
  // event, just after `turnEnd`, and would fall inside the next window.
  let parentCtx: Context | undefined;
  try {
    const claimed = readClaimedMessages({ pendingOnly: true });
    const tp = claimed.find((m) => m.traceparent)?.traceparent;
    if (tp) {
      parentCtx = rt.remoteContext(tp);
      if (parentCtx) attributes['nanoclaw.trace_linked'] = true;
    }
    // QUEUE LATENCY. Reuses the `claimed` array read above on purpose:
    // `readClaimedMessages` consumes `attributedIds`, so a second call returns
    // empty.
    //
    // AFTER the traceparent block, not before: this `try` swallows exceptions, and
    // a failure here must not cost the distributed trace its parent.
    applyInboundWait(attributes, claimed);
  } catch {
    /* no DB, or the read failed: root turn */
  }

  openTurn(attributes, undefined, parentCtx);
}

/**
 * Publishes the turn's W3C `traceparent` to `session_state`, where the MCP server
 * reads it when sending to another agent. That server runs in a SEPARATE PROCESS
 * and cannot see this span — hence a DB channel rather than a direct call.
 */
/** W3C `traceparent` for a span, or `null` when the span carries no usable ids. */
function buildTraceparent(span: Span): string | null {
  const sc = span.spanContext();
  if (!sc?.traceId || !sc?.spanId) return null;
  return `00-${sc.traceId}-${sc.spanId}-${(sc.traceFlags ?? 1).toString(16).padStart(2, '0')}`;
}

function publishTraceparent(): void {
  if (!rt || !turnSpan) return;
  // The anchor's ids, not the current segment's: a delegated agent stitches its
  // turn onto a span that the first checkpoint has already exported.
  const tp = buildTraceparent(turnAnchorSpan ?? turnSpan);
  if (!tp) return;
  // Kept in memory for the RUNNER's own delivery leg, which can read it directly.
  // Set here and cleared only by `resetTurnState`, so it outlives `turnEnd` — the
  // same lifetime as `detachedTurnCtx`, and for the same reason: a final result
  // delivered after the turn closed still belongs to that turn's trace.
  currentTraceparent = tp;
  if (!stateMod) return;
  try {
    stateMod.setTurnTraceparent(tp);
  } catch {
    /* no DB: the recipient opens a root turn */
  }
}

/**
 * THE single place per-turn state is cleared. Called by `openTurn` and by
 * `__testReset`.
 *
 * One site, not two, because two hand-maintained lists drift: a counter added to
 * `openTurn` but forgotten in `__testReset` leaks across tests, and the leak is
 * invisible — duration assertions are `toBeGreaterThan`, so an inflated value
 * still passes. A new per-turn counter belongs here and nowhere else.
 *
 * `turnIsContinuation` and `pendingCall` are deliberately absent: the first is
 * assigned right AFTER `openTurn` by `assistantStep`, and the second is cleared
 * by the `flushCall()` that runs before. Clearing either here would undo them.
 */
function resetTurnState(): void {
  turnSpan = null;
  turnStartedAt = null;
  // A new turn re-anchors: late spans stitch into it, not the previous one.
  detachedTurnCtx = null;
  // Same lifetime as `detachedTurnCtx`, for the same reason: the anchor keeps
  // serving post-turn background until the next turn replaces it.
  turnSeedAttrs = null;
  turnParentCtx = undefined;
  turnAnchorSpan = null;
  turnAnchorCtx = null;
  turnSegment = 1;
  turnSegmentStartedAt = null;
  pendingSignalAt = null;
  thinkingTokensBlock = 0;
  thinkingTokensTurn = 0;
  apiRetries = 0;
  lastRetryStatus = null;
  memoryRecalls = 0;
  deliveredCount = 0;
  toolCalls = 0;
  skillsUsed.clear();
  mcpServersUsed.clear();
  currentTraceparent = null;
  // Boundaries from the previous turn are stale for everyone.
  boundaries.clear();
}

/**
 * Opens the turn span and resets all per-turn state. Used by `turnStart`
 * (exchanges started by `query()`) and by CONTINUATION exchanges.
 */
function openTurn(
  attributes: Record<string, string | number | boolean>,
  startTime?: number,
  parentCtx?: Context,
): void {
  if (!rt) return;
  // HERE, not in `turnStart`: container age does not depend on an inbound message,
  // so it applies equally to continuation exchanges — which never pass through
  // `turnStart`, and which are the bulk of the traffic.
  attributes['nanoclaw.runner_uptime_ms'] = Date.now() - MODULE_LOADED_AT;
  // Same placement rule for the GenAI identity of the turn: a backend that reads
  // OTel GenAI (Langfuse, for one) classifies a turn by these, and a continuation
  // without them is a different kind of span to it. The seed copy below carries
  // them into every later segment.
  attributes['gen_ai.operation.name'] = 'invoke_agent';
  attributes['gen_ai.agent.name'] = agentName;
  // A pending call belongs to the turn that is leaving.
  flushCall();
  // BEFORE the assignments below, never after: this clears `turnSpan`,
  // `turnStartedAt` and `boundaries`, so running it later would wipe the turn
  // that was just opened.
  resetTurnState();
  turnStartedAt = startTime ?? Date.now();
  turnSpan = rt.tracer.startSpan('agent.turn', { attributes, startTime: turnStartedAt }, parentCtx);
  // Segmentation seeds: attributes captured AFTER the uptime stamp above, so a
  // reopened segment describes itself the same way the first one did.
  turnSeedAttrs = { ...attributes };
  turnParentCtx = parentCtx;
  turnAnchorSpan = turnSpan;
  turnAnchorCtx = rt.childContext(turnSpan);
  turnSegment = 1;
  turnSegmentStartedAt = turnStartedAt;
  boundaries.set(MAIN_CTX, turnStartedAt);
  // Publish the context for the MCP server, which runs in another process and
  // cannot see this span. This is what lets the recipient agent stitch its turn.
  publishTraceparent();
}

/**
 * Turn cost, derived from the process running total.
 *
 * `result.total_cost_usd` is a RUNNING total, not the turn's: within one
 * `query()` the poll loop pushes every later message into the same process, so
 * recording the raw number as turn cost sums counters, which overstates spend
 * and inverts the ranking: the "most expensive" turn is merely the last one of
 * a long process.
 *
 * The total is per PROCESS, and `turnStart` resets the cursor because that is
 * where a new process is born (see `processCostCursor`). So the first turn after
 * a `query()` pays `total` in full — exact, not a ceiling — and every later
 * exchange pays the difference.
 *
 * Two attributes: `nanoclaw.cost_usd` is this turn's cost; `nanoclaw.session_cost_usd`
 * is the raw running total, kept because it is what the SDK asserts. A drop in
 * the total with no `turnStart` in between should not happen; if it does, the
 * turn pays `total` and carries `nanoclaw.cost_cursor_reset` so the anomaly is
 * queryable instead of surfacing as a negative cost that vanishes in a sum.
 */
function recordCost(span: Span, total: number): void {
  span.setAttribute('nanoclaw.session_cost_usd', total);

  let previous = processCostCursor ?? 0;
  if (previous > total) {
    span.setAttribute('nanoclaw.cost_cursor_reset', true);
    previous = 0;
  }
  // Round: float subtraction yields 1.7000000000000002 and pollutes the sum.
  span.setAttribute('nanoclaw.cost_usd', Math.round((total - previous) * 1e6) / 1e6);
  processCostCursor = total;
}

/**
 * Turn API time — the exact analogue of `recordCost`, for the same reason:
 * `result.duration_api_ms` is a running total of the process, and written raw
 * it exceeds the turn's own wall clock, which API time cannot. Same pair of
 * attributes (`nanoclaw.duration_api_ms` for this turn, `session_duration_api_ms`
 * for the raw total) and the same `nanoclaw.api_cursor_reset` flag for a drop
 * with no `turnStart` in between.
 */
function recordApiDuration(span: Span, total: number): void {
  span.setAttribute('nanoclaw.session_duration_api_ms', total);

  let previous = processApiCursor ?? 0;
  if (previous > total) {
    span.setAttribute('nanoclaw.api_cursor_reset', true);
    previous = 0;
  }
  span.setAttribute('nanoclaw.duration_api_ms', total - previous);
  processApiCursor = total;
}

/**
 * Counters accumulated during the turn, written to the span being closed.
 *
 * A function rather than inline in `turnEnd` because THREE paths close a turn and
 * all three need them: the normal `turnEnd`, `shutdownTelemetry`, and the
 * `turnStart` that replaces a pending turn. Nested under `turnEnd`'s `if (m)`
 * they would depend on a `result` message arriving and vanish on the other two.
 */
function applyTurnCounters(span: Span): void {
  // How much the whole turn spent thinking. Otherwise reasoning cost dissolves
  // into the total and disappears.
  if (thinkingTokensTurn > 0) span.setAttribute('nanoclaw.thinking_tokens_est', thinkingTokensTurn);
  // Retries and recalls cost latency and context silently; as turn counters they
  // surface without a span each.
  if (apiRetries > 0) {
    span.setAttribute('nanoclaw.api_retries', apiRetries);
    if (lastRetryStatus !== null) span.setAttribute('nanoclaw.last_retry_status', lastRetryStatus);
  }
  if (memoryRecalls > 0) span.setAttribute('nanoclaw.memory_recalls', memoryRecalls);
  // Always written, zero included: an absent attribute cannot distinguish "did
  // not deliver" from "turn predates the instrument", and zero is the value worth
  // searching for.
  span.setAttribute('nanoclaw.delivered_count', deliveredCount);
  // Always written, zero included — same reason as above, and it doubles as the
  // marker that this turn was measured by an instrumented runner at all. A turn
  // with `tool_calls` and no `skills_used` used no skill; a turn without
  // `tool_calls` predates this instrument and asserts nothing either way.
  span.setAttribute('nanoclaw.tool_calls', toolCalls);
  // Sorted, so the same combination is the same string and groups as one value.
  // Truncated like any other list attribute: a turn that fanned out over many
  // skills must not push the span toward the size where the exporter starts
  // dropping attributes.
  if (skillsUsed.size > 0) {
    span.setAttribute('nanoclaw.skills_used', truncate([...skillsUsed].sort().join(',')));
  }
  if (mcpServersUsed.size > 0) {
    span.setAttribute('nanoclaw.mcp_servers_used', truncate([...mcpServersUsed].sort().join(',')));
  }
}

function turnEnd(text: string | null, resultMessage?: unknown): void {
  if (!rt) return;
  // The turn's last call closes BEFORE the turn, so the child does not outlive
  // its parent.
  flushCall();
  if (!turnSpan) return;

  const span = turnSpan;
  turnSpan = null;

  // CONTINUATION ORIGIN. A prompt pushed via `query.push()` never reaches
  // telemetry — the `user` messages in the stream are echoes of `tool_result` —
  // so the question comes from `inbound.db`. Done in `turnEnd` rather than at open
  // because by then the `processing_ack` marks exist, with no race.
  if (turnIsContinuation) {
    let outcome = 'miss';
    try {
      const msgs =
        continuationWindowStartMs !== null ? readClaimedMessages({ sinceMs: continuationWindowStartMs }) : [];
      if (msgs.length > 0) {
        outcome = 'hit';
        const texts = msgs.map((m) => m.text).filter(Boolean);
        if (texts.length > 0) {
          span.setAttribute('input.value', truncate(texts.join('\n')));
          span.setAttribute('input.mime_type', 'text/plain');
        }
        const trigger = triggerFromKinds(msgs.map((m) => m.kind));
        if (trigger) span.setAttribute('nanoclaw.trigger', trigger);
        const human = msgs.find((m) => m.senderName)?.senderName;
        if (human) span.setAttribute('user.id', human);
        if (msgs.length > 1) span.setAttribute('nanoclaw.source_count', msgs.length);
        // QUEUE LATENCY for a continuation, measured from the turn's own start
        // rather than from a claim instant, because the claim instant does not
        // survive long enough to read.
        //
        // On a `turnStart` turn `inbound_wait_ms` is `claim − due`, read while
        // `processing_ack` still says `processing`. A continuation can never see
        // that row: `poll-loop.ts` calls `markCompleted` on the SAME TICK as
        // `query.push()`, and the initial batch is completed at the first
        // `result` — so by the time the exchange's first assistant message
        // arrives, every row says `completed` and `status_changed` has been
        // overwritten with the completion instant, so a claim-based reading
        // yields nothing.
        //
        // `turnStartedAt − due` measures the same thing to within the push→first
        // signal gap, because that same simultaneity is what makes the claim
        // unreadable: the push, the completion and the start of model work all
        // happen together. It reads slightly HIGH by that gap, and it is the
        // honest number available — the alternative was an attribute that never
        // appeared.
        //
        // MAX of the batch, matching `applyInboundWait`: `ORDER BY timestamp` is
        // not due order, and the question is how long the longest waiter waited.
        //
        // No `runner_lag_ms` here. On a `turnStart` turn it is the single-clock
        // control for `inbound_wait_ms` (claim to turn open); its analogue here
        // would be `now − turnStartedAt`, which is just the turn's own duration
        // and controls nothing.
        if (turnStartedAt !== null) {
          let worstWait: number | null = null;
          for (const msg of msgs) {
            if (msg.dueAtMs === null) continue;
            const wait = turnStartedAt - msg.dueAtMs;
            if (worstWait === null || wait > worstWait) worstWait = wait;
          }
          if (worstWait !== null) {
            // Negative means the host and container clocks disagree, not negative
            // latency — same clamp and same 1s threshold as `applyInboundWait`.
            if (worstWait < -1000) span.setAttribute('nanoclaw.inbound_clock_skew', true);
            span.setAttribute('nanoclaw.inbound_wait_ms', Math.max(0, worstWait));
          }
        }
      }
    } catch {
      outcome = 'error';
    }
    // Explicit outcome: a missing origin becomes a queryable diagnostic, not a bug.
    span.setAttribute('nanoclaw.origin_lookup', outcome);
    // A miss is still a trigger, and it has two causes: the runner's wrap-nudge
    // (the previous turn ended in `dropped`) and the
    // SDK resuming on its own — a Monitor event, a background task settling.
    // Labelled here so a continuation never ships with no trigger at all, and
    // so the cost of nudging becomes a `GROUP BY`.
    if (outcome === 'miss') span.setAttribute('nanoclaw.trigger', nudgePending ? 'nudge' : 'background');
  }
  turnIsContinuation = false;
  nudgePending = false;
  // `turnStartedAt` is deliberately NOT cleared here: detached spans hang on this
  // turn, so its start remains the correct floor for `pointSpan`'s clamp. Clearing
  // it would disable the negative-offset guard on exactly that path. The next
  // `turnStart` replaces it.
  //
  // The context outlives the span: post-turn background spans hang on it and stay
  // in the same trace without extending the turn's duration. The ANCHOR, not the
  // final segment, so late spans reference an already-exported parent.
  detachedTurnCtx = turnAnchorCtx ?? rt.childContext(span);

  if (text) {
    span.setAttribute('output.value', truncate(text));
    span.setAttribute('output.mime_type', 'text/plain');
    // The agent wrote only scratchpad. The poll loop blanks `<internal>` before
    // deciding whether to nudge, so this turn produces neither a delivery nor a
    // `delivery.dropped` — indistinguishable from a lost answer. As an attribute
    // it is what it is: the agent chose to stay silent.
    if (text.replace(INTERNAL_SPAN_RE, '').trim() === '') span.setAttribute('nanoclaw.output_internal_only', true);
  }

  const m = resultMessage as
    | {
        is_error?: boolean;
        subtype?: string;
        num_turns?: number;
        duration_ms?: number;
        duration_api_ms?: number;
        total_cost_usd?: number;
        usage?: TokenUsage;
        modelUsage?: Record<string, { costUSD?: number }>;
        permission_denials?: unknown[];
      }
    | undefined;

  if (m) {
    if (m.usage) setTurnTokenAttrs(span, m.usage);
    // `modelUsage` is broken down per model; the costliest one answers for the
    // turn. Without it there is no explaining why a turn came out expensive.
    //
    // `nanoclaw.model`, NOT `llm.model_name`, for the same reason
    // `setTurnTokenAttrs` keeps the turn's tokens out of the vendor namespace.
    // A model name is what a cost engine needs to pick a TOKENIZER: Langfuse reads
    // this attribute, tokenizes the turn's own `input.value`/`output.value`, and
    // bills the turn ON TOP of the same consumption it already billed the turn's
    // children — the attribute is the whole gate. Phoenix is unaffected either
    // way (its cost engine only prices spans of kind LLM, and a turn is AGENT),
    // so the vendor namespace buys nothing here.
    //
    // `llm.model_name` stays on `llm.call`, where it is correct and where the
    // token counts it prices are the real ones.
    const models = Object.entries(m.modelUsage ?? {});
    if (models.length > 0) {
      const top = models.reduce((a, b) => ((b[1]?.costUSD ?? 0) > (a[1]?.costUSD ?? 0) ? b : a));
      span.setAttribute('nanoclaw.model', top[0]);
    }
    if (typeof m.total_cost_usd === 'number') recordCost(span, m.total_cost_usd);
    // Duration MEASURED by the SDK, against the one inferred from the span clock.
    //
    // The two diverge on continuation exchanges: a span born at the first
    // assistant message excludes every millisecond before it. `pendingSignalAt`
    // is armed by ANY pre-assistant message, so the span is CREATED at the
    // earliest instant the SDK reveals. That is a different thing from
    // backdating, which stays impossible: `startTime` is fixed once the span
    // exists, and creating the turn only in `turnEnd` would break the parenting
    // of children that already point at it.
    //
    // A gap remains where the SDK emits nothing at all before the first assistant
    // message, so the rule stands — the span serves STRUCTURE and these
    // attributes serve MEASUREMENT. For
    // turn-duration analysis use `nanoclaw.turn_duration_ms`; the span duration is
    // a floor, not a value.
    if (typeof m.duration_ms === 'number') span.setAttribute('nanoclaw.turn_duration_ms', m.duration_ms);
    if (typeof m.duration_api_ms === 'number') recordApiDuration(span, m.duration_api_ms);
    // Auto-denied calls — the path that does NOT go through the PreToolUse hook.
    if (Array.isArray(m.permission_denials) && m.permission_denials.length > 0) {
      span.setAttribute('nanoclaw.permission_denials', m.permission_denials.length);
    }
    if (typeof m.num_turns === 'number') span.setAttribute('nanoclaw.num_turns', m.num_turns);
    if (typeof m.subtype === 'string') span.setAttribute('nanoclaw.result_subtype', m.subtype);
    if (m.is_error) {
      span.setStatus({ code: rt.errorStatus, message: text ?? 'turn ended in error' });
      span.setAttribute('nanoclaw.failure_kind', classifyFailure(`${m.subtype ?? ''} ${text ?? ''}`, null, false));
    }
  }

  // OUTSIDE `if (m)`: the counters are module state and do not depend on the
  // `result` message. Nested inside, a turn closing without a result lost all
  // four — exactly the interrupted turn worth inspecting.
  applyTurnCounters(span);

  span.end();
  // The next continuation's window opens where THIS turn opened — see the
  // declaration. `turnStartedAt` is still this turn's start here.
  continuationWindowStartMs = turnStartedAt;
  // Turn closed: a late send must not attach itself to it.
  try {
    stateMod?.setTurnTraceparent(null);
  } catch {
    /* best-effort */
  }
}

/**
 * The `thinking` option for `sdkQuery`, decided per group.
 *
 * By default Claude Code resolves `display` to `omitted`: reasoning blocks arrive
 * empty and only the token estimate survives. With `"thinkingText": true` in the
 * group's `otel.json` we request `summarized`, the API's own default, and
 * `assistantStep` starts finding text in `b.thinking` with no other change.
 *
 * Returns an OBJECT TO SPREAD, not `thinking: undefined`. Spreading `{}` adds no
 * key, which guarantees a group without the opt-in sends exactly today's request;
 * `{ thinking: undefined }` would rely on the SDK treating absent and undefined
 * alike, which is promised nowhere.
 *
 * `type: 'adaptive'` preserves the behavior where the model decides how much to
 * think; it fixes no token budget.
 */
export function thinkingOption(): { thinking?: { type: 'adaptive'; display: 'summarized' } } {
  try {
    return thinkingOptionImpl();
  } catch (err) {
    swallow('thinkingOption', err);
    return {};
  }
}

function thinkingOptionImpl(): { thinking?: { type: 'adaptive'; display: 'summarized' } } {
  if (!fileConfig?.thinkingText) return {};
  return { thinking: { type: 'adaptive', display: 'summarized' } };
}

/**
 * THE single entry point for the SDK message stream.
 *
 * `claude.ts` forwards every message here in one line rather than calling
 * telemetry from each interesting branch. That keeps the production footprint
 * minimal AND the reach complete: a new SDK message type becomes observable by
 * editing only this file, which is ours and never conflicts on update.
 */
export function observe(message: unknown): void {
  try {
    observeImpl(message);
  } catch (err) {
    swallow('observe', err);
  }
}

function observeImpl(message: unknown): void {
  if (!rt) return;

  const m = (message ?? {}) as { type?: string; subtype?: string; parent_tool_use_id?: string | null };

  // EARLIEST SIGN that a continuation exchange is under way, and deliberately
  // HERE — in the funnel, before the dispatch — rather than in one branch of the
  // switch below. Armed by `thinking_tokens` alone, a turn without extended
  // thinking has no early signal at all and is born at its first assistant
  // message, excluding all the model latency before it — and most turns think
  // nothing.
  //
  // Only the signals in `CONTINUATION_SIGNALS`, and only from the main thread:
  // a worker's messages carry `parent_tool_use_id` and belong to the previous
  // turn's background, as does a task settling. `assistant` is excluded because
  // that message is the one that OPENS the turn: arming on it would just be
  // `Date.now()` under another name, and would hide from `assistantStep` the
  // fact that no earlier signal arrived — which is what it uses to decide
  // whether the claim instant is worth reading.
  if (
    !turnSpan &&
    pendingSignalAt === null &&
    m.type === 'system' &&
    typeof m.subtype === 'string' &&
    CONTINUATION_SIGNALS.has(m.subtype) &&
    !m.parent_tool_use_id
  ) {
    pendingSignalAt = Date.now();
  }

  if (m.type === 'assistant') return assistantStep(message);
  if (m.type === 'result') return turnEnd(resultText(message), message);
  // `user` is always an echo of `tool_result` — it carries no prompt, so there is
  // nothing to observe.
  if (m.type === 'rate_limit_event') {
    // `claude.ts` already acts on this; here we only mark the case that hurts.
    // 'allowed' is routine — the SDK emits it on every headroom change — and would
    // be noise.
    const r = (message as { rate_limit_info?: { status?: string } }).rate_limit_info;
    if (r?.status && r.status !== 'allowed' && turnSpan) {
      turnSpan.setAttribute('nanoclaw.rate_limit_status', r.status);
    }
    return;
  }
  if (m.type !== 'system') return;

  switch (m.subtype) {
    case 'thinking_tokens': {
      const t = message as { estimated_tokens?: number; estimated_tokens_delta?: number };
      if (typeof t.estimated_tokens === 'number') thinkingTokensBlock = t.estimated_tokens;
      if (typeof t.estimated_tokens_delta === 'number') thinkingTokensTurn += t.estimated_tokens_delta;
      // The continuation start is armed at the top of `observe`, which covers
      // this message along with every other pre-assistant signal. Do not arm it
      // here too: a second arming would be a no-op (the funnel already ran) and
      // would suggest this branch is special.
      return;
    }
    case 'compact_boundary': {
      // The most informative event in the stream: compaction is the ONLY thing
      // that shrinks context, and re-read context dominates token usage.
      const c = (message as { compact_metadata?: Record<string, unknown> }).compact_metadata ?? {};
      const pre = typeof c.pre_tokens === 'number' ? c.pre_tokens : null;
      const post = typeof c.post_tokens === 'number' ? c.post_tokens : null;
      const attrs: Record<string, string | number | boolean> = {
        'openinference.span.kind': 'CHAIN',
        'nanoclaw.compact_trigger': String(c.trigger ?? 'unknown'),
      };
      if (pre !== null) attrs['nanoclaw.compact_pre_tokens'] = pre;
      if (post !== null) attrs['nanoclaw.compact_post_tokens'] = post;
      if (pre !== null && post !== null) attrs['nanoclaw.compact_tokens_saved'] = pre - post;
      pointSpan('agent.compact', attrs, { durationMs: typeof c.duration_ms === 'number' ? c.duration_ms : undefined });
      return;
    }
    case 'task_notification': {
      // Background work settling — exactly what outlives the turn and would
      // otherwise produce parentless spans.
      const t = message as {
        task_id?: string;
        tool_use_id?: string;
        status?: string;
        summary?: string;
        usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
      };
      const attrs: Record<string, string | number | boolean> = { 'openinference.span.kind': 'CHAIN' };
      if (t.task_id) attrs['nanoclaw.task_id'] = t.task_id;
      if (t.tool_use_id) attrs['nanoclaw.parent_tool_use_id'] = t.tool_use_id;
      if (t.summary) attrs['output.value'] = truncate(t.summary);
      if (typeof t.usage?.total_tokens === 'number') attrs['llm.token_count.total'] = t.usage.total_tokens;
      if (typeof t.usage?.tool_uses === 'number') attrs['nanoclaw.task_tool_uses'] = t.usage.tool_uses;
      // The SDK reports how long the task ran; backdating with it makes the span
      // cover the task's real window, the same way `agent.compact` does above.
      pointSpan(`task.${t.status ?? 'settled'}`, attrs, {
        durationMs: typeof t.usage?.duration_ms === 'number' ? t.usage.duration_ms : undefined,
      });
      return;
    }
    case 'permission_denied': {
      const d = message as {
        tool_name?: string;
        tool_use_id?: string;
        agent_id?: string;
        decision_reason_type?: string;
        reason?: string;
      };
      const attrs: Record<string, string> = {
        'openinference.span.kind': 'TOOL',
        'tool.name': d.tool_name ?? 'unknown',
      };
      if (d.decision_reason_type) attrs['nanoclaw.denial_reason_type'] = d.decision_reason_type;
      if (d.reason) attrs['nanoclaw.denial_reason'] = truncate(d.reason);
      if (d.agent_id) attrs['nanoclaw.agent_id'] = d.agent_id;
      pointSpan('permission.denied', attrs);
      return;
    }
    case 'api_retry': {
      const r = message as { error_status?: number | null };
      apiRetries += 1;
      if (typeof r.error_status === 'number') lastRetryStatus = r.error_status;
      return;
    }
    case 'memory_recall': {
      memoryRecalls += 1;
      return;
    }
    default:
      return;
  }
}

/**
 * Subagent lifecycle. One callback serves `SubagentStart` and `SubagentStop`,
 * distinguished by `hook_event_name` as with PostToolUse/PostToolUseFailure.
 * Keyed by `agent_id`, so parallel subagents do not collide.
 *
 * Typed `unknown` on purpose: keeps telemetry decoupled from the SDK while
 * staying assignable to `HookCallback`.
 */
export async function subagentHook(input: unknown): Promise<{ continue: true }> {
  try {
    await subagentHookImpl(input);
  } catch (err) {
    swallow('subagentHook', err);
  }
  return { continue: true };
}

async function subagentHookImpl(input: unknown): Promise<{ continue: true }> {
  if (!rt) return { continue: true };

  const h = (input ?? {}) as {
    hook_event_name?: string;
    agent_id?: string;
    agent_type?: string;
    session_id?: string;
    last_assistant_message?: string;
  };
  const id = h.agent_id;
  if (!id) return { continue: true };

  if (h.hook_event_name === 'SubagentStart') {
    const attrs: Record<string, string> = {
      'openinference.span.kind': 'AGENT',
      'nanoclaw.agent_id': id,
    };
    if (h.agent_type) attrs['nanoclaw.agent_type'] = h.agent_type;
    if (h.session_id) attrs['session.id'] = h.session_id;
    const { ctx, detached } = parentContext();
    const name = `subagent.${h.agent_type || 'unknown'}`;
    const span = rt.tracer.startSpan(name, { attributes: attrs }, ctx);
    if (detached) span.setAttribute('nanoclaw.detached_from_turn', true);
    const seedAttrs: Record<string, string | number | boolean> = { ...attrs };
    if (detached) seedAttrs['nanoclaw.detached_from_turn'] = true;
    subagentSpans.set(id, { span, name, seedAttrs, parentCtx: ctx, segment: 1, segmentStartedAt: Date.now() });
    // Worker tools hang on this context via `agent_id` (see toolStart).
    // Deliberately NOT updated on segmentation: segment 1 is the anchor.
    subagentCtxs.set(id, rt.childContext(span));
  } else {
    const entry = subagentSpans.get(id);
    if (!entry) return { continue: true };
    subagentSpans.delete(id);
    subagentCtxs.delete(id);
    if (h.last_assistant_message) entry.span.setAttribute('output.value', truncate(h.last_assistant_message));
    entry.span.end();
  }
  return { continue: true };
}

/**
 * First sign the model resumed work with no open turn — used as the continuation
 * exchange's start. Without it the turn would begin only at the first assistant
 * message, excluding the model latency up to that point.
 */
let pendingSignalAt: number | null = null;
/**
 * Oldest signal a continuation may anchor to. Nothing clears `pendingSignalAt`
 * between `turnEnd` and the next `openTurn`, so a signal that arms it and is
 * then followed by a long silence would open the next exchange in the past,
 * inflating its duration and reading as a negative queue wait. Past this age the
 * anchor is discarded and the exchange starts at its first assistant message.
 */
const SIGNAL_MAX_AGE_MS = 5 * 60_000;
/**
 * System messages that precede the model's reply on the main thread and may
 * therefore arm the continuation anchor: thinking, an API retry, a compaction,
 * a memory recall, a status change such as `compacting`. Everything else that
 * arrives with no open turn is background — a task settling, a worker's tool
 * echo, a rate-limit notice — and none of it says "the next exchange has started".
 */
const CONTINUATION_SIGNALS = new Set(['thinking_tokens', 'api_retry', 'compact_boundary', 'memory_recall', 'status']);
/**
 * The in-flight model call, accumulating the assistant messages that belong to it.
 *
 * The SDK slices ONE API response into several messages — one per block
 * (thinking, text, each tool_use). A span per message inflated the step count and,
 * worse, wrote the whole call's `usage` onto each span, so summing children
 * overstated the turn's tokens and Phoenix's native rollup inherited the inflated
 * number.
 *
 * Grouping key is the identity of `usage`. The obvious anchors do not exist:
 * `BetaMessage` has no `id`, `SDKAssistantMessage.uuid` is per message rather than
 * per call, and `stop_reason` arrives absent. `usage` is what was left — and what
 * was repeating.
 *
 * Accepted risk: two consecutive calls with byte-identical `usage` would merge.
 * `cache_read` varies per call, so this is unlikely.
 */
interface PendingCall {
  span: Span;
  usageKey: string;
  ctxKey: string;
  kinds: string[];
  texts: string[];
  thinkings: string[];
  toolCalls: string[];
  thinkingTokens: number;
  stopReason: string | null;
  lastAt: number;
}
let pendingCall: PendingCall | null = null;
/** Was the open turn born from a continuation (no visible prompt)? */
let turnIsContinuation = false;
/**
 * When the PREVIOUS turn opened — start of the correlation window for a
 * continuation's origin.
 *
 * The turn's start, not its end: the poll loop claims and pushes a message that
 * arrives WHILE a turn is running, and that message is the next exchange's
 * origin. A window opening at the previous turn's end missed every such
 * message. Widening it is safe because `attributedIds` already holds the batch
 * the previous turn consumed, so nothing is attributed twice.
 */
let continuationWindowStartMs: number | null = null;
/**
 * The runner's wrap-nudge is pending: `dropped()` fired after the last turn, so
 * the poll loop pushed its own prompt and the next continuation exchange is the
 * model answering the RUNNER, not a message. Set by `dropped`, consumed by the
 * next `turnEnd`. Deliberately NOT cleared in `resetTurnState`: `dropped()` runs
 * after the previous turn closed and before the next one opens, so the flag has
 * to survive that reset.
 */
let nudgePending = false;

/**
 * Call identity.
 *
 * With no `usage` — or a `usage` with no fields — there is no identity, and each
 * message becomes its own call. Deliberate: merging on absent data would group
 * unrelated messages, which is worse than not grouping.
 */
let noUsageSeq = 0;
function usageIdentity(usage: TokenUsage | undefined): string {
  const fields = [
    usage?.input_tokens,
    usage?.output_tokens,
    usage?.cache_read_input_tokens,
    usage?.cache_creation_input_tokens,
  ];
  if (fields.every((f) => typeof f !== 'number')) return `no-usage:${(noUsageSeq += 1)}`;
  return JSON.stringify(fields.map((f) => f ?? null));
}

/** Closes the in-flight call, consolidating the accumulated blocks into one span. */
function flushCall(): void {
  const call = pendingCall;
  if (!call) return;
  pendingCall = null;

  const { span } = call;
  if (call.kinds.length > 0) span.setAttribute('nanoclaw.block_kinds', call.kinds.join(','));
  if (call.texts.length > 0) {
    span.setAttribute('output.value', truncate(call.texts.join('')));
    span.setAttribute('output.mime_type', 'text/plain');
  }
  if (call.thinkings.length > 0) span.setAttribute('nanoclaw.thinking', truncate(call.thinkings.join('\n')));
  // Without `thinkingText` on the group the block arrives empty
  // (`display: omitted`), leaving the estimate as the only measure of HOW MUCH
  // the model thought.
  if (call.thinkingTokens > 0) span.setAttribute('nanoclaw.thinking_tokens_est', call.thinkingTokens);
  // Every tool chosen in THIS call. Parallel calls then read as one decision with
  // N tools, which is what actually happened. `tool_names` is the list and
  // `tool_call_count` the number; `nanoclaw.tool_calls` is the TURN's count
  // (`applyTurnCounters`) and stays an integer everywhere — one key, one type,
  // or a typed store coerces the column.
  if (call.toolCalls.length > 0) {
    span.setAttribute('nanoclaw.tool_names', call.toolCalls.join(','));
    span.setAttribute('nanoclaw.tool_call_count', call.toolCalls.length);
  }
  if (call.stopReason) span.setAttribute('nanoclaw.stop_reason', call.stopReason);

  span.end(call.lastAt);
  // NEVER backward. The boundary means "end of the last known activity in this
  // context", and a tool that ran after this call's last message IS later
  // activity. Overwriting with `lastAt` would discard the advance `toolEnd` has
  // already made — `assistantStep` flushes before reading the boundary, so the
  // next call would start before the tool had finished and charge tool time as
  // model time.
  boundaries.set(call.ctxKey, Math.max(boundaries.get(call.ctxKey) ?? 0, call.lastAt));
}

/**
 * The same extraction `claude.ts` does for delivery: result text exists only on
 * `subtype:"success"`; error subtypes carry their message in `errors[]`.
 */
function resultText(message: unknown): string | null {
  const m = (message ?? {}) as { result?: string; errors?: string[] };
  return m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
}

/**
 * Emits the span for ONE step of the agent loop — a single assistant message.
 *
 * The missing layer between the turn and its tools. Without it you can see THAT
 * the agent called `Bash` many times but not WHY it decided to: the reasoning
 * arrives in `thinking` blocks that `claude.ts` drops when filtering for `text`.
 *
 * It is also what engages Phoenix's cost engine, which only computes over spans
 * of kind LLM.
 */
function assistantStep(message: unknown): void {
  if (!rt) return;

  const a = (message ?? {}) as AssistantMessage;
  const inner = a.message;
  if (!inner) return;

  // CONTINUATION EXCHANGE. `agent.turn` is born in `query()`, but the poll-loop
  // pushes later messages into the live call (`query.push()` does not end the
  // in-flight turn). Without this, from the second exchange on there is no open
  // span and its `result` cost is discarded — the more fluid the conversation, the
  // more was lost.
  //
  // The anchor is the first assistant message on the MAIN THREAD with no open
  // turn. Worker steps (`parent_tool_use_id`) do not qualify: they are background
  // of the previous turn, not a new exchange.
  //
  // No `input.value`, `trigger` or `user.id` on purpose — a pushed prompt never
  // reaches telemetry, since the `user` messages in the stream are echoes of
  // `tool_result`. `nanoclaw.continuation` marks this so the missing origin
  // attributes read as intentional rather than as a bug.
  if (!turnSpan && !a.parent_tool_use_id) {
    // Which instant the exchange starts at, and why — `nanoclaw.continuation_anchor`
    // makes a stale anchor a query instead of an inflated duration.
    const now = Date.now();
    let startAt = now;
    let anchor: 'signal' | 'stale_signal' | 'assistant' = 'assistant';
    if (pendingSignalAt !== null) {
      if (now - pendingSignalAt <= SIGNAL_MAX_AGE_MS) {
        startAt = pendingSignalAt;
        anchor = 'signal';
      } else {
        anchor = 'stale_signal';
      }
    }
    openTurn(
      { 'openinference.span.kind': 'AGENT', 'nanoclaw.continuation': true, 'nanoclaw.continuation_anchor': anchor },
      startAt,
    );
    turnIsContinuation = true;
  }

  const blocks = Array.isArray(inner.content) ? inner.content : [];
  const kinds = blocks.map((b) => b?.type || 'unknown');
  const text = blocks
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text ?? '')
    .join('');
  const thinking = blocks
    .filter((b) => b?.type === 'thinking' && b.thinking)
    .map((b) => b.thinking ?? '')
    .join('\n');
  const toolCalls = blocks.filter((b) => b?.type === 'tool_use' && b.name).map((b) => b.name ?? '');

  const now = Date.now();
  const ctxKey = a.parent_tool_use_id ?? MAIN_CTX;
  const usageKey = usageIdentity(inner.usage);

  // Same model call? Accumulate instead of opening a new span. See `PendingCall`.
  if (pendingCall && pendingCall.usageKey === usageKey && pendingCall.ctxKey === ctxKey) {
    pendingCall.kinds.push(...kinds);
    if (text) pendingCall.texts.push(text);
    if (thinking) pendingCall.thinkings.push(thinking);
    pendingCall.toolCalls.push(...toolCalls);
    if (inner.stop_reason) pendingCall.stopReason = inner.stop_reason;
    if (kinds.includes('thinking') && thinkingTokensBlock > 0) {
      pendingCall.thinkingTokens = thinkingTokensBlock;
      thinkingTokensBlock = 0;
    }
    pendingCall.lastAt = now;
    return;
  }

  // Different call: close the previous one before opening the next.
  flushCall();

  // A subagent worker step: `parent_tool_use_id` is the `Agent` call that spawned
  // it, still open in `toolSpans` (the tool ends only when the subagent does), so
  // the step hangs there rather than loose under the turn.
  const agentTool = a.parent_tool_use_id ? toolSpans.get(a.parent_tool_use_id) : undefined;
  const { ctx: turnCtx, detached } = parentContext();

  // OpenInference (what Phoenix indexes) IN ADDITION to OpenTelemetry's GenAI
  // semantic conventions, where the industry is converging. Emitting both costs
  // attributes and makes replacing Phoenix possible without reinstrumenting.
  const attributes: Record<string, string> = {
    'openinference.span.kind': 'LLM',
    'llm.provider': llmProvider,
    'llm.system': llmProvider,
    'gen_ai.system': llmProvider,
    'gen_ai.operation.name': 'chat',
  };
  if (inner.model) {
    attributes['llm.model_name'] = inner.model;
    attributes['gen_ai.request.model'] = inner.model;
    attributes['gen_ai.response.model'] = inner.model;
  }
  if (a.session_id) attributes['session.id'] = a.session_id;
  // Present when the step came from a subagent — this is what links the worker's
  // reasoning to the `Agent` tool that spawned it.
  if (a.parent_tool_use_id) attributes['nanoclaw.parent_tool_use_id'] = a.parent_tool_use_id;
  if (a.subagent_type) attributes['nanoclaw.agent_type'] = a.subagent_type;

  // Boundary of THIS step's context, never a shared global.
  //
  // A worker's first step has no boundary of its own yet and is seeded from the
  // `Agent` tool's start, which overstates it by the subagent spawn time. The
  // exact seed would be `SubagentStart`, but that carries only `agent_id` while
  // the boundary is keyed by `parent_tool_use_id`, and the SDK does not link the
  // two.
  //
  // The same missing link leaves a KNOWN GAP on the worker path: a worker's tools
  // key their boundary by `agent_id`, which nothing here reads, so a worker's
  // `llm.call` still absorbs the time its own tools spent, which is most of a
  // worker's "model time". The main thread does not have this problem — there
  // both sides key on MAIN_CTX.
  //
  // Bridging by heuristic ("attribute an agent_id to the only open `Agent` tool")
  // is rejected: `Agent` tools routinely run overlapping one another, so the
  // guess would be wrong most of the time, and a wrong number is worse than a
  // missing one.
  const startTime = boundaries.get(ctxKey) ?? agentTool?.startedAt ?? now;

  const span = rt.tracer.startSpan(
    'llm.call',
    // CLIENT: an outbound call to a remote service. Generic OTel backends
    // separate CLIENT from INTERNAL in their views; Phoenix reads
    // `openinference.span.kind` instead and ignores this.
    { startTime, attributes, kind: rt.clientKind },
    // The Agent tool's ANCHOR (first segment), not its current segment — same
    // crash-safety rule as `parentContext`.
    agentTool ? agentTool.anchorCtx : turnCtx,
  );
  if (!agentTool && detached) span.setAttribute('nanoclaw.detached_from_turn', true);
  // `usage` ONCE per call. Writing it per message multiplies the token counts.
  if (inner.usage) setCallTokenAttrs(span, inner.usage);

  let thinkingTokens = 0;
  if (kinds.includes('thinking') && thinkingTokensBlock > 0) {
    thinkingTokens = thinkingTokensBlock;
    thinkingTokensBlock = 0;
  }

  pendingCall = {
    span,
    usageKey,
    ctxKey,
    kinds: [...kinds],
    texts: text ? [text] : [],
    thinkings: thinking ? [thinking] : [],
    toolCalls: [...toolCalls],
    thinkingTokens,
    stopReason: inner.stop_reason ?? null,
    lastAt: now,
  };

  if (a.session_id) currentSessionId = a.session_id;
  if (turnSpan && a.session_id) turnSpan.setAttribute('session.id', a.session_id);
}

/**
 * Stamps `session.id` / `prompt.id` on the open turn. `turnStart` runs inside
 * `query()`, before any hook, and `RunnerConfig` does not carry those ids — so the
 * turn's first tool is the first chance to learn them. Rewriting the same value on
 * every tool is cheap and avoids tracking "already stamped".
 *
 * The write goes to the SEED as well, and that second write is what keeps
 * segmented turns identifiable: `checkpointOpenSpans` rebuilds the next segment
 * from `turnSeedAttrs` alone, and the seed is a snapshot taken in `openTurn`,
 * BEFORE any hook could supply these ids. Stamping only the span leaves every
 * segment past the first anonymous unless it happens to run a tool of its own,
 * invisible to any dashboard that filters by attribute. The seed is a copy, so
 * writing here never
 * rewrites the segment already born from it.
 */
function correlateTurn(h: ToolHookInput): void {
  if (h.session_id) currentSessionId = h.session_id;
  if (!turnSpan) return;
  if (h.session_id) {
    turnSpan.setAttribute('session.id', h.session_id);
    if (turnSeedAttrs) turnSeedAttrs['session.id'] = h.session_id;
  }
  if (h.prompt_id) {
    turnSpan.setAttribute('prompt.id', h.prompt_id);
    if (turnSeedAttrs) turnSeedAttrs['prompt.id'] = h.prompt_id;
  }
}

/**
 * Opens a tool span from the raw `PreToolUse` hook input, child of the open turn
 * when there is one. Takes the whole input (rather than name + args) because
 * pairing needs `tool_use_id` and correlation needs `session_id`/`prompt_id` — all
 * in the same object.
 */
export function toolStart(hookInput: unknown): void {
  try {
    toolStartImpl(hookInput);
  } catch (err) {
    swallow('toolStart', err);
  }
}

function toolStartImpl(hookInput: unknown): void {
  if (!rt) return;

  const h = (hookInput ?? {}) as ToolHookInput;
  const toolName = h.tool_name || 'unknown';

  correlateTurn(h);

  const attributes: Record<string, string> = {
    'openinference.span.kind': 'TOOL',
    'tool.name': toolName,
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': toolName,
  };
  // The args go out under BOTH names on purpose. `tool.parameters` is what
  // existing Phoenix filters query (dotted syntax, `tool.parameters.query`), so
  // it cannot be renamed away; `input.value` is what Phoenix's Input panel reads
  // on a TOOL span, and without it the panel renders empty for every tool. The
  // duplication is small — cheaper than a panel that is blank half the time and
  // so never trusted. No `input.value` on `llm.call`:
  // there the input never reaches this instrument (see `assistantStep`).
  if (h.tool_input) {
    const params = truncate(safeJson(h.tool_input));
    attributes['tool.parameters'] = params;
    attributes['input.value'] = params;
    attributes['input.mime_type'] = 'application/json';
  }
  // WHAT KIND of tool, as attributes instead of a string to be parsed later.
  const facts = classifyTool(toolName, h.tool_input);
  attributes['nanoclaw.tool_kind'] = facts.kind;
  if (facts.server) {
    attributes['nanoclaw.mcp_server'] = facts.server;
    attributes['nanoclaw.mcp_tool'] = facts.tool as string;
  }
  if (facts.skill) attributes['nanoclaw.skill'] = facts.skill;
  // Turn rollup, only while a turn is OPEN. Background work runs after `turnEnd`
  // with the counters already applied, so counting it here would credit it to the
  // NEXT turn — a skill nobody invoked in it. The span itself keeps the
  // attributes above either way, so nothing is lost, only re-attributed.
  if (turnSpan) {
    toolCalls++;
    if (facts.server) mcpServersUsed.add(facts.server);
    if (facts.skill) skillsUsed.add(facts.skill);
  }
  // Stamped on EVERY span: background work runs with no open turn and emerges as
  // a root, and these two are how it reconnects to the turn that produced it.
  if (h.session_id) attributes['session.id'] = h.session_id;
  if (h.prompt_id) attributes['prompt.id'] = h.prompt_id;
  // Present only when the hook fires from inside a subagent — what separates "the
  // agent did it" from "an AgentTool worker did it".
  if (h.agent_id) attributes['nanoclaw.agent_id'] = h.agent_id;
  if (h.agent_type) attributes['nanoclaw.agent_type'] = h.agent_type;

  // A subagent worker's tool: hangs on the subagent span via `agent_id`, not
  // loose under the turn.
  const subCtx = h.agent_id ? subagentCtxs.get(h.agent_id) : undefined;
  const startedAt = Date.now();
  let span: Span;
  let usedCtx: Context | undefined;
  const seedAttrs: Record<string, string | number | boolean> = { ...attributes };
  if (subCtx) {
    usedCtx = subCtx;
    span = rt.tracer.startSpan(`tool.${toolName}`, { startTime: startedAt, attributes }, subCtx);
  } else {
    const { ctx, detached } = parentContext();
    usedCtx = ctx;
    span = rt.tracer.startSpan(`tool.${toolName}`, { startTime: startedAt, attributes }, ctx);
    if (detached) {
      span.setAttribute('nanoclaw.detached_from_turn', true);
      seedAttrs['nanoclaw.detached_from_turn'] = true;
    }
  }

  // The SDK declares `tool_use_id` required; if it is missing anyway the span
  // cannot be paired at the end. Close it immediately, flagged — this records that
  // the tool ran without pretending the zero duration is real, and leaks no span.
  if (!h.tool_use_id) {
    span.setAttribute('nanoclaw.tool_unpaired', true);
    span.end();
    return;
  }
  // `startedAt` is kept because it seeds the worker boundary when this is the
  // `Agent` tool spawning a subagent. `anchorCtx` is the FIRST segment's context
  // — worker llm steps hang there, crash-safe once the first checkpoint runs.
  toolSpans.set(h.tool_use_id, {
    span,
    startedAt,
    name: toolName,
    seedAttrs,
    parentCtx: usedCtx,
    anchorCtx: rt.childContext(span),
    segment: 1,
    segmentStartedAt: startedAt,
  });
}

/**
 * Closes the finished tool's span, matched by `tool_use_id`.
 *
 * One callback serves `PostToolUse` and `PostToolUseFailure`; the input carries
 * `hook_event_name`, so success and failure are distinguishable without touching
 * hook registration.
 */
export function toolEnd(hookInput: unknown): void {
  try {
    toolEndImpl(hookInput);
  } catch (err) {
    swallow('toolEnd', err);
  }
}

function toolEndImpl(hookInput: unknown): void {
  if (!rt) return;

  const h = (hookInput ?? {}) as ToolHookInput;
  correlateTurn(h);

  if (!h.tool_use_id) return;
  const entry = toolSpans.get(h.tool_use_id);
  // Unknown id: ignore, never guess — closing an arbitrary open span would pair
  // it with another tool's duration.
  if (!entry) return;
  const span = entry.span;
  toolSpans.delete(h.tool_use_id);

  // Duration measured by the SDK (excludes the permission prompt and hook time).
  // The span clock measures the window between the two hooks, which is different.
  if (typeof h.duration_ms === 'number') span.setAttribute('nanoclaw.tool_duration_ms', h.duration_ms);

  // Output size only, never content — see the note on the field itself.
  if (h.tool_response !== undefined && h.tool_response !== null) {
    const body = typeof h.tool_response === 'string' ? h.tool_response : safeJson(h.tool_response);
    span.setAttribute('nanoclaw.tool_response_chars', body.length);
  }

  // Delivery via the MCP path. These tools write to `outbound.db` from inside the
  // MCP server — ANOTHER process, which never passes through `sendToDestination`.
  // Without this count, a turn that answered perfectly via `send_message` would
  // report `delivered_count=0` and look like a lost delivery.
  if (h.hook_event_name !== 'PostToolUseFailure' && DELIVERY_TOOLS.has(entry.name)) {
    deliveredCount++;
  }

  if (h.hook_event_name === 'PostToolUseFailure') {
    // The SDK types `error` as a string; a non-string must not reach `classifyFailure`.
    const err = typeof h.error === 'string' ? h.error : h.error == null ? '' : String(h.error);
    if (h.is_interrupt) span.setAttribute('nanoclaw.tool_interrupt', true);
    // The SDK exposes no dedicated field for a tool exit code (the two
    // `exit_code` fields that exist are for hooks and process spawn). It arrives
    // in the error text — `Exit code 127\n<stderr>` — and extracting it turns
    // "exit-code distribution" into a GROUP BY instead of string reading. Only
    // when OBSERVED: success is not stamped `0`, since that would be inference,
    // and an absent attribute already means success.
    const code = /^Exit code (\d+)/.exec(err);
    if (code) span.setAttribute('nanoclaw.tool_exit_code', Number(code[1]));
    // CLASSIFY BEFORE deciding the status. With `setStatus` first, every
    // `PostToolUseFailure` would be an error — including a pending approval, which
    // is the approval flow working.
    const kind = classifyFailure(err, code ? Number(code[1]) : null, h.is_interrupt === true);
    span.setAttribute('nanoclaw.failure_kind', kind);
    // Neutral but queryable: the class stays in the attribute, so "how often did
    // we block on approval" is still a GROUP BY — it just does not inflate the
    // error rate. Same call as `delivery.dropped` and `runnerError`'s graded
    // severity.
    if (kind !== 'approval_pending') {
      span.setStatus({ code: rt.errorStatus, message: truncate(err || 'tool failed') });
    }
  }
  span.end();
  // The finished tool closes the previous window: whatever follows until the next
  // assistant message is model time, not tool time. Only in ITS context — a worker
  // tool finishing must not reposition the main thread.
  boundaries.set(h.agent_id ?? MAIN_CTX, Date.now());
}

/* -------------------------------------------------------------------------- *
 * Delivery leg and runner errors.
 *
 * Everything below is called from `poll-loop.ts`, not the provider: the half of
 * the container that never touches the SDK — writing the answer to `outbound.db`
 * and swallowing infrastructure exceptions. Without it most deliveries had no
 * span at all, and "the agent answered but the answer never arrived" closed the
 * turn with status OK.
 *
 * Do NOT instrument `db/messages-out.ts`, the obvious choke point: that module is
 * also imported by the MCP server, which runs in ANOTHER process, and loading
 * telemetry there would make that process start an OTLP exporter and install
 * signal handlers that are not its own.
 * -------------------------------------------------------------------------- */

/**
 * Trace context for the runner's delivery leg, in the shape `mcp-tools/core.ts`
 * already spreads into message content.
 *
 * BOTH delivery legs must stamp this, by different routes and for the same
 * process reason. The MCP server goes through `session_state` because it cannot
 * see the runner's span; the poll-loop reads memory because it runs beside it.
 * Stamping only one leg links only the messages that happen to take that leg, so
 * agent-to-agent traces split whenever the other leg is used.
 *
 * Returns an OBJECT TO SPREAD, never `{ traceparent: undefined }`: spreading `{}`
 * adds no key at all, so with telemetry off the message is byte-identical to one
 * sent without this module. The undefined form would still change the object's
 * shape for any
 * consumer testing `'traceparent' in content`.
 *
 * Stamped for channel destinations too, matching `core.ts`. Adapters read only
 * `text`, so the extra key is inert there.
 */
export function traceparentField(): { traceparent?: string } {
  try {
    return traceparentFieldImpl();
  } catch (err) {
    swallow('traceparentField', err);
    return {};
  }
}

function traceparentFieldImpl(): { traceparent?: string } {
  return currentTraceparent ? { traceparent: currentTraceparent } : {};
}

/**
 * A destination write left the runner. Called AFTER the write, so the span exists
 * only if the row does; a write that threw arrives here with `error` before the
 * exception continues up.
 *
 * Delivery happens after `turnEnd()`, so the parent comes from `detachedTurnCtx`
 * and the span lands in the originating turn's trace instead of a loose root.
 *
 * With `startedAt` the span covers the outbound write itself, so its duration
 * is the delivery latency. Thread resolution stays outside the window: it runs
 * before the write, and `nanoclaw.thread_resolved` records its outcome.
 */
interface DeliveryInfo {
  destinationType: string;
  channelType: string;
  bodyChars: number;
  threadResolved: boolean;
  error?: string;
  startedAt?: number;
}

export function delivery(info: DeliveryInfo): void {
  try {
    deliveryImpl(info);
  } catch (err) {
    swallow('delivery', err);
  }
}

function deliveryImpl(info: DeliveryInfo): void {
  if (!rt) return;
  if (!info.error) deliveredCount++;
  const durationMs = typeof info.startedAt === 'number' ? Date.now() - info.startedAt : undefined;
  pointSpan(
    'delivery.send',
    {
      // Same kind as the other point spans (`agent.compact`, `task.*`). Without
      // it Phoenix files the span under UNKNOWN and it drops out of every
      // kind-filtered view.
      'openinference.span.kind': 'CHAIN',
      'nanoclaw.destination_type': info.destinationType,
      'nanoclaw.channel_type': info.channelType,
      'nanoclaw.body_chars': info.bodyChars,
      // A `resolveDestinationThread` failure silently stamps the wrong thread; as
      // an attribute it becomes a query instead of a suspicion.
      'nanoclaw.thread_resolved': info.threadResolved,
    },
    { errMessage: info.error, durationMs },
  );
}

/**
 * The turn produced user-facing text that was delivered to nobody.
 *
 * Status OK on purpose, not ERROR: the caller's condition already excludes task
 * runs and requires non-empty text, but the real frequency is unknown, since the
 * warning only ever existed in the container log. Queryable without inflating the
 * error rate; promote later if the measurement justifies it.
 */
export function dropped(textChars: number): void {
  try {
    droppedImpl(textChars);
  } catch (err) {
    swallow('dropped', err);
  }
}

function droppedImpl(textChars: number): void {
  nudgePending = true;
  pointSpan('delivery.dropped', {
    'openinference.span.kind': 'CHAIN',
    'nanoclaw.dropped': true,
    'nanoclaw.text_chars': textChars,
  });
}

/**
 * An error the runner swallowed — the `catch` blocks that only logged. The
 * caller's `log()` stays; this is an addition, not a replacement.
 *
 * `fatal` separates what kills the turn (query error, turn failure) from a
 * best-effort helper that fails for a benign reason and returns `null`. Only the
 * first becomes status ERROR; the second stays visible without polluting the
 * dashboard.
 */
export function runnerError(stage: string, err: unknown, opts?: { fatal?: boolean }): void {
  try {
    runnerErrorImpl(stage, err, opts);
  } catch (err) {
    swallow('runnerError', err);
  }
}

function runnerErrorImpl(stage: string, err: unknown, opts?: { fatal?: boolean }): void {
  if (!rt) return;
  const msg = err instanceof Error ? err.message : String(err);
  pointSpan(
    'runner.error',
    {
      'openinference.span.kind': 'CHAIN',
      'nanoclaw.stage': stage,
      'nanoclaw.failure_kind': classifyFailure(msg, null, false),
      // Always an attribute, including when neutral: otherwise a span without
      // ERROR status would lose the message entirely.
      'nanoclaw.error_message': truncate(msg),
    },
    { errMessage: opts?.fatal ? msg : undefined },
  );
}

/**
 * A provider block — exhausted quota or a window limit.
 *
 * Exists because the highest-fidelity signal was being thrown away:
 * `classifyRateLimitEvent` in `providers/claude.ts` reads the SDK's structured
 * `rate_limit_event` and knows WHY it blocked and WHEN it clears, and that result
 * only ever reached a poll-loop `log()`, which dies with the container.
 *
 * A quota block is typically followed by a burst of `context_overflow`, because
 * retries keep growing the context — the overflow is the SYMPTOM and this span is
 * the cause.
 *
 * Emits only a REAL block: `retryable === false`, or a `classification` present.
 * The poll-loop's `case 'error'` also fires for every API retry, and a span per
 * retry would be noise on top of the existing `apiRetries` counter.
 */
export function providerBlocked(event: { message?: string; retryable?: boolean; classification?: string }): void {
  try {
    providerBlockedImpl(event);
  } catch (err) {
    swallow('providerBlocked', err);
  }
}

function providerBlockedImpl(event: { message?: string; retryable?: boolean; classification?: string }): void {
  if (!rt) return;
  if (event.retryable !== false && !event.classification) return;

  const msg = event.message ?? '';
  const attributes: Record<string, string | number | boolean> = {
    'openinference.span.kind': 'CHAIN',
    'nanoclaw.retryable': event.retryable === true,
    // Same function as the text source, so the two agree by construction rather
    // than by maintainer discipline.
    'nanoclaw.failure_kind': classifyFailure(msg, null, false),
    'nanoclaw.error_message': truncate(msg),
  };
  if (event.classification) attributes['nanoclaw.classification'] = event.classification;

  // `resets_at` comes only from OUR format: `classifyRateLimitEvent` builds
  // " (resets <ISO>)", so this re-reads our own format string rather than guessing
  // a third party's. The CLI's own wording is a local time with NO date, which
  // would require guessing the day — an absent attribute beats a wrong one.
  const resets = /\(resets (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\)/.exec(msg);
  if (resets) attributes['nanoclaw.resets_at'] = resets[1];

  pointSpan('provider.blocked', attributes, { errMessage: msg });
}
