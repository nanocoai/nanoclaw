# NanoClaw Agent-Runner Details

Implementation-level details for the agent-runner inside the container. See [architecture.md](architecture.md) for the high-level design.

## Separation of Concerns

The agent-runner has two layers:

1. **Agent-runner core** — owns the poll loop, message formatting, DB reads/writes, MCP tool implementations, routing, status management, media handling. This is NanoClaw-specific and shared across all providers.

2. **Agent provider** — owns the SDK interaction. Takes formatted prompts, pushes them to the SDK, yields events back. Trunk ships the `claude` provider; additional providers (OpenCode, Codex, etc.) are installed by `/add-<provider>` skills from the `providers` branch.

The boundary: the agent-runner decides **what** to send and **what to do** with results. The provider decides **how** to talk to the SDK.

## AgentProvider Interface

```typescript
interface AgentProvider {
  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;
}

interface QueryInput {
  /** Initial prompt (already formatted by agent-runner).
   *  String for text-only. ContentBlock[] for multimodal (images, PDFs, audio). */
  prompt: string | ContentBlock[];

  /** Session ID to resume, if any */
  sessionId?: string;

  /** Resume from a specific point in the session (provider-specific, may be ignored) */
  resumeAt?: string;

  /** Working directory inside the container */
  cwd: string;

  /** MCP server configurations (normalized format — provider translates) */
  mcpServers: Record<string, McpServerConfig>;

  /** System prompt / developer instructions */
  systemPrompt?: string;

  /** Environment variables for the SDK process */
  env: Record<string, string | undefined>;

  /** Additional directories the agent can access */
  additionalDirectories?: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentQuery {
  /** Push a follow-up message into the active query */
  push(message: string): void;

  /** Signal that no more input will be sent */
  end(): void;

  /** Output event stream */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query (e.g., container shutting down) */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string };
```

### What the interface does NOT include

- **Message formatting** — the agent-runner formats messages before passing to the provider. The provider receives a ready-to-send prompt string.
- **Hooks** — Claude-specific. The Claude provider registers hooks internally (PreCompact, PreToolUse, etc.). Other providers don't need them.
- **Tool allowlists** — Claude uses `allowedTools`. Codex uses `approvalPolicy`. OpenCode uses `permission`. Each provider configures this internally based on the same intent: "allow everything, no prompting."
- **Session persistence** — Claude persists sessions to disk automatically. Codex and OpenCode manage their own session state. The agent-runner doesn't control this — it just passes `sessionId` and `resumeAt`.
- **Sandbox configuration** — provider-specific. Each provider configures its own sandbox internally.

### Provider event semantics

