# Claude Agent SDK Deep Dive

Notes from reading the type surface of `@anthropic-ai/claude-agent-sdk` to
understand how `query()` works, how nanoclaw drives it (streaming input, hooks,
resume), and where the observable behaviour lives.

**Verified against `@anthropic-ai/claude-agent-sdk@0.3.197`** (`sdk.d.ts`,
`package.json`, `README.md` in the published tarball). This doc began as a
reverse-engineering pass on the minified `0.2.29–0.2.34` bundles; everything
below is now checked against the shipped `.d.ts` declarations. The parts that
were only ever minified-bundle archaeology (internal generator/function names)
have been dropped — see [What changed since the 0.2.x analysis](#what-changed-since-the-02x-analysis)
at the end.

The repo consumer this doc serves is
`container/agent-runner/src/providers/claude.ts` (+ `types.ts`): it calls
`query()` with a push-based `AsyncIterable` prompt, four hook families, an
allow/deny tool policy, and `resume` for session continuation.

## Architecture

```
Agent Runner (claude.ts)
  └── query({ prompt, options }) → SDK (sdk.mjs)
        └── spawns the Claude Code CLI as a child process
              └── Claude API calls, tool execution
              └── Task/Agent tool → spawns subagents
```

The SDK resolves a native Claude Code binary (overridable via
`options.pathToClaudeCodeExecutable`, which nanoclaw sets to `/pnpm/claude`) and
spawns it as a child process. Communication is JSON-lines over the child's
stdin/stdout. The `Transport` / `SpawnOptions` / `SpawnedProcess` interfaces and
the `spawnClaudeCodeProcess` option (for spawning into a VM/container) confirm
this shape from the public types. All the heavy lifting — the agent loop, tool
execution, background tasks, subagent orchestration — runs inside the CLI
subprocess; `query()` is a transport + control-channel wrapper.

`query({ prompt, options })` returns a `Query` object that
`extends AsyncGenerator<SDKMessage, void>`. You iterate it to receive events;
its methods (`interrupt`, `setModel`, `streamInput`, `close`, …) are the control
channel to the running CLI.

```typescript
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

## query() Options

The full `Options` type (`sdk.d.ts` ~line 1256). This surface grew a lot since
0.2.x; the table below covers the members that matter for SDK consumers, with
the ones nanoclaw sets marked ✱.

| Property | Type | Notes |
|----------|------|-------|
| `abortController` | `AbortController` | Cancels the query and tears down resources |
| `additionalDirectories` ✱ | `string[]` | Extra absolute dirs Claude may access |
| `agent` | `string` | Name of an agent (from `agents`/settings) to apply to the *main* thread (`--agent`) |
| `agents` | `Record<string, AgentDefinition>` | Programmatic subagents invoked via the Agent tool |
| `allowedTools` ✱ | `string[]` | Tool names auto-allowed without prompting. `'Skill'` here is deprecated — use `skills` |
| `disallowedTools` ✱ | `string[]` | Tool names removed from the model's context entirely |
| `toolAliases` | `Record<string,string>` | Redirect a model-emitted tool name to another (e.g. `{ Bash: 'mcp__workspace__bash' }`); single-hop |
| `tools` | `string[] \| { type:'preset'; preset:'claude_code' }` | Base set of built-in tools; `[]` disables all |
| `canUseTool` | `CanUseTool` | Per-call permission callback |
| `continue` | `boolean` | Continue the most recent conversation in `cwd`; mutually exclusive with `resume` |
| `cwd` ✱ | `string` | Working directory (default `process.cwd()`) |
| `env` ✱ | `{ [k]: string \| undefined }` | **Replaces** the subprocess env entirely — spread `process.env` yourself if you need `PATH`/`HOME` |
| `executable` / `executableArgs` | `'bun'\|'deno'\|'node'` / `string[]` | JS runtime + extra runtime args |
| `extraArgs` | `Record<string,string\|null>` | Raw extra CLI flags (`null` = boolean flag) |
| `fallbackModel` | `string` | Comma-separated fallback list; primary is re-tried each user turn |
| `enableFileCheckpointing` | `boolean` | Enables `Query.rewindFiles()` |
| `forkSession` | `boolean` | On resume, fork to a new session ID instead of continuing |
| `betas` | `SdkBeta[]` | Beta features (only `'context-1m-2025-08-07'`) |
| `hooks` ✱ | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | Event callbacks |
| `includeHookEvents` | `boolean` | Emit `hook_started`/`hook_progress`/`hook_response` for all hook types |
| `includePartialMessages` | `boolean` | Emit `SDKPartialAssistantMessage` streaming events |
| `forwardSubagentText` | `boolean` | Forward subagent text/thinking (not just tool blocks) with `parent_tool_use_id` |
| `thinking` | `ThinkingConfig` | `{type:'adaptive'}` / `{type:'enabled',budgetTokens}` / `{type:'disabled'}`; supersedes `maxThinkingTokens` |
| `effort` ✱ | `EffortLevel` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` — guides adaptive thinking depth (default `'high'`) |
| `maxThinkingTokens` | `number` | **Deprecated** — use `thinking` |
| `maxTurns` | `number` | Max user↔assistant turns before stopping |
| `maxBudgetUsd` | `number` | Stop with `error_max_budget_usd` when exceeded |
| `mcpServers` ✱ | `Record<string, McpServerConfig>` | MCP server configs |
| `model` ✱ | `string` | e.g. `'claude-sonnet-5'`, `'claude-opus-4-8'` |
| `outputFormat` | `{ type:'json_schema'; schema }` | Structured output |
| `pathToClaudeCodeExecutable` ✱ | `string` | Path to the CLI binary |
| `permissionMode` ✱ | `PermissionMode` | See below |
| `allowDangerouslySkipPermissions` ✱ | `boolean` | **Required** for `permissionMode:'bypassPermissions'` |
| `permissionPromptToolName` | `string` | Route permission prompts through an MCP tool |
| `plugins` | `SdkPluginConfig[]` | Local plugins (`{ type:'local', path }`) |
| `resume` ✱ | `string` | Session ID to resume |
| `sessionId` | `string` | Force a specific session UUID (can't combine with `continue`/`resume` unless `forkSession`) |
| `resumeSessionAt` | `string` | On resume, stop at a given message UUID |
| `sandbox` | `SandboxSettings` | Command-execution isolation |
| `settings` / `managedSettings` | `string \| Settings` | Inline/flag settings layer; policy-tier settings |
| `settingSources` ✱ | `SettingSource[]` | Which filesystem settings to load — **default semantics changed, see below** |
| `skills` | `string[] \| 'all'` | The one place to enable skills (no need to add `'Skill'` to `allowedTools`) |
| `strictMcpConfig` | `boolean` | Use only `mcpServers`/agent MCP; ignore `.mcp.json`, settings, plugins (`--strict-mcp-config`) |
| `systemPrompt` ✱ | `string \| string[] \| { type:'preset'; preset:'claude_code'; append?; excludeDynamicSections? }` | See preset notes below |
| `persistSession` | `boolean` | `false` disables writing/resuming session transcripts |
| `stderr` | `(data:string)=>void` | Subprocess stderr callback |
| `spawnClaudeCodeProcess` | `(o: SpawnOptions)=>SpawnedProcess` | Custom spawn (VM/container/remote) |

Other members exist (`sessionStore`/`sessionStoreFlush`/`loadTimeoutMs` for
external transcript mirroring; `onElicitation`/`onUserDialog`/
`supportedDialogKinds` for MCP elicitation & blocking dialogs; `taskBudget`,
`promptSuggestions`, `agentProgressSummaries`, `toolConfig`, `title`,
`planModeInstructions`, `debug`/`debugFile`) — see `Options` in `sdk.d.ts` for
the exhaustive list.

### PermissionMode

```typescript
type PermissionMode =
  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
// 'dontAsk' — never prompt; deny anything not pre-approved
// 'auto'    — a model classifier approves/denies prompts
```

nanoclaw runs `'bypassPermissions'` + `allowDangerouslySkipPermissions: true`.

### SettingSource — default flipped since 0.2.x

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json (version controlled)
// 'local'   → .claude/settings.local.json (gitignored)
```

**In 0.3.x, when `settingSources` is omitted the SDK loads ALL sources** (matches
CLI defaults). Pass `[]` to disable filesystem settings (isolation mode). Must
include `'project'` to load CLAUDE.md. This inverts the 0.2.x behaviour, where
omitting the option loaded nothing. nanoclaw sets it explicitly to
`['project', 'user', 'local']`, so it is unaffected by the flip — but any code
that relied on "omitted = isolated" is now loading real settings.

### AgentDefinition

```typescript
type AgentDefinition = {
  description: string;        // When to use this agent
  prompt: string;             // Agent's system prompt
  tools?: string[];           // Allowed tools (inherits all if omitted)
  disallowedTools?: string[]; // Explicit deny (mcp__server / mcp__* strip servers)
  model?: string;             // Alias ('opus'/'sonnet'/'haiku'/'fable') or full ID; 'inherit' = main model
  mcpServers?: AgentMcpServerSpec[];
  skills?: string[];          // Preload skills into the agent context
  initialPrompt?: string;     // Auto-submitted first user turn when this is the main-thread agent
  maxTurns?: number;
  criticalSystemReminder_EXPERIMENTAL?: string;
};
```

Note `model` is now a plain `string` (not the fixed alias union from 0.2.x), and
`disallowedTools`/`mcpServers`/`skills`/`initialPrompt`/`maxTurns` are new.

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string,string> }
  | { type: 'sse';  url: string; headers?: Record<string,string> }
  | { type: 'http'; url: string; headers?: Record<string,string> }
  | { type: 'sdk';  name: string; instance: McpServer };  // in-process, non-serializable
```

Each non-sdk variant also accepts `tools?: McpServerToolPolicy[]`,
`timeout?: number` (per-server tool-call wall-clock cap, ms), and
`alwaysLoad?: boolean` (skip tool-search deferral — include all of this server's
tools in the turn-1 prompt).

nanoclaw derives MCP allow patterns from the `mcpServers` map. Server names are
sanitized by the SDK when forming tool prefixes: any char outside `[A-Za-z0-9_-]`
becomes `_`, so the allowlist must mirror that (nanoclaw's `mcpAllowPattern`
does).

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// Enables the 1M-token context window (Sonnet 4 / 4.5).
```

The value is unchanged; the doc comment's model list is now Sonnet-only.

### CanUseTool / PermissionResult

```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;      // path that triggered the request, if any
    decisionReason?: string;   // why the request fired
  }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[]; toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification };
