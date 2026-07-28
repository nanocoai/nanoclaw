/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';

import { setThreadTokens } from '../db/session-state.js';
import { buildHandoffRecap } from '../handoff.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  killCodexAppServer,
  sendCodexRequest,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

/** Cumulative input tokens before triggering native compaction. */
const COMPACT_THRESHOLD = 40_000;

/**
 * Hard ceiling on a single thread's cumulative input tokens, checked after
 * every turn regardless of whether compaction ran. Live incident
 * 2026-07-22: native compaction ("thread/compact/start") reported success
 * while a thread kept growing past 357k tokens on subsequent turns and
 * eventually wedged on resume — its on-disk rollout does not actually
 * shrink. Compaction is kept as a cheap first attempt (may reduce cost even
 * if it doesn't cap growth), but this ceiling is the real safety net: once
 * crossed, the NEXT turn abandons the thread and starts a brand-new one
 * with a conversation recap prepended, instead of trusting compaction to
 * have worked. This happens mid-stream — the poll-loop keeps one query()
 * open across many turns (see the query() doc comment above), so a rotation
 * decision made only at query()-open time (outer poll-loop) would never
 * fire for a long-lived container.
 */
const THREAD_ROTATE_TOKENS = Number(process.env.PROVIDER_THREAD_ROTATE_TOKENS) || 150_000;

/**
 * IDLE ceiling for a single turn: trips only after this long with NO
 * notifications from the app-server. Guards against the app-server wedging
 * after `turn/start` (model never streams, no turn/completed) while letting
 * a genuinely long, tool-heavy turn run — a working turn streams item/*
 * notifications constantly and keeps re-arming the timer. A fixed wall-clock
 * ceiling here killed every heavy fallback turn mid-work (live, 2026-07-07).
 * Overridable via env.
 */
const TURN_TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS) || 120_000;

/**
 * Errors that indicate the stored thread ID is unusable — typically
 * because the app-server has no memory of it (thread transcript was
 * deleted, server was wiped, ID is from a different codex version).
 */
// "Turn stalled" (idle-watchdog trip) counts as session-poison: observed
// live 2026-07-22 on a ~370k-token thread that wedged on every resume —
// only a fresh thread recovers, so the continuation must be cleared.
const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread|turn\s+stalled/i;

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't read CLAUDE.md/AGENT.md from cwd the way Claude
// Code does. We have to load it and pass it in as `baseInstructions`. The
// addendum from the poll-loop (destinations syntax, etc.) is appended.