- **`init`** — emitted once per query when the provider establishes or resumes a session. The agent-runner captures `sessionId` for future resume.
- **`result`** — emitted when the agent produces a complete response. May be emitted multiple times per query (e.g., Claude's multi-turn with subagents). The agent-runner writes each result to messages_out.
- **`error`** — emitted on failure. `retryable` indicates whether the agent-runner should retry. `classification` is optional detail (e.g., 'quota', 'auth', 'transport').
- **`progress`** — optional, for logging. The agent-runner logs these but doesn't act on them.

## Provider Implementations

Only the `claude` provider ships in trunk. The Codex and OpenCode sections below document the provider interface for reference and for skills that install additional providers — they are not baked into the core image.

### Claude Provider

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

```typescript
class ClaudeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();  // AsyncIterable<SDKUserMessage>
    stream.push(input.prompt);

    const sdkQuery = query({
      prompt: stream,
      options: {
        cwd: input.cwd,
        resume: input.sessionId,
        resumeSessionAt: input.resumeAt,
        systemPrompt: input.systemPrompt
          ? { type: 'preset', preset: 'claude_code', append: input.systemPrompt }
          : undefined,
        mcpServers: input.mcpServers,  // already the right shape
        additionalDirectories: input.additionalDirectories,
        env: input.env,
        allowedTools: NANOCLAW_TOOL_ALLOWLIST,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: {
          PreCompact: [{ hooks: [preCompactHook] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [sanitizeBashHook] }],
        },
      },
    });

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      abort: () => sdkQuery.close(),
      events: translateClaudeEvents(sdkQuery),
    };
  }
}
```

`translateClaudeEvents` is an async generator that maps SDK messages to `ProviderEvent`:
- `message.type === 'system' && message.subtype === 'init'` → `{ type: 'init', sessionId }`
- `message.type === 'result'` → `{ type: 'result', text }`
- `message.type === 'system' && message.subtype === 'api_retry'` → `{ type: 'error', retryable: true }`
- `message.type === 'system' && message.subtype === 'rate_limit_event'` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `message.type === 'system' && message.subtype === 'task_notification'` → `{ type: 'progress', message }`
- Everything else → logged, not emitted

**Claude-specific features preserved inside the provider:**
- `MessageStream` for async iterable input (push-based)
- `resumeSessionAt` for resume at specific message UUID
- PreCompact hook for transcript archiving
- PreToolUse hook for sanitizing bash env vars
- Full tool allowlist
- `additionalDirectories` for multi-directory access

### Codex Provider

Wraps `@openai/codex-sdk`.

```typescript
class CodexProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const codex = new Codex(this.buildOptions(input));
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, this.threadOptions(input))
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

        let sessionId: string | undefined;
        let resultText = '';

        for await (const event of streamed.events) {
          if (event.type === 'thread.started') {
            sessionId = event.thread_id;
            yield { type: 'init', sessionId };
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
    yield { type: 'init', sessionId: session.data.id };

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

**Single message formatting by kind:**

- **`chat`** — format into message XML:
  ```xml
  <message sender="John" time="2024-01-01 10:00">
    Check this PR
  </message>
  ```

- **`chat-sdk`** — extract fields from serialized Chat SDK message:
  ```xml
  <message sender="John (john@slack)" time="2024-01-01 10:00">
    Check this PR
    [image: screenshot.png — https://signed-url...]
  </message>
  ```
  Attachments are listed inline. Images/PDFs that Claude handles natively are passed as content blocks (see Media Handling below).

- **`task`** — task prompt, optionally with script output:
  ```
  [SCHEDULED TASK]

  Script output:
  {"data": ...}

  Instructions:
  Review open PRs
  ```

- **`webhook`** — webhook payload:
  ```
  [WEBHOOK: github/pull_request]

  {"action": "opened", "pull_request": {...}}
  ```

- **`system`** — host action result (response to an earlier system request):
  ```
  [SYSTEM RESPONSE]

  Action: register_agent_group
  Status: success
  Result: {"agent_group_id": "ag-456"}
  ```

**Batch formatting:** Multiple pending messages are combined into one prompt:

```xml
<context timezone="America/Los_Angeles">
<messages>
<message sender="John" time="10:00">Check this PR</message>
<message sender="Jane" time="10:01">Already on it</message>
</messages>
```

Mixed kinds (e.g., a chat message + a system response) are combined with clear delimiters. Each section is labeled by kind.

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

MCP tools that target a different destination (e.g., `send_to_agent`, `send_message` with explicit channel) override the routing context for that specific messages_out row.

### Status Management

The agent-runner manages the `status` and `status_changed` fields on messages_in:

```
pending → processing → completed
                    → failed (if provider returns error and max retries exhausted)
```

- **Pick up:** `UPDATE messages_in SET status = 'processing', status_changed = now(), tries = tries + 1 WHERE id IN (...)`
- **Complete:** `UPDATE messages_in SET status = 'completed', status_changed = now() WHERE id IN (...)`
- **Error:** Agent-runner does NOT set `failed` — it leaves the message as `processing`. The host detects stale processing via `status_changed` and handles retry logic (reset to pending with backoff). This keeps retry policy on the host side.

### MCP Tools

The agent-runner runs an MCP server that exposes NanoClaw tools to the agent. All tools write to the session DB.

**DB path:** The MCP server receives the session DB path via environment variable. It opens a second connection to the same SQLite file (WAL mode allows concurrent access).

#### send_message

Send a chat message to the current conversation (or a specified destination).

```typescript
{
  name: 'send_message',
  params: {
    text: string,          // message content
    channel?: string,      // optional: target channel type (default: reply to origin)
    platformId?: string,   // optional: target platform ID
    threadId?: string,     // optional: target thread ID
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat'`. If channel/platformId/threadId are provided, use those as routing. Otherwise, copy from the current routing context.

#### send_file

Send a file to the current conversation.

```typescript
{
  name: 'send_file',
  params: {
    path: string,          // file path (relative to /workspace/agent/ or absolute)
    text?: string,         // optional accompanying message
    filename?: string,     // display name (default: basename of path)
  }
}
```

Implementation:
1. Generate a message ID
2. Create `outbox/{messageId}/` directory
3. Copy the file into the outbox directory
4. Write a `messages_out` row with `files: [filename]` in the content

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
1. Generate a `questionId`
2. Write a `messages_out` row with `operation: 'ask_question'`, the question, options, and questionId
3. Poll `messages_in` for a row with matching `questionId` in content
4. When found, return the `selectedOption` as the tool result
5. If timeout expires, return a timeout error as the tool result

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

#### send_to_agent

Send a message to another agent group.

```typescript
{
  name: 'send_to_agent',
  params: {
    agentGroupId: string,  // target agent group
    text: string,          // message content
    sessionId?: string,    // optional: target specific session
  }
}
```

Implementation: write a `messages_out` row with `channel_type: 'agent'`, `platform_id: agentGroupId`, `thread_id: sessionId`.

#### schedule_task

Schedule a one-shot or recurring task.

```typescript
{
  name: 'schedule_task',
  params: {
    prompt: string,             // task prompt
    processAfter: string,       // ISO timestamp for first run
    recurrence?: string,        // cron expression (optional)
    script?: string,            // pre-agent script (optional)
  }
}
```

Implementation: the container can't write host-owned `inbound.db`, so this writes a `messages_out` row with `kind: 'system'` and `action: 'schedule_task'` (`container/agent-runner/src/mcp-tools/scheduling.ts`). During delivery the host's action handler (`src/modules/scheduling/actions.ts` → `insertTask()` in `src/modules/scheduling/db.ts`) inserts the `kind: 'task'` row into `inbound.db` with `process_after` and optionally `recurrence`. The host sweep picks it up when due.

#### list_tasks

List active scheduled/recurring tasks.

```typescript
{
  name: 'list_tasks',
  params: {}
}
```

Implementation: a read, not a write — the container may read the read-only `inbound.db` mount directly. Returns one row per series (the live pending/paused occurrence): `SELECT series_id AS id, ... FROM messages_in WHERE kind = 'task' AND status IN ('pending','paused') GROUP BY series_id`. See `container/agent-runner/src/mcp-tools/scheduling.ts`.

#### cancel_task / pause_task / resume_task / update_task

Modify a scheduled task.

```typescript
{
  name: 'cancel_task',
  params: { taskId: string }
}
// pause_task: set status = 'paused' (new status value for recurring tasks)
// resume_task: set status = 'pending'
// update_task: merge { prompt?, recurrence?, processAfter?, script? } into the live row
```

Implementation: all four are sent as system actions (`messages_out`, `kind: 'system'`, `action: 'cancel_task' | 'pause_task' | 'resume_task' | 'update_task'`) — the container never writes `inbound.db`. The host's handlers in `src/modules/scheduling/actions.ts` apply the change against `inbound.db` via `src/modules/scheduling/db.ts`: cancel/pause/resume flip status on the live row(s); update_task reads current content, merges supplied fields, and writes back. All four match by `(id = ? OR series_id = ?) AND kind='task' AND status IN ('pending','paused')`, so they reach the live next occurrence of a recurring task even when the agent passes the original (now-completed) id.

#### register_agent_group

Register a new agent group (admin only).

```typescript
{
  name: 'register_agent_group',
  params: {
    name: string,
    folder: string,
    platformId: string,        // messaging group to wire to
    channelType: string,
    triggerRules?: object,
    sessionMode?: 'shared' | 'per-thread',
  }
}
```

Implementation: write a `messages_out` row with `kind: 'system'`, `action: 'register_agent_group'`. The host reads, validates admin permission, creates the entity rows in the central DB, and writes a `system` messages_in response.

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

The agent-runner tracks `sessionId` and `resumeAt` across queries:

- `sessionId` — captured from `ProviderEvent { type: 'init' }`. Passed back to `QueryInput.sessionId` on the next query.
- `resumeAt` — Claude-specific (last assistant message UUID). Stored by the agent-runner, passed to `QueryInput.resumeAt`. Providers that don't support this ignore it.

These are ephemeral to the container's lifetime. When the container is killed and restarted, the host passes the stored `sessionId` from the central DB's sessions table. `resumeAt` is lost on container restart (the provider resumes from the end of the session).

### Container Startup

The agent-runner receives configuration via:

- **`container.json`:** The provider name, model, assistant name, MCP servers, and other NanoClaw config are read from `/workspace/agent/container.json` (materialized by the host from the `container_configs` table), not from environment variables. See `container/agent-runner/src/config.ts`.
- **Environment variables:** provider-specific vars only (API keys, model overrides), `TZ`.
- **Fixed mount paths:** Session DB at `/workspace/session.db`. Agent group folder at `/workspace/agent/`. System prompt from `/workspace/agent/CLAUDE.md` and `/workspace/global/CLAUDE.md`.

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
