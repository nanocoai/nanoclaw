import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /**
   * Optional capability: true when the provider surfaces EVERY assistant text
   * segment as a streamed `text` event before the turn's `result` — so the
   * result text is always a repeat of a segment that already streamed
   * (empirically: the SDK result is exactly the last streamed segment). When
   * declared, mid-turn streaming becomes the SINGLE content door: the
   * poll-loop delivers complete <message> blocks at parse time from the
   * streamed events (assembling blocks split across segments), and the
   * final-result handler never delivers content — error results are
   * surfaced, and a turn that delivered nothing while its result still
   * carries content gets the wrap-nudge so the retry streams through the
   * mid-turn door. Providers that omit this (or set false) keep the single
   * result-door delivery path: text events are delivery-inert and blocks in
   * the final result text are delivered from there.
   */
  readonly emitsMidTurnText?: boolean;

  /** Register shared memory through the provider's native session-start mechanism. */
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * implementation lives with the provider, never in the runner.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export type McpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /**
       * Container-side root of the plugin this server shipped in, recorded by
       * the host at stamp time. Consumed (and stripped) by plugin-mcp.ts,
       * which expands ${PLUGIN_ROOT}/${PLUGIN_DATA} and injects both env vars
       * before the config reaches a provider.
       */
      pluginRoot?: string;
      /**
       * Working directory for the server process. By the time a provider sees
       * it, plugin-mcp.ts has resolved it to an absolute container path.
       * A provider whose runtime cannot set a spawn directory must shim it
       * (cwd-shim.ts) or drop it — never launch in the wrong directory.
       */
      cwd?: string;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   */
  | { type: 'result'; text: string | null; isError?: boolean }
  /**
   * An assistant text segment emitted mid-turn (e.g. between tool calls).
   * The SDK's final `result` carries only the LAST assistant text, so a
   * complete <message to="..."> block composed before a trailing tool call
   * never reaches the result event. For providers declaring
   * `emitsMidTurnText`, the poll-loop scans these segments for closed
   * message blocks and delivers them as they are emitted (chat runs only,
   * with cross-segment assembly of split blocks); the final result never
   * delivers content — repeats are inert there, and an undelivered turn
   * gets the wrap-nudge instead.
   */
  | { type: 'text'; text: string }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
