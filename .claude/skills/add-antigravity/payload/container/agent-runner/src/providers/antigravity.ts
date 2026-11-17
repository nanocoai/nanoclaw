/**
 * Google Antigravity CLI (`agy`) agent provider.
 *
 * One long-lived agy process per `query()`, driven over its stream-json
 * protocol (antigravity-protocol.ts): each pushed message becomes one user
 * line on stdin, each turn ends in one `result` line. The continuation is
 * agy's conversation id, resumed with `--conversation`.
 *
 * Per-session instructions (`systemContext.instructions`: chat or task mode,
 * destinations) travel in-band, as a delimited block at the head of the first
 * user line each process receives. They cannot go in a rule file: `~/.gemini`
 * is shared by every session of the group and agy rereads its rules on every
 * turn, so one session's spawn would reroute another session's live agy. The
 * rule file carries only group-level content (antigravity-config.ts).
 *
 * Credentials never enter the container. The host passes GEMINI_API_KEY as a
 * placeholder; agy sends it as `x-goog-api-key` through HTTPS_PROXY and the
 * credential gateway swaps it for the vaulted key.
 *
 * This module never imports the runtime contract (provider-contracts/
 * antigravity.ts): registration is two-step, so it compiles and runs on a core
 * that predates the contract seam. The contract attaches itself through
 * registerProviderContract and reuses the section functions in
 * antigravity-config.ts.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  ANTIGRAVITY_COMMAND,
  ANTIGRAVITY_PROTOCOL_ARGS,
  type AntigravityExecutionPolicy,
  type AntigravityInference,
  type AntigravityMcpConfig,
  type AntigravityMemorySessionHook,
  antigravityExecutionPolicySection,
  antigravityInferenceSection,
  antigravityMcpServersSection,
  antigravityRuntimeOwnership,
  buildAntigravityProcessEnv,
  prepareAntigravityRules,
  writeAntigravityRuntimeFiles,
} from './antigravity-config.js';
import {
  type AntigravityStderrError,
  type AntigravityTurnResult,
  STALE_CONVERSATION_RE,
  antigravityFailureNotice,
  classifyAntigravityError,
  parseAntigravityLine,
  parseAntigravityStderrLine,
  renderAntigravityFirstTurn,
  renderAntigravityUserLine,
  stepProgressMessage,
} from './antigravity-protocol.js';

function log(msg: string): void {
  console.error(`[antigravity] ${msg}`);
}

/** SIGTERM lets agy end the turn cleanly; SIGKILL follows if it has not exited by then. */
const KILL_GRACE_MS = 5_000;