```

`updatedInput` on the allow branch is now optional (it was required in 0.2.x).
nanoclaw does not use `canUseTool` — it gates tools with `allowedTools` /
`disallowedTools` plus a `PreToolUse` hook.

## SDKMessage Types

`query()` yields a much wider union than 0.2.x — 36 members
(`SDKMessage`, `sdk.d.ts` ~line 3727). The ones you actually branch on:

| `type` / `subtype` | Purpose |
|--------------------|---------|
| `system` / `init` | Session initialized: `session_id`, `tools`, `model`, `skills`, `plugins`, `betas`, `claude_code_version` |
| `assistant` | Claude's response (text + tool calls); `parent_tool_use_id` non-null when from a subagent |
| `user` / `user` (replay) | User message; replayed on resume |
| `result` / `success`\|`error_*` | Terminal result of a prompt round (see below) |
| `system` / `compact_boundary` | Context was compacted; carries `compact_metadata` |
| `system` / `task_notification` | Background task completed / failed / stopped |
| `system` / `task_started` \| `task_progress` \| `task_updated` | Background/subagent task lifecycle |
| `system` / `api_retry` | Retryable API error; will retry after a delay |
| `rate_limit_event` | Rate-limit window update — **top-level `type`, not a `system` subtype** |
| `stream_event` (`SDKPartialAssistantMessage`) | Partial streaming (with `includePartialMessages`) |
| `system` / `hook_started` \| `hook_progress` \| `hook_response` | Hook lifecycle (with `includeHookEvents`) |
| `auth_status`, `tool_use_summary`, `permission_denied`, `commands_changed`, `prompt_suggestion`, … | Other lifecycle/informational events |

nanoclaw's provider translates `init`, `result`, `api_retry`,
`rate_limit_event`, `compact_boundary`, and `task_notification`. Note the
`rate_limit_event` shape: it is `{ type: 'rate_limit_event', ... }`, **not**
`{ type: 'system', subtype: 'rate_limit_event' }`.

### SDKResultMessage (`sdk.d.ts` ~line 3971)

```typescript
type SDKResultMessage = SDKResultSuccess | SDKResultError;

