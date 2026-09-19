import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { getPiMcpTools } from './mcp-to-pi.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[pi-provider] ${msg}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Permission policy declared for the pi runtime: the container boundary is the
 * sandbox, so every tool is allowed. Shape mirrors the OpenCode provider's
 * OPENCODE_PERMISSION_POLICY — a flat constant consumed by the runtime
 * contract (provider-contracts/pi.ts → executionPolicy). Keys follow pi's
 * built-in tool surface (read/bash/edit/write/grep/find/ls) plus a bucket for
 * custom tools (the MCP bridge registers every external server as custom).
 */
export const PI_PERMISSION_POLICY = {
  read: 'allow',
  bash: 'allow',
  edit: 'allow',
  write: 'allow',
  grep: 'allow',
  find: 'allow',
  ls: 'allow',
  custom: 'allow',
} as const;

/**
 * Stale / dead pi session heuristics. The provider's own failures throw with
 * messages matching the first two alternatives; the rest cover ENOENT-style
 * errors bubbling out of pi's session reader when a continuation file was
 * removed behind our back.
 */
const STALE_SESSION_RE = /session file (?:not found|corrupt)|ENOENT.*session|session.*ENOENT|EISDIR.*session|session.*EISDIR/i;

/**
 * Structural mirror of the runner's `MemorySessionHookRegistration`
 * (src/memory/session-hook.ts on main). Declared locally for the same reason
 * codex-app-server.ts / opencode.ts declare their own copies: this providers
 * branch carries no `src/memory/*`, so importing the real type would not
 * compile here, while a structural copy still satisfies the interface once
 * this payload is installed onto a main-based tree.
 */
export interface PiMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * The two lifecycle points at which this provider establishes a new context
 * window. `clear` never appears: a cleared conversation arrives as a fresh
 * session (`startup`). `resume` never appears either, by contract: memory is
 * not re-injected when an existing session continues.
 */
type PiMemorySource = 'startup' | 'compact';

/** Matches the `timeout: 10` (seconds) the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/**
 * Run the registered memory session hook and return what it printed.
 *
 * The hook reads a Claude-style SessionStart payload on stdin and prints the
 * rendered memory section on stdout. Nothing is capped or rewritten here —
 * whatever the command prints is what gets injected. Fails closed on every
 * failure mode (unregistered, undeclared source, non-zero exit, timeout,
 * empty stdout): one log line, no injection, never a thrown turn.
 */
