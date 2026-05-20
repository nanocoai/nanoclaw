export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
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

  /**
   * Per-query reasoning-effort override. When set, takes precedence over the
   * provider's constructor-time `effort`. The poll-loop sets this when a
   * batch contains a heavy-lift command (`/council`, `/build`, `/think`) so
   * that one container can serve both light and heavy turns without
   * burning `max` effort on every reply. If omitted, the provider's default
   * effort applies.
   */
  effortOverride?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

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

/**
 * Per-turn token usage reported by the provider's underlying SDK. The
 * poll-loop reads this off `result` events and surfaces a context-usage
 * line into the next turn's system prompt — same signal Claude Code's
 * "Context: X/Y (Z%)" footer uses, so the agent gets the same self-awareness
 * users have. `totalContextTokens` sums input + cache_read + cache_creation,
 * which approximates the context window's current fill at the moment of the
 * API call. Output tokens are tracked separately for cost telemetry but
 * intentionally excluded from `totalContextTokens` — the next turn re-reads
 * the assistant message from the transcript, where it's already counted
 * under input on the next call.
 */
export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalContextTokens: number;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null; usage?: ContextUsage }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The provider's underlying SDK auto-compacted the conversation context.
   * The poll-loop reacts by injecting a destination reminder back into
   * the live query so the agent doesn't drop `<message to="…">` wrapping
   * after compaction. Distinct from `result` so it doesn't mark the turn
   * completed or get dispatched as a chat message. See qwibitai/nanoclaw#2325.
   */
  | { type: 'compacted'; text: string };