function loadAgentBaseInstructions(): string | undefined {
  const candidates = ['/workspace/agent/CLAUDE.md', '/workspace/agent/AGENT.md'];
  const parts: string[] = [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      parts.push(fs.readFileSync(p, 'utf-8'));
      break;
    }
  }
  // Per-group memory (user preferences, project context). Claude Code picks
  // this up automatically from cwd; Codex has no such convention, so without
  // loading it explicitly the fallback engine loses everything the agent
  // "knows" about the user — a big part of why a Claude→Codex switch felt
  // like talking to a different person (reported live 2026-07-08).
  const localMd = '/workspace/agent/CLAUDE.local.md';
  if (fs.existsSync(localMd)) {
    parts.push(fs.readFileSync(localMd, 'utf-8'));
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function composeBaseInstructions(promptAddendum: string | undefined): string | undefined {
  const agentMd = loadAgentBaseInstructions();
  const pieces = [agentMd, promptAddendum].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string;
  private readonly baseUrl?: string;
  private readonly effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.model = (options.env?.CODEX_MODEL as string | undefined) ?? 'gpt-5.4-mini';
    this.baseUrl = options.env?.OPENAI_BASE_URL as string | undefined;
    this.effort = options.effort;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    // Live app-server handle, hoisted so abort() can kill the process
    // synchronously. Without this, an abort while blocked inside an awaited
    // JSON-RPC request (e.g. a hung thread/resume) can't take effect until
    // that request's own timeout fires — the generator only re-checks
    // `aborted` between awaits. Killing the process rejects every pending
    // request immediately, so the abort is honoured at once.
    let server: AppServer | null = null;
    const kick = (): void => {
      waiting?.();
    };

    pending.push(input.prompt);

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      writeCodexMcpConfigToml(self.mcpServers);
      server = spawnCodexAppServer(createCodexConfigOverrides(self.baseUrl, self.effort));
      attachCodexAutoApproval(server);
      // If abort() already fired before the server came up, tear down now.
      if (aborted) {
        killCodexAppServer(server);
        return;
      }

      let threadId: string | undefined = input.continuation;
      let initYielded = false;
      let cumulativeInputTokens = 0;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          model: self.model,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions),
        };

        threadId = await startOrResumeCodexThread(server, threadId, threadParams);

        // Set when a turn crosses THREAD_ROTATE_TOKENS — the NEXT turn
        // abandons the current thread for a fresh one before picking up its
        // pending text (see THREAD_ROTATE_TOKENS doc comment).
        let needsFreshThread = false;

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          let text = pending.shift()!;

          if (needsFreshThread) {
            log(`Rotating to a fresh thread (was ${cumulativeInputTokens} tokens) — prepending recap`);
            text = buildHandoffRecap() + text;
            threadId = await startOrResumeCodexThread(server, undefined, threadParams);
            // Reset the init-yielded gate so runOneTurn yields a fresh
            // `init` event for this new thread id — otherwise the poll-loop
            // never learns the continuation changed and would keep trying
            // to resume the old (rotated-away) thread on the next spawn.
            initYielded = false;
            cumulativeInputTokens = 0;
            needsFreshThread = false;
          }

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          yield* runOneTurn(
            server,
            threadId!,
            text,
            self.model,
            input.cwd,
            () => initYielded,
            () => {
              initYielded = true;
            },
            (tokens) => {
              cumulativeInputTokens = tokens;
            },
          );

          // Persist the thread's size (informational — the outer poll-loop
          // also consults this at query()-open time for a fresh container).
          if (cumulativeInputTokens > 0) {
            setThreadTokens('codex', cumulativeInputTokens);
          }

          // Trigger native compaction between turns if we've crossed the
          // threshold. Codex's compaction is deterministic enough to do
          // inline — if it fails, we log and carry on uncompacted. This is
          // a best-effort cost reduction, NOT the rotation safety net below.
          if (cumulativeInputTokens >= COMPACT_THRESHOLD && threadId) {
            log(`Compacting thread (${cumulativeInputTokens} tokens)`);
            // sendCodexRequest REJECTS on its 60s timeout — it doesn't come
            // back as a `.error` payload. Uncaught, that rejection escaped
            // gen() and failed the whole turn AFTER the answer was already
            // produced ("Fallback turn failed: Timeout waiting for
            // thread/compact/start", observed live 2026-07-28). Compaction
            // is best-effort by contract, so swallow any failure.
            try {
              const compactResp = await sendCodexRequest(server, 'thread/compact/start', { threadId });
              if (compactResp.error) {
                log(`Compaction failed: ${compactResp.error.message} — continuing uncompacted`);
              } else {
                log('Native compaction completed');
              }
            } catch (err) {
              log(
                `Compaction errored (${err instanceof Error ? err.message : String(err)}) — continuing uncompacted`,
              );
            }
          }

          // Hard ceiling, independent of whether compaction ran or claimed
          // success — see THREAD_ROTATE_TOKENS doc comment.
          if (cumulativeInputTokens >= THREAD_ROTATE_TOKENS) {
            needsFreshThread = true;
          }
        }
      } finally {
        if (server) killCodexAppServer(server);
        server = null;
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        kick();
        // Kill the process now so an in-flight JSON-RPC request rejects
        // immediately rather than waiting out its per-request timeout.
        if (server) killCodexAppServer(server);
      },
      events: gen(),
    };
  }
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string,
  cwd: string,
  hasInit: () => boolean,
  markInit: () => void,
  setInputTokens: (n: number) => void,
): AsyncGenerator<ProviderEvent> {
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  // Idle watchdog: re-armed on every notification. Only sustained SILENCE
  // (a wedged resume/turn) trips it — steady tool/stream traffic never does.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      turnState.error = new Error(`Turn stalled: no app-server events for ${TURN_TIMEOUT_MS}ms`);
      turnDone = true;
      kick();
    }, TURN_TIMEOUT_MS);
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Every inbound notification proves liveness — re-arm the idle watchdog
    // and count as activity for the poll-loop's idle timer; yield before any
    // event-specific translation so even long tool executions keep the loop
    // awake.
    armIdleTimer();
    buffer.push({ type: 'activity' });

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'item/completed': {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as { total?: { inputTokens?: number } } | undefined;
        if (usage?.total?.inputTokens !== undefined) setInputTokens(usage.total.inputTokens);
        break;
      }
      case 'turn/completed':
        turnDone = true;
        break;
      case 'turn/failed': {
        const e = params.error as { message?: string } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        const status = params.status as string | undefined;
        if (status) buffer.push({ type: 'progress', message: `status: ${status}` });
        break;
      }
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);
  armIdleTimer();

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    await startCodexTurn(server, { threadId, inputText, model, cwd });

    while (true) {
      while (buffer.length > 0) {
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    if (turnState.error) {
      yield { type: 'error', message: turnState.error.message, retryable: false };
      return;
    }

    yield { type: 'result', text: resultText || null };
  } finally {
    clearTimeout(idleTimer);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