type SDKResultSuccess = {
  type: 'result'; subtype: 'success';
  result: string;
  structured_output?: unknown;
  stop_reason: string | null;
  is_error: boolean;
  num_turns: number;
  duration_ms: number; duration_api_ms: number;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  terminal_reason?: TerminalReason;   // why the loop ended (new)
  uuid: UUID; session_id: string;
  // + timing fields: ttft_ms, time_to_request_ms, warm_spare_claimed, …
};

type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns'
         | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // shares the timing/usage/terminal_reason fields above (no `result` string)
};
```

`result` (the final text) exists only on the success variant; error subtypes
carry their text in `errors[]`. nanoclaw surfaces either so a non-retryable
billing/quota error still reaches the user.

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  message: BetaMessage;               // Anthropic beta message shape
  parent_tool_use_id: string | null;  // non-null → from a subagent
  error?: SDKAssistantMessageError;    // 'billing_error' | 'rate_limit' | 'overloaded' | …
  subagent_type?: string;
  task_description?: string;
  supersedes?: UUID[];                 // refusal-fallback supersede
  uuid: UUID; session_id: string; request_id?: string;
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system'; subtype: 'init';
  apiKeySource: ApiKeySource;
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  skills: string[];
  plugins: { name: string; path: string }[];
  agents?: string[];
  betas?: string[];
  output_style: string;
  uuid: UUID; session_id: string;
};
```

