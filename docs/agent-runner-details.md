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

type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string };

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

## Runtime provider contract

Besides implementing `AgentProvider`, every provider declares a **runtime contract**
(`container/agent-runner/src/provider-contracts/`). The contract is not a description
core reads once and forgets — each field is consumed by core at a specific moment.

What a provider declares:

- `configuration` — `executionPolicy` (mandatory), and optionally `inference`, `memory`,
  `mcpServers`. All four share one shape, `Capability<I>`: either a function
  `(input, env) => answer` of the core-owned input, or a declared constant
  `{ constant: answer }`. **Core calls the functions, not the provider.** `createProvider`
  resolves `executionPolicy`, `inference` and `mcpServers` and passes the result to the
  provider factory as its second argument; `memory` is resolved when core registers the
  memory session hook and passed as the second argument of `registerMemorySessionHook`.
  The core-owned inputs are named types in `provider-contracts/registry.ts` —
  `RuntimeInferenceInput` for `inference`, `RuntimeMemoryHookInput` for `memory`, the
  `McpServerConfig` map for `mcpServers` — and a provider's resolve names them rather
  than restating the shape, so a field core adds reaches every provider through the type.
- `lifecycle` — `memorySessionHookRegistration` (runs when core registers the memory hook)
  and `beforeQuery` (runs before each query).
- `history` — `afterExchange` (the factory wraps `onExchangeComplete` with it) and
  `readTrace` (what `/upload-trace` uploads). Anything else a provider does with its own
  transcript — Claude's pre-compact archive and continuation rotation, for example — is
  provider-internal code (`providers/claude-history.ts`), not a contract field.
- `textDelivery`, `commands` — read by the poll-loop and formatter. The formatter's
  native command lists and `/upload-trace` read the **active** provider's contract only;
  other registered contracts are never consulted.

Registration is **two-step** and order-independent. The provider module calls
`registerProvider(name, factory)`; the contract module calls
`registerProviderContract(name, contract)`. Neither file imports the other, so a
skill-installed provider still compiles on a core that predates the contract seam (the
contract file is simply not imported there). Barrels: `providers/index.ts` and
`provider-contracts/index.ts` — a skill appends one import line to each. Claude and the
test-double `mock` register exactly this way; no provider is special-cased.

A provider without a contract keeps working: the poll-loop falls back to the legacy
instance flags (`supportsNativeSlashCommands`, `emitsMidTurnText`).

Conformance: `provider-contracts/testing/conformance.ts` exports
`defineProviderConformance(name, contract, options?)`, which registers the shape checks and
the "does each function capability respond to its input" probes as `bun:test` cases.
Constants are not probed. When the default probe inputs cannot exercise a function (an
env-gated resolve, say), pass `options.probes` — e.g.
`{ inference: { a, b, environment? } }`. Probe fixtures live with the tests, never on the
contract. Every provider ships `providers/<name>.conformance.test.ts` calling
`defineProviderConformance` for its own contract — Claude and the test-double `mock`
included; no provider is special-cased. Core runs no generic sweep over the registered
contracts: which probe fixtures a contract needs is provider knowledge (a provider whose
inference is environment-provisioned does not vary on `model`, say), so only the provider's
own test file can supply them. The install-time verifier requires the file for every
declared provider. `bun src/provider-contracts/names.ts` lists registered providers and
contracts.

## Provider Implementations

Only the `claude` provider ships in trunk. The Codex and OpenCode sections below document the provider interface for reference and for skills that install additional providers — they are not baked into the core image.

### Claude Provider

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

The provider takes its settings (`mcpServers`, `env`, `additionalDirectories`,
`model`, `effort`, `assistantName`) in its constructor via `ProviderOptions`; `query()`
only reads the per-turn `QueryInput`.