function runMemorySessionHook(hook: PiMemorySessionHook | undefined, source: PiMemorySource): string | undefined {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory injection`);
    return undefined;
  }
  if (!hook.sources.includes(source)) {
    log(`Memory session hook does not declare source ${source}; skipping injection`);
    return undefined;
  }

  try {
    const res = spawnSync(hook.command, {
      shell: true,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
      encoding: 'utf-8',
      timeout: MEMORY_HOOK_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${String(res.status)}`;
      log(`Memory session hook (${source}) failed (${why}); continuing without memory`);
      return undefined;
    }
    const out = (res.stdout ?? '').trim();
    if (!out) {
      log(`Memory session hook (${source}) produced no output; continuing without memory`);
      return undefined;
    }
    return out;
  } catch (err) {
    log(`Memory session hook (${source}) failed: ${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * Per-query memory lifecycle. One instance per `query()`, so nothing leaks
 * between queries. `openingInstructions` covers the new-context case: an
 * opening query with no continuation is a brand-new pi session, so memory
 * joins the system instructions the prompt already carries. A query that
 * resumes a continuation passes the instructions through untouched and never
 * runs the hook at all. There is no push-side injection: pi compacts in place
 * (the transcript keeps its history), so unlike OpenCode there is no
 * post-compaction context rebuild to re-arm.
 */
function createMemoryLifecycle(
  hook: PiMemorySessionHook | undefined,
  isResume: boolean,
): {
  openingInstructions(systemInstructions?: string): string | undefined;
} {
  return {
    openingInstructions(systemInstructions) {
      if (isResume) return systemInstructions;
      const memory = runMemorySessionHook(hook, 'startup');
      if (!memory) return systemInstructions;
      return systemInstructions ? `${memory}\n\n${systemInstructions}` : memory;
    },
  };
}

/**
 * Prefix the system context onto an opening prompt as a `<system>` block —
 * the same shape the OpenCode provider uses. pi has no supported public
 * override for the system prompt on an existing session (the internal
 * `_systemPromptOverride` field is deliberately not used), so the runner's
 * instructions ride the opening prompt instead.
 */
function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

/** Concatenated text content of an assistant message ('' when it has none). */
function extractAssistantText(message: AssistantMessageLike): string {
  if (!Array.isArray(message.content)) return '';
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
  return text;
}

/** Structural subset of pi's AssistantMessage this provider reads. */
interface AssistantMessageLike {
  content: Array<{ type: string; text?: unknown }>;
}

/**
 * True only when a *resumed* session's first turn produced no assistant work
 * at all and surfaced no provider error — the poisoned-continuation signature
 * that licenses the one-shot fresh-session fallback. A brand-new session that
 * stays dry is a model/tools miss, not a dead continuation, and a turn that
 * errored must propagate its error instead of silently replaying.
 */
export function isEmptyPiResume(opts: {
  resumedExistingSession: boolean;
  alreadyFellBack: boolean;
  sawAssistantWork: boolean;
  sawError: boolean;
}): boolean {
  return opts.resumedExistingSession && !opts.alreadyFellBack && !opts.sawAssistantWork && !opts.sawError;
}

/** What one pi run (initial prompt plus any follow-ups queued mid-run) produced. */
interface TurnOutcome {
  /** Final assistant text of the run, or null when it produced no text. */
  text: string | null;
  /** Any assistant message, tool execution, or other live agent work happened. */
  sawAssistantWork: boolean;
  /** A provider/model error or exhausted retry budget surfaced during the run. */
  sawError: boolean;
}

export class PiProvider implements AgentProvider {
  // Slash commands stay XML-wrapped by the runner: pi's native command surface
  // (/compact, /theme, …) is interactive-TUI semantics and unwanted headless.
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly env: Record<string, string | undefined>;
  /**
   * Optional test seam, mirroring the OpenCode/Codex providers' second
   * constructor argument: a caller-supplied model/auth runtime handed straight
   * to createAgentSession so tests can script model turns. Production wiring
   * never passes it and pi builds its own runtime from agentDir.
   */
  private readonly modelRuntime?: ModelRuntime;
  private memorySessionHook?: PiMemorySessionHook;

  constructor(options: ProviderOptions = {}, modelRuntime?: ModelRuntime) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.modelRuntime = modelRuntime;
  }

  /**
   * Two signatures for two eras: the providers branch passes the hook alone,
   * main's realize.ts also passes the contract's resolved memory capability
   * (accepted and ignored — the hook command is the only thing this provider
   * needs). Same defense as the OpenCode/Codex providers: the runner
   * registers the shared hook before polling, so an unregistered provider
   * means the wiring broke — fail loudly rather than run a memoryless agent.
   */
  registerMemorySessionHook(hook: PiMemorySessionHook, _memory?: unknown): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = errorMessage(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('pi memory session hook was not registered');

    // pi resolves model auth from the process environment natively, so apply
    // the runner-provided env before anything (session creation, MCP bridge)
    // can read it.
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined) process.env[key] = value;
    }

    const cwd = input.cwd;
    // Session files must land inside the RW group workspace: the continuation
    // is the session file's absolute path, and it has to survive container
    // restarts (poll-loop persists it in the DB; the file must still exist).
    const sessionsDir = path.join(cwd, '.pi', 'sessions');
    // pi's global config dir. The host-side provider config (src/providers/pi.ts)
    // mounts a per-session seeded agentDir at /pi-agent and points PI_AGENT_DIR
    // at it — prefer that when present. Fallback (bare/test environments):
    // inside the RW workspace so pi never needs a writable HOME.
    const agentDir = process.env.PI_AGENT_DIR || path.join(cwd, '.pi', 'agent');

    const systemInstructions = input.systemContext?.instructions;
    const originalPrompt = input.prompt;
    const resumed = Boolean(input.continuation);
    const memory = createMemoryLifecycle(this.memorySessionHook, resumed);

    let session: AgentSession | null = null;
    let continuation: string | undefined = input.continuation;
    let customTools: ToolDefinition[] | undefined;
    let emptyResumeFellBack = false;

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const kick = (): void => {
      waiting?.();
    };

    // Opening prompt: memory (new sessions only) + runner instructions in one
    // <system> block. Follow-up pushes ride as plain text.
    pending.push(wrapPromptWithContext(originalPrompt, memory.openingInstructions(systemInstructions)));

    const self = this;

    const loadCustomTools = async (): Promise<ToolDefinition[]> => {
      if (customTools) return customTools;
      try {
        // Memoized inside the bridge: first call connects the MCP servers,
        // later calls with the same config reuse the cached ToolDefinitions.
        customTools = await getPiMcpTools(self.mcpServers);
      } catch (err) {
        // The bridge already degrades per-server; a throw here means broken
        // wiring. Keep the session usable but say so — never silently drop
        // the system tool surface.
        log(`MCP bridge failed: ${errorMessage(err)}`);
        customTools = [];
      }
      return customTools;
    };

    /** Create (or resume) the pi session. Init is yielded by the caller immediately after. */
    const openSession = async (
      resumePath: string | undefined,
    ): Promise<{ session: AgentSession; continuation: string }> => {
      const tools = await loadCustomTools();
      // Injected runtime (tests) wins; production lets pi resolve auth/models
      // from agentDir. Spread keeps the payload identical when unset.
      const sessionOptions = {
        cwd,
        agentDir,
        customTools: tools,
        ...(self.modelRuntime ? { modelRuntime: self.modelRuntime } : {}),
      };
      let created: AgentSession;
      if (resumePath) {
        if (!fs.existsSync(resumePath)) {
          throw new Error(`pi session file not found: ${resumePath} (ENOENT)`);
        }
        let manager: SessionManager;
        try {
          manager = SessionManager.open(resumePath);
        } catch (err) {
          throw new Error(`pi session file corrupt: ${resumePath}: ${errorMessage(err)}`);
        }
        created = (await createAgentSession({ ...sessionOptions, sessionManager: manager })).session;
      } else {
        fs.mkdirSync(sessionsDir, { recursive: true });
        created = (
          await createAgentSession({ ...sessionOptions, sessionManager: SessionManager.create(cwd, sessionsDir) })
        ).session;
      }
      const file = created.sessionFile;
      if (!file) throw new Error('pi sessions are disabled (no session file path)');
      return { session: created, continuation: file };
    };

    /**
     * Run one prompt through the session and translate pi's callback stream
     * into ProviderEvents until the run settles (pi's prompt() promise spans
     * auto-retries, compaction and any follow-ups queued mid-run, and
     * agent_settled fires only after the queue drains — so awaiting both
     * covers the whole batch). Every SDK event maps to at least one activity
     * so the poll-loop's heartbeat stays honest during long tool runs.
     */
    async function* runTurn(turnText: string): AsyncGenerator<ProviderEvent, TurnOutcome> {
      const sess = session;
      if (!sess) throw new Error('pi session not initialized');

      const collected: AgentSessionEvent[] = [];
      let notify: (() => void) | null = null;
      const onEvent = (event: AgentSessionEvent): void => {
        collected.push(event);
        const wake = notify;
        notify = null;
        wake?.();
      };
      const unsubscribe = sess.subscribe(onEvent);

      let settled = false;
      let promptDone = false;
      let promptError: unknown;
      const promptPromise = sess.prompt(turnText, { expandPromptTemplates: false }).then(
        () => {
          promptDone = true;
        },
        (err: unknown) => {
          promptDone = true;
          promptError = err;
        },
      );

      let lastText = '';
      let sawAssistantWork = false;
      let sawError = false;
      let fatalMessage: string | undefined;

      try {
        while (collected.length > 0 || !(settled || promptDone || aborted)) {
          if (collected.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          const ev = collected.shift()!;

          // Liveness on every underlying SDK event — non-negotiable (the
          // container's heartbeat advances once per consumed ProviderEvent).
          yield { type: 'activity' };

          switch (ev.type) {
            case 'message_end': {
              const message = ev.message;
              if (message.role !== 'assistant') break;
              if (message.stopReason === 'error') {
                sawError = true;
                const detail = message.errorMessage ?? 'unknown error';
                const quota = /rate limit|quota|429/i.test(detail);
                yield {
                  type: 'error',
                  message: `pi model error: ${detail}`,
                  retryable: true,
                  ...(quota ? { classification: 'quota' } : {}),
                };
                break;
              }
              sawAssistantWork = true;
              const text = extractAssistantText(message);
              if (text) lastText = text;
              break;
            }
            case 'tool_execution_start':
            case 'tool_execution_update':
            case 'tool_execution_end': {
              sawAssistantWork = true;
              break;
            }
            case 'auto_retry_start': {
              sawError = true;
              yield {
                type: 'error',
                message: `pi auto-retry (attempt ${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage}`,
                retryable: true,
              };
              break;
            }
            case 'auto_retry_end': {
              // pi's own retry budget ran out. The run ends below with the
              // error (agent_end carries the failed assistant message); the
              // error event documents why for the log.
              if (!ev.success) {
                sawError = true;
                yield {
                  type: 'error',
                  message: `pi retry budget exhausted (attempt ${ev.attempt}): ${ev.finalError ?? 'unknown error'}`,
                  retryable: false,
                };
              }
              break;
            }
            case 'compaction_start': {
              yield { type: 'progress', message: 'pi: compacting session context' };
              break;
            }
            case 'compaction_end': {
              if (ev.errorMessage) {
                yield { type: 'error', message: `pi compaction failed: ${ev.errorMessage}`, retryable: false };
              }
              break;
            }
            case 'agent_end': {
              // Authoritative fatal check: after the final settlement (no
              // further retries planned), a trailing error-stop assistant
              // message means the run failed. If a later compaction/turn
              // recovered, the last assistant message is a good one.
              if (!ev.willRetry) {
                for (let i = ev.messages.length - 1; i >= 0; i--) {
                  const msg = ev.messages[i];
                  if (msg && msg.role === 'assistant') {
                    if (msg.stopReason === 'error' && msg.errorMessage) {
                      fatalMessage = `pi agent run failed: ${msg.errorMessage}`;
                    }
                    break;
                  }
                }
              }
              break;
            }
            case 'agent_settled': {
              settled = true;
              break;
            }
            default:
              // turn_start/turn_end, message_start/message_update, queue_update,
              // entry_appended, session_info_changed, thinking_level_changed,
              // bash_execution_update, summarization_* — activity already yielded.
              break;
          }
        }
      } finally {
        unsubscribe();
      }

      await promptPromise;
      if (aborted) return { text: null, sawAssistantWork, sawError };
      if (promptError !== undefined) {
        // Preflight/validation failures (no model, no API key, compaction in
        // progress) reject the prompt promise — fatal, user-visible.
        throw new Error(`pi prompt failed: ${errorMessage(promptError)}`);
      }
      if (fatalMessage !== undefined) throw new Error(fatalMessage);
      return { text: lastText || null, sawAssistantWork, sawError };
    }

    async function* gen(): AsyncGenerator<ProviderEvent> {
      try {
        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0) return; // ended and drained

          const text = pending.shift()!;

          if (!session) {
            const created = await openSession(continuation);
            session = created.session;
            continuation = created.continuation;
            // Init at the first moment the continuation exists — poll-loop
            // persists it immediately, so a mid-turn crash still resumes.
            yield { type: 'init', continuation };
          }

          let outcome = yield* runTurn(text);
          if (aborted) return;

          // One-shot empty-resume fallback: a resumed session whose first
          // turn did nothing and errored nowhere is a dead continuation.
          // Start fresh, persist the new continuation via a second init, and
          // replay the original prompt the way a first-time query would have
          // composed it (fresh memory lifecycle, one <system> block).
          if (
            isEmptyPiResume({
              resumedExistingSession: resumed,
              alreadyFellBack: emptyResumeFellBack,
              sawAssistantWork: outcome.sawAssistantWork,
              sawError: outcome.sawError,
            })
          ) {
            log(`Empty resume on ${continuation}; starting fresh session.`);
            emptyResumeFellBack = true;
            session.dispose();
            session = null;
            const created = await openSession(undefined);
            if (aborted) {
              created.session.dispose();
              return;
            }
            session = created.session;
            continuation = created.continuation;
            yield { type: 'init', continuation };
            const freshMemory = createMemoryLifecycle(self.memorySessionHook, false);
            outcome = yield* runTurn(wrapPromptWithContext(originalPrompt, freshMemory.openingInstructions(systemInstructions)));
            if (aborted) return;
          }

          // The turn is done whether or not the model said anything —
          // poll-loop treats result as the completion signal and sends null
          // text nowhere.
          yield { type: 'result', text: outcome.text };
        }
      } finally {
        // Normal end (or fatal throw): release the session's listeners and
        // agent runtime. The session FILE survives — it is the continuation.
        // On abort, the abort() handle owns teardown (it must wait for
        // session.abort() to settle before disposing).
        if (!aborted) session?.dispose();
      }
    }

    return {
      push(message: string) {
        if (aborted || ended) return;
        const sess = session;
        if (sess && sess.isStreaming) {
          // Mid-turn: hand the message to pi's own follow-up queue. The
          // active runTurn stays subscribed until agent_settled, which pi
          // emits only after the follow-up queue drains, so the pushed
          // message's turn is covered by the pending result.
          void sess
            .prompt(message, { streamingBehavior: 'followUp', expandPromptTemplates: false })
            .catch((err: unknown) => log(`pi followUp failed: ${errorMessage(err)}`));
          return;
        }
        pending.push(message);
        kick();
      },
      end() {
        ended = true;
        kick();
      },
      events: gen(),
      abort() {
        if (aborted) return;
        aborted = true;
        kick();
        const sess = session;
        if (sess) {
          void sess
            .abort()
            .then(() => sess.dispose())
            .catch((err: unknown) => log(`pi abort/dispose failed: ${errorMessage(err)}`));
        }
      },
    };
  }
}

// Function-form registration only; the runtime contract attaches itself from
// provider-contracts/pi.ts, so this module compiles on either core.
registerProvider('pi', (opts) => new PiProvider(opts));