### SDKTaskNotificationMessage

```typescript
type SDKTaskNotificationMessage = {
  type: 'system'; subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  uuid: UUID; session_id: string;
};
```

### SDKUserMessage (streaming input)

```typescript
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;              // Anthropic message param
  parent_tool_use_id: string | null;
  session_id?: string;                // now optional
  uuid?: UUID;                        // now optional
  // + isSynthetic?, priority?, shouldQuery?, timestamp?, subagent_type?, …
};
```

nanoclaw pushes minimal `SDKUserMessage`s (`{ type:'user', message:{ role:'user',
content }, parent_tool_use_id:null, session_id:'' }`) — the required fields are
`type`, `message`, `parent_tool_use_id`; `session_id`/`uuid` are optional.

## Turn Behaviour: when the agent stops vs continues

The stop/continue decision lives inside the CLI, not the SDK. The observable
outcomes are surfaced by the result `subtype` and (new in 0.3.x) the
`terminal_reason` field:

```typescript
type TerminalReason =
  'completed' | 'max_turns'
  | 'stop_hook_prevented' | 'hook_stopped' | 'aborted_streaming'
  | 'aborted_tools' | 'tool_deferred' | 'background_requested'
  | 'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long'
  | 'image_error' | 'model_error';
```

Behavioural summary (unchanged in spirit from the 0.2.x analysis, but no longer
tied to internal function names):