export function spawnAgy(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  log(`Spawning: ${ANTIGRAVITY_COMMAND} ${args.join(' ')}`);
  return spawn(ANTIGRAVITY_COMMAND, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
}

export interface AntigravityRuntimeDeps {
  spawnAgy: typeof spawnAgy;
  writeRuntimeFiles: typeof writeAntigravityRuntimeFiles;
  prepareRules: typeof prepareAntigravityRules;
  killGraceMs: number;
}

/**
 * The production runtime deps. Exported as one mutable object so a test can
 * swap in fakes for a provider that core constructs (createProvider gives the
 * test no constructor access); every instance built without explicit deps
 * reads through this object.
 */
export const defaultAntigravityRuntimeDeps: AntigravityRuntimeDeps = {
  spawnAgy,
  writeRuntimeFiles: writeAntigravityRuntimeFiles,
  prepareRules: prepareAntigravityRules,
  killGraceMs: KILL_GRACE_MS,
};

/**
 * Structural mirror of the contract core's `ResolvedRuntimeConfiguration` —
 * what `createProvider` hands the factory after running the contract's
 * configuration resolves. Mirrored, not imported: the type lives in
 * `provider-contracts/registry.ts`, which a pre-contract core does not have.
 */
export interface AntigravityResolvedConfiguration {
  executionPolicy?: unknown;
  inference?: unknown;
  mcpServers?: unknown;
  /** Passed by cores that support `configuration.tone`; agy has no tone control, so it is ignored. */
  tone?: unknown;
}

/** The full agy argv for one query. */
export function antigravityArgs(
  executionPolicy: AntigravityExecutionPolicy,
  inference: AntigravityInference,
  continuation: string | undefined,
): string[] {
  return [
    ...ANTIGRAVITY_PROTOCOL_ARGS,
    ...executionPolicy.args,
    ...inference.args,
    ...(continuation ? ['--conversation', continuation] : []),
  ];
}

/**
 * A failed turn. `error` is the channel notice on a core that has it;
 * older cores type the result without that field, so it is attached
 * without changing the declared event type.
 */
function failedResult(error: string): ProviderEvent {
  return { type: 'result', text: null, isError: true, error } as ProviderEvent;
}

/** One agy process. A query normally has one; it respawns only to recover input queued behind a failed turn. */
interface AgyRun {
  child: ChildProcess;
  /** The `--conversation` this process was started with. */
  requestedConversation: string | undefined;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  spawnError: Error | null;
  stdinClosed: boolean;
  /** Whether this process's first user line (carrying the system context) has been written. */
  contextSent: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  exitWaiters: Array<() => void>;
}

export class AntigravityProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly executionPolicy: AntigravityExecutionPolicy;
  private readonly inference: AntigravityInference;
  private readonly mcpConfig: AntigravityMcpConfig;
  private readonly runtime: AntigravityRuntimeDeps;
  private memorySessionHook?: AntigravityMemorySessionHook;

  /**
   * `configuration` is present on a contract core: core has already run the
   * contract's resolves and hands the results over, so they are consumed
   * as-is. Without it (a pre-contract core) the provider derives the same
   * values itself from the options.
   */
  constructor(
    options: ProviderOptions = {},
    runtime: AntigravityRuntimeDeps = defaultAntigravityRuntimeDeps,
    configuration?: AntigravityResolvedConfiguration,
  ) {
    this.runtime = runtime;
    if (configuration) {
      this.executionPolicy = configuration.executionPolicy as AntigravityExecutionPolicy;
      this.inference = configuration.inference as AntigravityInference;
      this.mcpConfig = configuration.mcpServers as AntigravityMcpConfig;
    } else {
      this.executionPolicy = antigravityExecutionPolicySection();
      // `speed` exists on ProviderOptions only from the contract core on; read
      // it structurally so this compiles against the older options type too.
      const { speed } = options as ProviderOptions & { speed?: string };
      this.inference = antigravityInferenceSection({ model: options.model, effort: options.effort, speed });
      this.mcpConfig = antigravityMcpServersSection(options.mcpServers ?? {});
    }
  }

  /** `memory` is the contract's resolved memory section (the hook itself); a pre-contract core passes only `hook`. */
  registerMemorySessionHook(hook: AntigravityMemorySessionHook, memory?: unknown): void {
    this.memorySessionHook = (memory as AntigravityMemorySessionHook | undefined) ?? hook;
  }

  /**
   * agy does not fail on an unknown `--conversation`: it warns and starts a
   * new one, which the query reports through `init`. This only catches the
   * same wording should it ever surface as an error.
   */
  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_CONVERSATION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Antigravity memory session hook was not registered');
    const memorySessionHook = this.memorySessionHook;
    const runtime = this.runtime;
    const instructions = input.systemContext?.instructions;
    const self = this;

    // Turns waiting for agy. One user line is written at a time, the next only
    // after the previous turn's `result`, so every result answers exactly one
    // input in order — the FIFO the poll-loop's queued turns rely on.
    const pending: string[] = [input.prompt];
    const buffer: ProviderEvent[] = [];
    let waker: (() => void) | null = null;
    let run: AgyRun | null = null;
    /** The prompt agy is answering: written, no `result` yet. */
    let inFlightPrompt: string | null = null;
    let ended = false;
    let aborted = false;
    /** The conversation the caller holds; a changed id is reported as a new `init`. */
    let conversationId: string | undefined;
    /** Failure results whose error is still being assembled (see handleResult). */
    let deferredResults = 0;
    // Exit-after-failure recovery, bounded to one respawn per failed result.
    let lastResultFailed = false;
    let respawnedAfterFailure = false;

    // Diagnostics for the current turn, cleared when the next line is written.
    let lastStderrError: string | null = null;
    let lastAgyError: AntigravityStderrError | null = null;
    /** Whether agy emitted an `error_message` step for the current turn. */
    let turnSawErrorStep = false;

    const wake = (): void => {
      const w = waker;
      waker = null;
      w?.();
    };

    const pump = (): void => {
      const current = run;
      if (!current || current.exited || aborted || current.stdinClosed) return;
      const stdin = current.child.stdin;
      if (!stdin) return;
      if (inFlightPrompt === null) {
        const next = pending.shift();
        if (next !== undefined) {
          // Each process opens with the session's system context; agy keeps
          // it in the conversation, so later lines are the bare prompt.
          const line = current.contextSent ? next : renderAntigravityFirstTurn(instructions, next);
          current.contextSent = true;
          lastStderrError = null;
          lastAgyError = null;
          turnSawErrorStep = false;
          stdin.write(renderAntigravityUserLine(line));
          inFlightPrompt = next;
        }
      }
      // Closing stdin lets an in-flight turn finish, then agy exits 0.
      if (ended && pending.length === 0) {
        current.stdinClosed = true;
        stdin.end();
      }
    };

    const terminate = (target: AgyRun): void => {
      if (target.exited || target.killTimer) return;
      try {
        target.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      target.killTimer = setTimeout(() => {
        if (target.exited) return;
        log(`agy did not exit within ${runtime.killGraceMs}ms of SIGTERM; sending SIGKILL`);
        try {
          target.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, runtime.killGraceMs);
      target.killTimer.unref?.();
    };

    const markExited = (target: AgyRun): void => {
      if (target.exited) return;
      target.exited = true;
      if (target.killTimer) clearTimeout(target.killTimer);
      for (const resolve of target.exitWaiters) resolve();
      target.exitWaiters = [];
      wake();
    };

    const waitForExit = (target: AgyRun, timeoutMs: number): Promise<void> =>
      target.exited
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
            target.exitWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });

    const adoptConversation = (id: string | undefined, target: AgyRun): void => {
      if (!id || id === conversationId) return;
      conversationId = id;
      buffer.push({ type: 'init', continuation: id });
      // An unknown --conversation does not fail: agy warns and starts a new
      // conversation. The new id replaces the stored continuation.
      if (target.requestedConversation && id !== target.requestedConversation) {
        log(`Conversation ${target.requestedConversation} not found; agy started ${id}`);
        buffer.push({
          type: 'progress',
          message: `Antigravity conversation ${target.requestedConversation} was not found; started a new conversation`,
        });
      }
    };

    const failTurn = (result: AntigravityTurnResult): void => {
      const status = result.status || 'UNKNOWN';
      const message =
        result.error ||
        lastAgyError?.short_error ||
        lastStderrError ||
        `Antigravity turn ended with status ${status}${result.finished_reason ? ` (${result.finished_reason})` : ''}`;
      const classification =
        classifyAntigravityError(message) ??
        (status === 'CANCELED' || status === 'INTERRUPTED' ? 'interrupted' : undefined);
      log(`Turn failed (status=${status}): ${message}`);
      buffer.push({
        type: 'error',
        message,
        retryable: lastAgyError?.retryable === true,
        ...(classification ? { classification } : {}),
      });
      buffer.push(failedResult(antigravityFailureNotice(message, classification)));
    };

    const handleResult = (result: AntigravityTurnResult, target: AgyRun): void => {
      if (conversationId === undefined) adoptConversation(result.conversation_id, target);
      // agy's result status sticks to the conversation: after a failed turn,
      // the next turn that answers still reports ERROR with the earlier error
      // (observed on agy 1.5.8 after resuming). A turn that produced a
      // response without an `error_message` step of its own did succeed.
      const staleError = result.status === 'ERROR' && Boolean(result.response) && !turnSawErrorStep;
      if (staleError) log(`Turn answered; ignoring the stale ERROR status (${result.error ?? 'no error text'})`);
      const succeeded = result.status === 'SUCCESS' || staleError;
      const settle = (): void => {
        inFlightPrompt = null;
        lastResultFailed = !succeeded;
        respawnedAfterFailure = false;
        // After abort the SIGTERM produces an `interrupted` result; the caller
        // asked for silence, so it is dropped.
        if (!aborted) {
          if (succeeded) buffer.push({ type: 'result', text: result.response || null });
          else failTurn(result);
        }
        pump();
        wake();
      };
      if (succeeded) {
        settle();
        return;
      }
      // agy writes `error:` / `AGY_ERROR:` to stderr just before the stdout
      // result, but the two pipes are read independently. One macrotask lets
      // already-arrived stderr lines land before the error is assembled; the
      // next turn is not written until then either.
      deferredResults += 1;
      setImmediate(() => {
        deferredResults -= 1;
        settle();
      });
    };

    const startRun = (continuation: string | undefined): void => {
      const child = runtime.spawnAgy(antigravityArgs(self.executionPolicy, self.inference, continuation), {
        cwd: input.cwd,
        env: buildAntigravityProcessEnv(process.env),
      });
      const target: AgyRun = {
        child,
        requestedConversation: continuation,
        exited: false,
        exitCode: null,
        exitSignal: null,
        spawnError: null,
        stdinClosed: false,
        contextSent: false,
        killTimer: null,
        exitWaiters: [],
      };
      run = target;
      child.on('error', (err) => {
        log(`[process-error] ${err.message}`);
        target.spawnError = err;
        markExited(target);
      });
      // `close`, not `exit`: it fires after stdout has drained, so every
      // line agy wrote has been handled before the exit is acted on.
      child.on('close', (code, signal) => {
        log(`[exit] code=${code} signal=${signal}`);
        target.exitCode = code;
        target.exitSignal = signal;
        markExited(target);
      });
      // A dead agy closes the pipe under a pending write.
      child.stdin?.on('error', (err) => log(`[stdin] ${err.message}`));
      if (child.stdout) {
        createInterface({ input: child.stdout }).on('line', (line) => {
          if (!line.trim()) return;
          // Liveness on every agy line, whatever it carries.
          buffer.push({ type: 'activity' });
          const event = parseAntigravityLine(line);
          if (!event) log(`[unparsed] ${line.slice(0, 200)}`);
          else if (event.event === 'init') adoptConversation(event.conversation_id, target);
          else if (event.event === 'step_update') {
            if (event.step_update?.step_type === 'error_message') turnSawErrorStep = true;
            const progress = stepProgressMessage(event.step_update);
            if (progress) buffer.push({ type: 'progress', message: progress });
          } else if (event.event === 'result') handleResult(event.result ?? {}, target);
          wake();
        });
      }
      if (child.stderr) {
        createInterface({ input: child.stderr }).on('line', (line) => {
          if (!line.trim()) return;
          log(`[stderr] ${line}`);
          const parsed = parseAntigravityStderrLine(line);
          if (parsed.kind === 'agy-error') lastAgyError = parsed.error;
          else if (parsed.kind === 'error') lastStderrError = parsed.message;
        });
      }
      pump();
    };

    const describeExit = (target: AgyRun): string => {
      const detail = target.spawnError?.message || lastAgyError?.short_error || lastStderrError;
      const how = target.spawnError
        ? 'could not be started'
        : `exited mid-turn (code=${target.exitCode} signal=${target.exitSignal})`;
      return `agy ${how}${detail ? `: ${detail}` : ''}`;
    };

    async function* gen(): AsyncGenerator<ProviderEvent> {
      try {
        // On a contract core the contract's beforeQuery has already written
        // settings.json and mcp_config.json for this query (see
        // antigravityRuntimeOwnership); this is the pre-contract core's path.
        if (!antigravityRuntimeOwnership.contractOwnsRuntimeFiles) {
          runtime.writeRuntimeFiles(self.mcpConfig);
        }
        await runtime.prepareRules(memorySessionHook);
        if (aborted) return;
        startRun(input.continuation);

        while (true) {
          while (buffer.length > 0) {
            if (aborted) return;
            yield buffer.shift()!;
          }
          if (aborted) return;
          const current = run!;
          if (current.exited && deferredResults === 0) {
            const unanswered = inFlightPrompt !== null || pending.length > 0;
            if (!unanswered) {
              if (!ended) log(`agy exited between turns (code=${current.exitCode} signal=${current.exitSignal})`);
              return;
            }
            // agy exits after some failed turns (HTTP 400 → exit 3). Input
            // already queued behind that failure is not lost: resume the
            // conversation in a fresh process, once per failure.
            if (lastResultFailed && !respawnedAfterFailure && !current.spawnError) {
              if (inFlightPrompt !== null) pending.unshift(inFlightPrompt);
              inFlightPrompt = null;
              respawnedAfterFailure = true;
              const resumeFrom = conversationId ?? input.continuation;
              log(`agy exited after a failed turn; resuming ${resumeFrom ?? 'a new conversation'} for queued input`);
              startRun(resumeFrom);
              continue;
            }
            const message = describeExit(current);
            const classification = classifyAntigravityError(message);
            yield {
              type: 'error',
              message,
              retryable: lastAgyError?.retryable === true,
              ...(classification ? { classification } : {}),
            };
            throw new Error(message);
          }
          await new Promise<void>((resolve) => {
            waker = resolve;
          });
        }
      } finally {
        // Never leave agy running past its query, and let it finish shutting
        // down before the next query spawns against the same conversation DB.
        const current = run as AgyRun | null;
        if (current && !current.exited) {
          terminate(current);
          await waitForExit(current, runtime.killGraceMs + 1_000);
        }
        if (current?.killTimer) clearTimeout(current.killTimer);
      }
    }

    return {
      push: (message: string) => {
        if (ended || aborted) return;
        pending.push(message);
        pump();
      },
      end: () => {
        ended = true;
        pump();
        wake();
      },
      abort: () => {
        aborted = true;
        if (run) terminate(run);
        wake();
      },
      events: gen(),
    };
  }
}

// Function-form registration only — the one shape both core generations
// accept. A contract core passes the resolved configuration as the second
// argument; a pre-contract core passes nothing there.
registerProvider(
  'antigravity',
  (opts, configuration?: AntigravityResolvedConfiguration) =>
    new AntigravityProvider(opts, defaultAntigravityRuntimeDeps, configuration),
);
