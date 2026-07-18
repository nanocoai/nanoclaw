# NanoClaw Agent-Runner Details

Implementation-level details for the agent-runner inside the container. See [architecture.md](architecture.md) for the high-level design.

## Separation of Concerns

The agent-runner has two layers:

1. **Agent-runner core** — owns the poll loop, message formatting, DB reads/writes, MCP tool implementations, routing, status management, media handling. This is NanoClaw-specific and shared across all providers.

2. **Agent provider** — owns the SDK interaction. Takes formatted prompts, pushes them to the SDK, yields events back. Trunk ships the `claude` provider; additional providers (OpenCode, Codex, etc.) are installed by `/add-<provider>` skills from the `providers` branch.

The boundary: the agent-runner decides **what** to send and **what to do** with results. The provider decides **how** to talk to the SDK.

## AgentProvider Interface

Provider-wide settings (MCP servers, env, additional directories, model, effort,
assistant name) are passed to the provider **constructor** via `ProviderOptions`, not
per query. `QueryInput` carries only what changes turn to turn: the prompt, the
continuation token to resume, the working directory, and system context to inject.

```typescript
interface AgentProvider {
  /** True if the SDK handles slash commands natively and wants them passed
   *  through raw. When false, the poll-loop formats them like any chat message. */
  readonly supportsNativeSlashCommands: boolean;

  /** Register shared memory through the provider's native session-start mechanism. */
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void;

  /** Optional. Called after each completed exchange so providers whose harness
   *  keeps no on-disk transcript can persist it themselves. Claude (the SDK
   *  writes its own .jsonl) omits this. */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /** True if the error means the stored continuation is invalid (missing
   *  transcript, unknown session) and should be cleared. */
  isSessionInvalid(err: unknown): boolean;

  /** Optional pre-resume maintenance: given the stored continuation, return a
   *  reason string to drop it and start fresh (e.g. transcript too large/old to
   *  cold-resume before the host idle ceiling), or null to keep resuming. */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  model?: string;   // alias (sonnet/opus/haiku) or full model ID
  effort?: string;  // low | medium | high | xhigh | max
}

interface QueryInput {
  /** Initial prompt, already formatted by the agent-runner into a string. */
  prompt: string;

  /** Opaque continuation token from a previous query. The provider decides
   *  what it means (session ID, thread ID, or nothing). */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /** System context to inject; the provider translates it into whatever its
   *  SDK expects (preset append, full system prompt, per-turn injection). */
  systemContext?: { instructions?: string };
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query (e.g., container shutting down). */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null; isError?: boolean }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

### What the interface does NOT include

- **Message formatting** — the agent-runner formats messages before passing to the provider. The provider receives a ready-to-send prompt string.
- **Hooks** — Claude-specific. The Claude provider registers hooks internally (PreToolUse, PostToolUse, PreCompact). Other providers don't need them.
- **Tool allowlists** — Claude uses `allowedTools` + `disallowedTools`. Other SDKs use their own equivalents. Each provider configures this internally.
- **Session persistence** — the agent-runner stores one opaque `continuation` token per provider (see [Session Resume](#session-resume)) and passes it back as `QueryInput.continuation`. What it means is provider-private; Claude persists its own `.jsonl` transcript on disk keyed by the continuation (session ID).
- **Sandbox configuration** — provider-specific. Each provider configures its own sandbox internally.

### Provider event semantics

- **`init`** — emitted once per query when the provider establishes or resumes a session. The agent-runner captures `continuation` and persists it for future resume.
- **`result`** — emitted when the agent produces a complete response. May be emitted multiple times per query (e.g., Claude's multi-turn with subagents). `isError` is set when the SDK flagged the turn as an error (e.g. a non-retryable billing error) so the poll-loop still surfaces the text instead of dropping it. The agent-runner writes each result to messages_out.
- **`error`** — emitted on failure. `retryable` indicates whether the agent-runner should retry. `classification` is optional detail (e.g., 'quota').
- **`progress`** — optional, for logging. The agent-runner logs these but doesn't act on them.
- **`activity`** — a liveness signal. Providers MUST yield it on every underlying SDK event (tool call, thinking, partial message) so the poll-loop's idle timer stays honest during long tool runs.

## Provider Implementations

Only the `claude` provider ships in trunk. The Codex and OpenCode sections below document the provider interface for reference and for skills that install additional providers — they are not baked into the core image.

### Claude Provider

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

The provider takes its settings (`mcpServers`, `env`, `additionalDirectories`,
`model`, `effort`, `assistantName`) in its constructor via `ProviderOptions`; `query()`
only reads the per-turn `QueryInput`.

```typescript
class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;
  // ...constructor stores options.mcpServers, .env, .additionalDirectories,
  //    .model, .effort, .assistantName...

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();  // AsyncIterable<SDKUserMessage>
    stream.push(input.prompt);

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: input.systemContext?.instructions
          ? { type: 'preset', preset: 'claude_code', append: input.systemContext.instructions }
          : undefined,
        // Base tools plus one `mcp__<server>__*` pattern per registered MCP
        // server — without the explicit MCP patterns the SDK's allowedTools
        // filter silently drops every MCP namespace.
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        effort: this.effort,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;
    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      // Abort doesn't call into the SDK — it flips a flag the event generator
      // checks and ends the input stream so the query drains and stops.
      abort: () => { aborted = true; stream.end(); },
      events: translateEvents(sdkResult, () => aborted),
    };
  }
}
```

`translateEvents` is an async generator that yields `{ type: 'activity' }` for **every**
SDK message (so the idle timer stays honest) and maps recognized messages to `ProviderEvent`:
- `system`/`init` → `{ type: 'init', continuation: session_id }`
- `result` → `{ type: 'result', text, isError }` — `text` is `result.result`, or the joined `result.errors[]` on error subtypes (billing/quota), so the notice still reaches the user
- `system`/`api_retry` → `{ type: 'error', retryable: true }`
- `system`/`rate_limit_event` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `system`/`compact_boundary` → `{ type: 'result', text: 'Context compacted…' }`
- `system`/`task_notification` → `{ type: 'progress', message }`
- when the `aborted` flag is set → the generator returns immediately

**Claude-specific behavior inside the provider:**
- `MessageStream` for async iterable input (push-based follow-ups)
- Resume via the SDK `resume` option keyed on the stored `continuation` (the SDK session ID) — no separate resume-at cursor
- `TOOL_ALLOWLIST` (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, Skill, …) extended at the call site with a `mcp__<server>__*` pattern per registered MCP server; `SDK_DISALLOWED_TOOLS` blocks SDK builtins that collide with NanoClaw's own scheduling/interaction model (CronCreate/Delete/List, ScheduleWakeup, AskUserQuestion, Enter/ExitPlanMode, Enter/ExitWorktree)
- **PreToolUse hook** records the current tool + its declared timeout to `container_state` (so the host sweep widens its stuck tolerance while a long Bash runs) and, as defense-in-depth, blocks any `SDK_DISALLOWED_TOOLS` call that slips through. It does **not** sanitize bash env vars — there is no such hook.
- **PostToolUse / PostToolUseFailure** hooks clear the in-flight tool
- **PreCompact** hook archives the transcript to `conversations/` before compaction
- `maybeRotateContinuation` drops an oversized/aged transcript (default caps 12 MB / 14 days, both operator-overridable) so a cold container isn't killed reloading days of `.jsonl` before the host idle ceiling; `isSessionInvalid` clears a continuation whose transcript is gone
- `additionalDirectories` for multi-directory access

### Codex Provider

Wraps `@openai/codex-sdk`.

```typescript
class CodexProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const codex = new Codex(this.buildOptions(input));
    const thread = input.continuation
      ? codex.resumeThread(input.continuation, this.threadOptions(input))
      : codex.startThread(this.threadOptions(input));

    const abortController = new AbortController();
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        // Codex doesn't support streaming input.
        // Store the follow-up and abort the current turn.
        pendingFollowUp = msg;
        abortController.abort();
      },
      end: () => { /* no-op — Codex turns end naturally */ },
      abort: () => abortController.abort(),
      events: this.run(thread, input.prompt, abortController, () => pendingFollowUp),
    };
  }

  private async *run(thread, prompt, abortController, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    let currentPrompt = prompt;

    while (true) {
      try {
        const streamed = await thread.runStreamed(currentPrompt, {
          signal: abortController.signal,
        });

        let continuation: string | undefined;
        let resultText = '';

        for await (const event of streamed.events) {
          if (event.type === 'thread.started') {
            continuation = event.thread_id;
            yield { type: 'init', continuation };
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            resultText = event.item.text || resultText;
          }
          if (event.type === 'turn.failed') {
            yield { type: 'error', message: event.error.message, retryable: false };
            return;
          }
        }

        yield { type: 'result', text: resultText || null };

        // Check if a follow-up was queued during this turn
        const followUp = getPendingFollowUp();
        if (followUp) {
          currentPrompt = followUp;
          // Reset for next iteration
          continue;
        }

        return;
      } catch (err) {
        if (abortController.signal.aborted && getPendingFollowUp()) {
          // Aborted because of follow-up — restart with new prompt
          currentPrompt = getPendingFollowUp();
          abortController = new AbortController();
          continue;
        }
        throw err;
      }
    }
  }
}
```

**Codex-specific behavior inside the provider:**
- `developer_instructions` for system prompt (loaded from CLAUDE.md)
- `git init` in workspace (Codex requires a git repo)
- Abort+restart pattern for follow-up messages
- `sandboxMode`, `approvalPolicy`, `networkAccessEnabled` from env vars
- Conversation archiving (Codex doesn't have PreCompact)

### OpenCode Provider

Wraps `@opencode-ai/sdk`.

```typescript
class OpenCodeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    // OpenCode runs a local server — create it once, reuse across queries
    const { client, server } = await createOpencode({ config: this.buildConfig(input) });
    const { stream } = await client.event.subscribe();

    let aborted = false;
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        pendingFollowUp = msg;
        server.close();  // interrupt current query
      },
      end: () => { /* no-op */ },
      abort: () => { aborted = true; server.close(); },
      events: this.run(client, server, stream, input, () => pendingFollowUp),
    };
  }

  private async *run(client, server, stream, input, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    const session = await client.session.create();
    yield { type: 'init', continuation: session.data.id };

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { parts: [{ type: 'text', text: input.prompt }] },
    });

    for await (const event of stream) {
      if (event.type === 'session.idle') {
        // Collect result text from accumulated message parts
        const resultText = this.extractResult(event);
        yield { type: 'result', text: resultText };

        const followUp = getPendingFollowUp();
        if (followUp) {
          await client.session.promptAsync({
            path: { id: session.data.id },
            body: { parts: [{ type: 'text', text: followUp }] },
          });
          continue;
        }

        return;
      }

      if (event.type === 'session.error') {
        yield { type: 'error', message: event.properties?.error?.data?.message, retryable: false };
        return;
      }
    }
  }
}
```

**OpenCode-specific behavior inside the provider:**
- Local gRPC/HTTP server lifecycle (`server.close()`)
- SSE event stream for output
- Provider/model selection via config (`OPENCODE_PROVIDER`, `OPENCODE_MODEL`)
- MCP config format translation (`type: 'local'`, `command: [cmd, ...args]`, `environment`)
- System prompt injected via `<system>` prefix in prompt text
- No resume support (sessions are always new or reused by ID)

## Agent-Runner Core

Everything below is handled by the agent-runner, not the provider.

### Poll Loop

```
┌─────────────────────────────────────────┐
│                                         │
│  1. Query messages_in for pending rows  │
│     WHERE status = 'pending'            │
│     AND (process_after IS NULL          │
│          OR process_after <= now())     │
│                                         │
│  2. If rows found:                      │
│     a. Set status = 'processing'        │
│     b. Format messages by kind          │
│     c. Strip routing fields             │
│     d. Call provider.query(prompt)      │
│     e. Process provider events          │
│     f. Write results to messages_out    │
│     g. Set status = 'completed'         │
│                                         │
│  3. While query is active:              │
│     - Continue polling messages_in      │
│     - New messages → provider.push()    │
│                                         │
│  4. When query finishes:                │
│     - Back to step 1                    │
│     - If no messages, sleep + re-poll   │
│                                         │
└─────────────────────────────────────────┘
```

**Concurrent polling during active query:** While the provider is running a query, the agent-runner continues polling messages_in on a short interval (~500ms). New pending messages are formatted and pushed into the active query via `provider.push()`. This lets follow-up messages arrive while the agent is processing — Claude handles this natively, Codex/OpenCode handle it via abort+restart internally.

**Idle behavior:** When no messages are pending and no query is active, the agent-runner sleeps briefly (1s) and re-polls. The container stays warm until the host kills it (idle timeout).

**Idle detection exceptions:** The container should NOT be considered idle when:
- An `ask_user_question` tool call is pending (waiting for user response in messages_in)
- The agent is actively working (tool calls in progress, subagents running)

The agent-runner signals "busy" status to the host. The mechanism for this is provider-specific — for Claude, the query AsyncGenerator is still yielding events. For others, the agent-runner can write a heartbeat or status indicator to the session DB that the host checks before killing.

### Message Formatting

The agent-runner transforms messages_in rows into a prompt string. The provider receives a ready-to-send string — it doesn't know about message kinds or routing.

**Routing field stripping:** `platform_id`, `channel_type`, `thread_id` are never included in the prompt. They're stored as context for writing messages_out.

Every kind renders to a single self-contained XML element. The `id` attribute is the
message's `seq` (the agent-facing message ID it passes to `edit_message` / `add_reaction`).
The `from` attribute is the origin destination name (resolved from the routing fields via
the destination map), so the agent always knows where a message came from — routing fields
themselves are never shown.

- **`chat`** — one `<message>` per row:
  ```xml
  <message id="5" from="family" sender="John" time="Jan 1, 10:00 AM">Check this PR</message>
  ```
  A reply carries a `reply_to` attribute and an inline `<quoted_message from="…">…</quoted_message>`.

- **`chat-sdk`** — same `<message>` shape, fields extracted from the serialized Chat SDK
  message. Attachments are appended inline: `[image: screenshot.png — saved to /workspace/…]`
  or `[image: screenshot.png (https://signed-url…)]`. Images/PDFs that Claude handles
  natively are also passed as content blocks (see Media Handling below).

- **`task`** — a `<task>` element, script output first when present:
  ```xml
  <task from="scheduler" time="Jan 1, 9:00 AM">Script output:
  {"data": …}

  Instructions:
  Review open PRs</task>
  ```

- **`webhook`** — a `<webhook>` element wrapping the JSON payload:
  ```xml
  <webhook from="github" source="github" event="pull_request">{"action": "opened", …}</webhook>
  ```

- **`system`** — host action result, rendered as `<system_response>`:
  ```xml
  <system_response from="host" action="create_agent" status="success">{"agent_group_id": "ag-456"}</system_response>
  ```

**Batch formatting:** All pending messages are combined into one prompt. The prompt opens
with a self-closing `<context timezone="<IANA>" />` header (so the agent interprets every
timestamp — and every time it schedules — in the user's zone), then the chat messages
concatenated as consecutive `<message>` blocks, then any task/webhook/system elements,
joined by blank lines:

```xml
<context timezone="America/Los_Angeles" />
<message id="2" from="family" sender="John" time="10:00">Check this PR</message>
<message id="4" from="family" sender="Jane" time="10:01">Already on it</message>
```

There is **no** outer `<messages>` envelope — an earlier revision wrapped multi-message
batches that way, but the Claude Agent SDK answered the wrapped shape with a synthetic
"No response requested." stub instead of calling the API (#2555). Dropping the wrapper made
the single-message path just the N=1 case of the same concatenation.

**Command detection:** Messages starting with `/` are checked against a command list. Recognized commands bypass formatting and are passed raw to the provider (for Claude's slash command handling) or intercepted by the agent-runner (for NanoClaw-level commands like session reset).

### Routing

When the agent-runner picks up messages_in rows, it captures the routing fields from the batch:

```typescript
interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;  // messages_in.id of the triggering message
}
```

When writing messages_out (either from provider results or MCP tool calls), the agent-runner copies this routing context by default. The agent never sees routing fields — it just produces text. The routing is implicit: "respond to whoever sent the message."

MCP tools that target a named destination (`send_message` / `send_file` with a `to`
argument) resolve routing through the session's destination map instead of the default
reply context — including agent-to-agent sends, which are just a `to` pointing at an
`agent`-type destination.

### Status Management

`inbound.db` is a read-only mount inside the container, so the agent-runner never writes
`messages_in`. It tracks processing status in the `processing_ack` table in the
container-owned `outbound.db`; the host reads `processing_ack` and mirrors completion
back onto `messages_in.status`.

```
processing_ack: (no row) → processing → completed
```

- **Pick up:** `INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', now())` for each claimed row (`markProcessing`). Pending queries skip any row already present in `processing_ack`.
- **Complete:** same upsert with `status = 'completed'` (`markCompleted`). Every consumed batch ends here — error outcomes included. On a provider error the poll-loop writes an error **chat message** to `messages_out` (so the user sees it), then still acks the batch completed; errors surface as messages, not as an ack status. (A `markFailed` helper exists in `messages-in.ts` but currently has no callers.)
- The host's `syncProcessingAcks` mirrors acked ids onto `messages_in.status = 'completed'`. Its stale/retry policy is driven off the `.heartbeat` file mtime and the `processing_ack` claim timestamps. On startup the agent-runner clears leftover `processing` acks (crash recovery) so orphaned claims re-process.

### MCP Tools

The agent-runner runs an MCP server (stdio) that exposes NanoClaw tools to the agent. The
tool modules use the same two-DB connection layer as the rest of the runner
(`container/agent-runner/src/db/connection.ts`): they read the host-written `inbound.db`
at `/workspace/inbound.db` **read-only** (destinations, session routing, question
responses, task lists) and write to the container-owned `outbound.db` at
`/workspace/outbound.db`. There is no shared single-file connection and no WAL — both files
are `journal_mode=DELETE` because WAL's memory-mapped `-shm` file does not stay coherent
across the VirtioFS host↔container mount.

#### send_message

Send a chat message to a named destination. Agents address destinations by name, never by
raw platform/channel/thread IDs — the destination map (`destinations` table in `inbound.db`,
written by the host) resolves the name to routing fields.

```typescript
{
  name: 'send_message',
  params: {
    text: string,    // message content (required)
    to?: string,     // destination name (e.g. "family", "worker-1").
                     // Optional when the agent has exactly one destination.
  }
}
```

Implementation: `resolveRouting(to)` looks up the destination. With no `to`, it defaults to
the session's own reply routing (`session_routing`); if the destination resolves to the same
channel the session is bound to, the session's `thread_id` is preserved so the reply lands
in-thread, otherwise `thread_id` is null. The tool then writes a `messages_out` row with
`kind: 'chat'` and content `{ text }`, and returns the new `seq` as the message id.

#### send_file

Send a file to a named destination (same destination model as `send_message`).

```typescript
{
  name: 'send_file',
  params: {
    path: string,          // file path (relative to /workspace/agent/ or absolute) (required)
    to?: string,           // destination name; optional if the agent has one destination
    text?: string,         // optional accompanying message
    filename?: string,     // display name (default: basename of path)
  }
}
```

Implementation:
1. Resolve routing via `resolveRouting(to)` (as `send_message`)
2. Generate a message ID and create `/workspace/outbox/{messageId}/`
3. Copy the file into that outbox directory
4. Write a `messages_out` row (`kind: 'chat'`) with content `{ text, files: [filename] }`

#### send_card

Send a structured card (interactive or display-only).

```typescript
{
  name: 'send_card',
  params: {
    card: CardElement,     // card structure (title, children, actions)
    fallbackText?: string, // text fallback for platforms without card support
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat-sdk'` and the card structure in content.

#### ask_user_question

Send an interactive question and wait for the user's response. This is a **blocking tool call** — the tool doesn't return until the user responds.

```typescript
{
  name: 'ask_user_question',
  params: {
    title: string,         // short card title, e.g. "Confirm deletion"
    question: string,
    options: (string | { label: string; selectedLabel?: string; value?: string })[],
    timeout?: number,      // seconds (default: 300)
  }
}
```

Implementation:
1. Generate a `questionId` and normalize each option to `{ label, selectedLabel, value }`
2. Write a `messages_out` row with `kind: 'chat-sdk'` and content `{ type: 'ask_question', questionId, title, question, options }`
3. Poll `inbound.db` (read-only) for a pending `messages_in` row whose content carries the matching `questionId` (`findQuestionResponse`), skipping any already in `processing_ack`
4. When found, `markCompleted` the response row (a `processing_ack` write in `outbound.db`) and return its `selectedOption` as the tool result
5. If the deadline passes, return a timeout error as the tool result

The agent's execution is paused at this tool call. The provider's query keeps running (Claude holds the tool call open). The agent-runner polls for the response in a separate loop.

#### edit_message

Edit a previously sent message.

```typescript
{
  name: 'edit_message',
  params: {
    messageId: string,     // integer ID as shown to the agent
    text: string,          // new content
  }
}
```

Implementation: write a `messages_out` row with `operation: 'edit'`, the message ID, and new text.

#### add_reaction

Add an emoji reaction to a message.

```typescript
{
  name: 'add_reaction',
  params: {
    messageId: string,     // integer ID as shown to the agent
    emoji: string,         // emoji name (e.g., 'thumbs_up')
  }
}
```

Implementation: write a `messages_out` row with `operation: 'reaction'`.

#### Agent-to-agent sends (no dedicated tool)

There is no `send_to_agent` tool. Agents and channels share one destination namespace, so
messaging another agent is just `send_message(to="<agent-name>")` where the named
destination is of type `agent`. `resolveRouting` maps it to a `messages_out` row with
`channel_type: 'agent'` and `platform_id` set to the target agent group id; the host
validates the send and routes it into the target session's `inbound.db`.

#### ncl tasks

Schedule, inspect, and modify one-shot or recurring tasks.

```bash
ncl tasks create --prompt "..." --process-after "2026-01-15T09:00:00" --recurrence "0 9 * * *"
ncl tasks list
ncl tasks update <series_id> --prompt "..."
ncl tasks cancel <series_id>
```

Implementation: the host writes `messages_in` task rows into the agent group's system session (`thread_id = system:tasks`). The host sweep wakes that system-session container when a task is due. The task agent chooses its destination at fire time by emitting `<message to="name">...</message>` or using `send_message`.

#### create_agent

Create a long-lived companion sub-agent. The `name` becomes a destination the creating
agent can address. (There is no `register_agent_group` tool — this replaced it.)

```typescript
{
  name: 'create_agent',
  params: {
    name: string,           // human-readable name; also the destination name (required)
    instructions?: string,  // CLAUDE.md content for the new agent (role, personality)
  }
}
```

Implementation: fire-and-forget. Writes a `messages_out` row with `kind: 'system'`,
`action: 'create_agent'`, `requestId`, `name`, and `instructions`. The container is
untrusted and does not gate itself; the host authorizes by CLI scope — trusted owner groups
(scope `global`) create directly, confined groups require admin approval
(`src/modules/agent-to-agent/create-agent.ts`) — then creates the entity rows and notifies
the agent via a chat message when the agent is ready.

#### Self-modification: install_packages, add_mcp_server

Two fire-and-forget system-action tools let an agent extend its own runtime (both require
admin approval, applied host-side):

- **`install_packages`** — `{ apt?: string[], npm?: string[], reason?: string }`. Package
  names are validated at the tool boundary and re-validated on the host. On approval the
  host rebuilds the per-agent image and restarts the container.
- **`add_mcp_server`** — `{ name, command, args?, env? }`. Wires an existing third-party MCP
  server into the agent's `container.json`; on approval the host updates the config and
  restarts (no rebuild — Bun runs the TS directly).

Both write a `messages_out` row with `kind: 'system'` and the matching `action`, then return
immediately; the host notifies the agent when approval resolves.

### Media Handling

#### Inbound (messages_in → agent prompt)

The agent-runner inspects attachments in chat/chat-sdk messages and handles them based on type and provider capability:

**Provider-native content blocks:**

| Type | Claude | Codex / OpenCode |
|------|--------|------------------|
| Images (JPEG, PNG, GIF, WebP) | Native image content block | Save to disk |
| PDFs | Native document content block | Save to disk |
| Audio | Native audio content block | Save to disk |
| Other files (code, data, video, archives) | Save to disk | Save to disk |

**"Save to disk"** means: download to `/workspace/downloads/{messageId}/`, reference in the prompt text:

```
<message sender="John" time="10:00">
  Check this spreadsheet
  [file available at: /workspace/downloads/msg-123/data.xlsx]
</message>
```

The agent can use tools (Read, Bash) to access saved files.

For channels where direct download isn't possible (e.g., WhatsApp buffered streams), the channel adapter serves the media via a local URL. The agent-runner downloads from that URL.

**Content block construction (Claude):** The agent-runner builds multi-part `MessageParam` content: `[{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text: '...' }]`. The prompt passed to the provider is not a plain string in this case — the `QueryInput.prompt` field needs to support structured content for Claude. The provider's `query()` method handles the format-specific construction.

**Content block construction (Codex/OpenCode):** Everything is text. File references are inlined in the prompt string. The provider receives a plain string prompt.

#### Outbound (agent → messages_out)

Handled via the `send_file` MCP tool (see above). The agent explicitly decides to send a file — the agent-runner doesn't scan output for file references.

### Pre-Agent Scripts (Tasks)

For `task` kind messages with a `script` field in the content:

1. Agent-runner writes the script to a temp file
2. Executes with `bash` (30s timeout)
3. Parses last line of stdout as JSON: `{ wakeAgent: boolean, data?: unknown }`
4. If `wakeAgent === false`: mark message as completed, don't invoke the provider
5. If `wakeAgent === true`: enrich the prompt with script output, then invoke the provider

### Transcript Archiving

The agent-runner archives conversation transcripts before context compaction. For Claude, this is handled via the PreCompact hook (provider-internal). For other providers that don't have hooks, the agent-runner archives after each query completes based on the provider's output.

Archive location: `/workspace/agent/conversations/{date}-{summary}.md`

### Session Resume

The agent-runner tracks a single opaque `continuation` token per provider:

- Captured from `ProviderEvent { type: 'init', continuation }` and persisted to the
  `session_state` table in `outbound.db` under the key `continuation:<provider>` (keyed per
  provider because a continuation is provider-private — a Claude session id is meaningless to
  another provider).
- Passed back as `QueryInput.continuation` on the next query. For Claude that becomes the
  SDK `resume` option; the SDK reloads its on-disk `.jsonl` transcript for that session id.

Because it lives in the session folder's `outbound.db`, the continuation survives container
teardown and restart — a fresh container reads it back and resumes. `/clear` deletes the row
to start a clean session. Before resuming, `maybeRotateContinuation` may archive and drop an
oversized/aged transcript (so a cold container isn't killed reloading it), and
`isSessionInvalid` clears a continuation whose backing transcript has gone missing.

### Container Startup

The agent-runner receives configuration via:

- **`container.json`:** The provider name, model, assistant name, MCP servers, and other NanoClaw config are read from `/workspace/agent/container.json` (materialized by the host from the `container_configs` table), not from environment variables. See `container/agent-runner/src/config.ts`.
- **Environment variables:** provider-specific vars only (API keys, model overrides), `TZ`.
- **Fixed mount paths:** Host-written `inbound.db` (read-only) at `/workspace/inbound.db` and container-owned `outbound.db` at `/workspace/outbound.db`. Agent group folder at `/workspace/agent/`. System prompt from `/workspace/agent/CLAUDE.md` and `/workspace/global/CLAUDE.md`.

The agent-runner reads config, creates the provider, and enters the poll loop. No stdin, no initial prompt — messages are already in the session DB.

### Provider Factory

```typescript
type ProviderName = 'claude' | string;

function createProvider(name: ProviderName, config: ProviderConfig): AgentProvider {
  // Trunk registers 'claude'; additional providers self-register when installed via skills.
  const factory = providerRegistry.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}`);
  return factory(config);
}
```

The provider name comes from the `provider` key in `/workspace/agent/container.json` (defaulting to `'claude'`), which the host materializes from the `container_configs` table — set it with `ncl groups config update --provider`. It is not an environment variable.

`ProviderConfig` contains provider-specific settings (API keys, model overrides, etc.) passed via environment variables — not via the interface. Each provider reads what it needs from `env`.

## Agent-Runner Properties

- MCP server is a separate Node process spawned by the provider (via `mcpServers` config)
- The MCP server binary is shared across providers — same tools, same DB access
- CLAUDE.md loading (global + per-group) — agent-runner reads and passes as `systemPrompt`
- Additional directories discovery (`/workspace/extra/*`)
- Logging via stderr (`[agent-runner] ...`)

## Related Documents

- **[architecture.md](architecture.md)** — High-level architecture (session DB schema, central DB, channel adapters, message flow)
- **[api-details.md](api-details.md)** — Channel adapter interface, message content examples, host delivery logic