| Condition | Outcome |
|-----------|---------|
| Assistant response has `tool_use` blocks | Tools execute; the loop continues |
| Response has NO `tool_use` blocks | The turn ends (`success`, `terminal_reason:'completed'`) |
| `maxTurns` exceeded | `error_max_turns` (`terminal_reason:'max_turns'`) |
| `maxBudgetUsd` exceeded | `error_max_budget_usd` |
| Abort via `abortController` | `aborted_streaming` / `aborted_tools` |
| A `Stop` hook prevents continuation | ends (`terminal_reason:'stop_hook_prevented'`) |

The primary stop condition is still "Claude emitted no tool calls" — a model
decision, not an SDK one.

## Streaming Input: string prompt vs AsyncIterable

`query()`'s `prompt` accepts `string | AsyncIterable<SDKUserMessage>`, and the
choice changes session lifecycle:

- **`prompt: string`** — single-turn. The SDK sends one user message and closes
  the input channel; the CLI shuts down after producing its `result`.
- **`prompt: AsyncIterable<SDKUserMessage>`** — streaming/multi-turn. The input
  channel stays open, so the CLI keeps running: you can push more user messages
  into the iterable while the agent works, background tasks keep running, and
  `task_notification` events continue to flow through the generator. You control
  when the session ends by ending the iterable.

nanoclaw always uses the `AsyncIterable` form. Its `MessageStream` class is a
push-based async iterable: `push(text)` enqueues an `SDKUserMessage`, `end()`
closes it. This is how new inbound messages are streamed into a live session
instead of spawning a fresh CLI per message, and it keeps the CLI alive so
long-running background subagents aren't cut off when the first `result` arrives.

### Lifecycle with background work

Because the input channel stays open, more than one `result` can arrive:

```
1. system/init          → session initialized
2. assistant/user …     → reasoning, tool calls, tool results (incl. spawning subagents)
3. result #1            → first response (capture it)
4. task_notification(s) → background agents complete / fail / stop
5. assistant/user …     → agent continues (processing subagent results)
6. result #2            → follow-up response (capture it)
7. [iterator done]      → CLI closed its output; end of session
```

Every `result` is meaningful — capture each one, not just the first.

> The 0.2.x version of this doc explained the mechanism through minified CLI
> internals (an `isSingleUserTurn` flag, a specific teammate-shutdown prompt).
> Those symbol-level details can't be re-verified from the 0.3.x `.d.ts` and
> have been dropped; the string-vs-iterable *behaviour* above is what the public
> `query()` signature and nanoclaw's usage actually depend on.

## Hook Events

```typescript
type HookEvent =
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch'
  | 'Notification' | 'UserPromptSubmit' | 'UserPromptExpansion'
  | 'SessionStart' | 'SessionEnd' | 'Stop' | 'StopFailure'
  | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'PostCompact'
  | 'PermissionRequest' | 'PermissionDenied' | 'Setup'
  | 'TeammateIdle' | 'TaskCreated' | 'TaskCompleted'
  | 'Elicitation' | 'ElicitationResult' | 'ConfigChange'
  | 'WorktreeCreate' | 'WorktreeRemove' | 'InstructionsLoaded'
  | 'CwdChanged' | 'FileChanged' | 'MessageDisplay';
```

The list roughly doubled since 0.2.x (`PostToolBatch`, `PostCompact`,
`PermissionDenied`, `Setup`, the `Task*`/`Teammate*`/`Worktree*`/`Cwd*`/`File*`
families, etc.). nanoclaw registers `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, and `PreCompact`.

### Hook configuration & return

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // optional tool-name matcher
  hooks: HookCallback[];
  timeout?: number;      // seconds, for all hooks in the matcher (new)
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;

type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  terminalSequence?: string;   // OSC notification escape (new)
  hookSpecificOutput?: /* per-event union, e.g.: */
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow'|'deny'|'ask'|'defer';
        permissionDecisionReason?: string; updatedInput?: Record<string,unknown>;
        additionalContext?: string }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    /* …many more per HookEvent… */;
};
```

