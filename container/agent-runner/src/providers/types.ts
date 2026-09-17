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
  model?: string;
  effort?: string;
  /** Provider-neutral request to remove provider-native web search. */
  webSearchMode?: 'disabled';
  /** Remove provider-native tools; only configured MCP tools remain model-visible. */
  builtinToolMode?: 'mcp-only';
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
      enabledTools?: string[];
      disabledTools?: string[];
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      enabledTools?: string[];
      disabledTools?: string[];
    };

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
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