```typescript
class ClaudeProvider implements AgentProvider {
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

### Delivery Modes

Each agent group has a `delivery_mode` in its container config, set with
`ncl groups config update --delivery-mode envelope|tools-only` and materialized
into `container.json` for the runner:

- **`envelope`** (default) — final-text `<message to="name">` blocks deliver;
  other response text is scratchpad. An unwrapped turn is nudged once. This is
  the behavior existing groups had before the setting was added.
- **`tools-only`** — only outbound tool calls such as `send_message`,
  `send_file`, `send_card`, and `ask_user_question` deliver. Envelopes,
  tool-shaped markup, plain prose, and provider error text stay in the
  scratchpad. The system prompt and post-compaction reminder teach this
  contract.

Task runs keep their existing one-door task path in either mode: outbound tools
deliver and final text becomes the run log summary.

For tools-only chat turns, the runner reads delivery from `messages_out`. Each
human-triggered inbound row creates a reply obligation with its full address and
`in_reply_to` id. At each provider result, the runner settles obligations from
new outbound rows, using an exact request stamp first and the destination address
otherwise. It judges only requests whose provider prompt has run, so a follow-up
pushed during an active turn waits for its own result. A dry request gets one
correction; if the correction is also dry, the runner sends a neutral placeholder
to that request's address. Agent-channel wakes receive the same bounded correction
but remain silent after it because they have no human endpoint. Webhook wakes do
not create a reply obligation.

The runner publishes `current_reply_route` and a separate outbound-sequence turn
baseline whenever a queued exchange becomes active. The route keeps tool replies
on the request and thread being answered. The baseline also limits
`send_message` to one plain message per destination per tools-only turn, which
prevents small models from sending several paraphrases after a successful call;
the next user turn receives a fresh budget. Envelope mode keeps the existing
unlimited tool behavior.

This accounting assumes one provider `result` for each pushed prompt. The runner
logs extra results and prompts that end without a result. Tests live in
`delivery-mode.test.ts` and `delivery-mode.followup.test.ts`.

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
  <task from="scheduler" time="Jan 1, 9:00 AM" current_time="Thursday, January 1, 2026 at 9:01 AM">Script output:
  {"data": …}

  Instructions:
  Review open PRs</task>
  ```

  `time` is the occurrence's effective scheduled time (`process_after`, falling
  back to its creation timestamp for legacy rows). `current_time` is generated
  when the task reaches the agent so relative instructions such as "today" stay
  correct after pauses or delayed execution. Both render in the agent group's
  timezone.

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
(`container/agent-runner/src/mailbox/sqlite/connection.ts`): they read the host-written `inbound.db`
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
    to: string,      // destination name (e.g. "family", "worker-1") (required —
                     // the agent always addresses a destination explicitly)
  }
}
```

Implementation: `resolveRouting(to)` looks up the destination. A channel destination gets its
`thread_id` from `resolveDestinationThread` (`db/session-routing.ts`): the thread of the message
being answered (the reply stamp the poll loop publishes in `session_state` at batch start and again at
every turn boundary, since the query stays open and later messages are pushed into it) when that message came from the destination channel; otherwise the latest
`messages_in` row from that channel. The poll loop's `<message to>` deliveries use the same resolver with the batch's routing
context, so all explicit sends thread identically, and a message arriving mid-turn from another
thread cannot pull the reply away. `session_routing.thread_id` is never consulted — it is null for
every session that isn't per-thread. An agent destination always gets a null `thread_id`. The tool
then writes a `messages_out` row with `kind: 'chat'` and content `{ text }`, and returns the new
`seq` as the message id.

#### send_file

Send a file to a named destination (same destination model as `send_message`).

```typescript
{
  name: 'send_file',
  params: {
    path: string,          // file path (relative to /workspace/agent/ or absolute) (required)
    to: string,            // destination name (required)
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

`send_card` and `ask_user_question` go to the chat the session is bound to (`session_routing`), threaded like
`send_message` / `send_file`: `resolveDestinationThread` with the published reply stamp — the
thread of the message being answered, else the chat's latest `messages_in` thread. The bound
`thread_id` is the last resort, when that yields no thread (a per-thread session stays in it).

#### send_card

Send a display card and continue without waiting for a response. `send_card`
supports display content and URL link buttons only; use `ask_user_question` for
callback buttons and choices.

```typescript
{
  name: 'send_card',
  params: {
    card: {                // title/description, text children, URL link actions
      title?: string,
      description?: string,
      children?: (string | { text: string })[],
      actions?: { label: string; url: string; style?: string }[], // 'primary' | 'danger' | 'default'; anything else renders as default
    },
    fallbackText?: string, // plain-text rendering of the card, unrelated to buttons
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat-sdk'` and the card
structure in content. One schema — `LINK_ACTION_SCHEMA` in
`container/agent-runner/src/mcp-tools/interactive.ts` — is both advertised in
the tool's `inputSchema` and compiled once as the validator the handler runs, so
invalid actions are filtered out before the row is written and the reported
dropped count matches what was stored. Every link action needs a non-empty
`label` and a `url` that is a web link — `http://` or `https://`, with a host.
Those are the only schemes every adapter can render as a button, and the agent
does not pick the channel, so the tool promises no more than that: `#`,
`mailto:` and the rest are dropped and the agent is pointed at
`ask_user_question`. The bridge does not re-apply that rule. It drops an action
only when `label` or `url` is not a non-empty string. Any producer can write
this payload. Nested action blocks and callback actions are not supported by
this tool.

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
- **Fixed mount paths:** Host-written `inbound.db` (read-only) at `/workspace/inbound.db` and container-owned `outbound.db` at `/workspace/outbound.db`. Agent group folder at `/workspace/agent/`. The project document is a single composed file at `/workspace/agent/CLAUDE.md`.

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

- MCP servers are local processes or remote Streamable HTTP endpoints managed by the provider via `mcpServers`
- The MCP server binary is shared across providers — same tools, same DB access
- Project-document loading — the host composes `/workspace/agent/CLAUDE.md` and Claude Code loads it via the `project` setting source; the agent-runner contributes only the runtime addendum from `buildSystemPromptAddendum`
- Additional directories discovery (`/workspace/extra/*`)
- Logging via stderr (`[agent-runner] ...`)

## Related Documents

- **[architecture.md](architecture.md)** — High-level architecture (session DB schema, central DB, channel adapters, message flow)
- **[api-details.md](api-details.md)** — Channel adapter interface, message content examples, host delivery logic