nanoclaw's `preToolUseHook` returns `{ decision: 'block', stopReason }` to reject
a disallowed tool, and `{ continue: true }` otherwise — both valid
`SyncHookJSONOutput`.

### BaseHookInput (shared) & subagent hooks

```typescript
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  prompt_id?: string;     // correlates a prompt with its downstream events (new)
  agent_id?: string;      // present only inside a subagent (new)
  agent_type?: string;    // e.g. 'general-purpose' (new)
  effort?: /* reasoning effort for the current turn */;
};

type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse';
  tool_name: string; tool_input: unknown; tool_use_id: string;
};

type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart'; agent_id: string; agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string; agent_type: string; agent_transcript_path: string;
  last_assistant_message?: string;              // new
  background_tasks?: BackgroundTaskSummary[];    // new
  session_crons?: SessionCronSummary[];          // new
};
```

`PreCompactHookInput` (which nanoclaw uses to archive transcripts before
compaction) is `BaseHookInput & { hook_event_name: 'PreCompact'; … }`, so
`transcript_path` and `session_id` are available on it.

## Query interface methods

The `Query` object (`sdk.d.ts` ~line 2204) exposes a large control channel.
Methods marked "streaming input mode only" require the `AsyncIterable` prompt
form nanoclaw uses.

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  // control (streaming input mode only):
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(max: number | null, display?: 'summarized'|'omitted'|null): Promise<void>;
  applyFlagSettings(settings): Promise<void>;
  setMcpServers(servers): Promise<McpSetServersResult>;
  setMcpPermissionModeOverride(server, mode): Promise<{ warning?: string }>;
  reconnectMcpServer(name): Promise<void>;
  toggleMcpServer(name, enabled): Promise<void>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  backgroundTasks(toolUseId?: string): Promise<boolean>;
  rewindFiles(userMessageId, options?): Promise<RewindFilesResult>; // needs enableFileCheckpointing
  seedReadState(path, mtime): Promise<void>;
  close(): void;

  // introspection:
  initializationResult(): Promise<SDKControlInitializeResponse>;
  reinitialize(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  accountInfo(): Promise<AccountInfo>;
  readFile(path, options?): Promise<SDKControlReadFileResponse | null>;
  reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;
  reloadSkills(): Promise<SDKControlReloadSkillsResponse>;
}
```

`streamInput`, `close`, and `setMcpServers` — flagged "internal, not in the docs"
in the 0.2.x notes — are now first-class members of the public `Query` interface.

## Sandbox Configuration

`SandboxSettings` is defined via a Zod schema (`SandboxSettingsSchema`), so the
shape is inferred rather than a literal type. Key fields:

```typescript
type SandboxSettings = {
  enabled?: boolean;
  failIfUnavailable?: boolean;          // defaults true when enabled:true is passed via option
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    allowManagedDomainsOnly?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    allowLocalBinding?: boolean;
    allowMachLookup?: string[];
    httpProxyPort?: number; socksProxyPort?: number;
    tlsTerminate?: { caCertPath?: string; caKeyPath?: string };
  };
  filesystem?: {
    allowWrite?: string[]; denyWrite?: string[];
    allowRead?: string[]; denyRead?: string[];
    allowManagedReadPathsOnly?: boolean;
  };
  credentials?: { files?: {path;mode:'deny'}[]; envVars?: {name;mode:'deny'}[] };
  ignoreViolations?: Record<string, string[]>;
  // + enableWeakerNestedSandbox, allowAppleEvents, ripgrep, bwrapPath, socatPath, …
};
```

`network`/`filesystem` gained explicit domain and path allow/deny lists,
`credentials` blocking, and TLS-terminate config since 0.2.x. When
`allowUnsandboxedCommands` is true the model may set
`dangerouslyDisableSandbox: true` on a Bash call, which falls back to the
`canUseTool` handler. nanoclaw does not use the SDK sandbox (it runs each agent
in its own container).

## MCP Server Helpers

### tool()

Type-safe MCP tool definitions with Zod schemas:

```typescript
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }
): SdkMcpToolDefinition<Schema>;
```

The optional 5th `extras` arg (annotations / `searchHint` / `alwaysLoad`) is new.

### createSdkMcpServer()

In-process MCP server:

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  instructions?: string;                       // surfaced as an MCP instructions block (new)
  tools?: Array<SdkMcpToolDefinition<any>>;
  alwaysLoad?: boolean;                         // (new)
}): McpSdkServerConfigWithInstance;
```

nanoclaw wires its MCP servers as stdio/process servers (via `mcpServers`), not
in-process SDK servers, so subagents inherit them.

## Key Files (in the published tarball)

- `sdk.d.ts` — all type definitions (~6700 lines; was ~1800 in 0.2.x)
- `sdk-tools.d.ts` — tool input schemas
- `sdk.mjs` — SDK runtime (minified)
- `bridge.d.ts` / `browser-sdk.d.ts` / `extractFromBunfs.d.ts` — bridge, browser,
  and compiled-binary-extraction entry points
- `package.json` — `main: sdk.mjs`, `types: sdk.d.ts`
- The native Claude Code CLI binary ships as a separate per-platform package and
  is spawned as the child process.

## What changed since the 0.2.x analysis

Re-verified against 0.3.197. Notable deltas and removals:

- **V2 session API removed.** The `unstable_v2_createSession` / `send` /
  `stream` / `unstable_v2_resumeSession` / `unstable_v2_prompt` surface the
  0.2.x doc described no longer exists. There is no session *object* with
  `send()`/`stream()`. `query()` (with a string or `AsyncIterable` prompt) is the
  single entry point; multi-turn is done by keeping the iterable open. Session
  *management* is now a set of standalone functions instead:
  `listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`,
  `deleteSession`, `renameSession`, `tagSession`, plus a pluggable `SessionStore`
  for external transcript mirroring. The whole "V1 vs V2" comparison section was
  therefore dropped.
- **Minified-identifier tables dropped.** The `sdk.mjs`/`cli.js` symbol tables
  (`EZ`, `s_`, `e_`, `$X`, `XX`, `QX`, `mW1`, `VR`, `g01`, `bd1`, the `BGq`
  shutdown prompt, the `isSingleUserTurn`/`QK` flag, etc.) were reverse-engineered
  from minified bundles and cannot be re-verified from the shipped `.d.ts`. They
  are removed. The *observable* behaviours they explained (string vs iterable
  prompt lifecycle, stop/continue conditions, background-task notifications) are
  kept and re-grounded in the public types.
- **`settingSources` default flipped:** omitted now loads *all* filesystem
  settings (was: none). Pass `[]` for isolation.
- **`PermissionMode`** gained `'dontAsk'` and `'auto'`.
- **`HookEvent`** roughly doubled; **`Options`**, the **`SDKMessage`** union, and
  the **`Query`** interface all grew substantially (effort/thinking config,
  skills, plugins, tool aliases, session stores, structured output, sandbox
  filesystem/network/credentials controls, MCP control methods, …).
- **`SDKAssistantMessage.message`** is now `BetaMessage`; **`SDKUserMessage`**'s
  `session_id`/`uuid` became optional; **`PermissionResult`** allow-branch
  `updatedInput` became optional; result messages gained `stop_reason`,
  `terminal_reason`, and timing fields.
- **Line-number references** were all invalidated by the file more than tripling
  in size; the remaining `sdk.d.ts` line hints are approximate for 0.3.197.

Could not verify (by design): any CLI-internal control flow — it lives in the
minified subprocess, not in the type declarations. Where behaviour matters, this
doc now describes what's observable at the `query()` boundary rather than
internal function structure.
