# NanoClaw Architecture (Draft)

> **Draft — design intent, not a line-by-line spec.** Some passages predate the current implementation and can drift from it. The root [CLAUDE.md](../CLAUDE.md) and the cited source files (`src/`, `container/agent-runner/src/`) are the source of truth; when this doc and the code disagree, trust the code. Notably, scheduling MCP tools do **not** write `inbound.db` directly — they emit `messages_out` system actions that the host applies (see [agent-runner-details.md](agent-runner-details.md) and `src/modules/scheduling/`).

## Core Idea

Each agent session has a **pair** of mounted SQLite DBs. They are the one and only IO
mechanism between host and container. No IPC files, no stdin piping. `inbound.db` carries
host → agent-runner messages (`messages_in`); `outbound.db` carries agent-runner → host
messages (`messages_out`) plus the container's processing acks. Everything is a message.

The split exists so each file has exactly one writer: the host writes `inbound.db` (the
container opens it read-only) and the container writes `outbound.db` (the host opens it
read-only). One writer per file means no cross-process lock contention over the
host↔container mount. Both files run `journal_mode=DELETE`, **not** WAL: WAL's memory-mapped
`-shm` coherency does not propagate across VirtioFS, so a WAL reader in the guest would
freeze on an early snapshot and never see new host writes.

## Two-Level DB

**Central DB (host process):**
- Agent groups, conversations, routing tables
- Maps platform IDs → agent groups → sessions
- Channel adapters don't touch this directly — the host does the lookup

**Per-session DBs (mounted into container):**
- `inbound.db` → `messages_in` (written by host, read-only in container) plus host-written
  lookup tables the container reads live: `destinations`, `session_routing`, `delivered`
- `outbound.db` → `messages_out` (written by agent-runner, read by host) plus
  `processing_ack`, `session_state`, and `container_state` (all container-owned)
- Everything is a message: chat, tasks, webhooks, system actions, agent-to-agent — all use
  `messages_in` / `messages_out`
- One pair per session, not per agent group

## Agent Groups vs Sessions

An agent group has its own filesystem — folder, CLAUDE.md, skills, container config. Multiple sessions can share the same agent group (same filesystem, same skills) but each session gets its own `inbound.db`/`outbound.db` pair mounted at known paths. Each session = a separate container with the same agent group's filesystem but a different DB pair.

## Message Flow

```
Platform event
  → Channel adapter (trigger check, ID extraction)
  → Returns: { platformChannelId, platformThreadId, triggered }
  → Host maps platformChannelId + platformThreadId → agent group + session
  → Host writes messages_in row to the session's inbound.db
  → Host calls wakeUpAgent(session)
  → Container spins up (or is already running)
  → Agent-runner polls inbound.db (read-only), finds new messages
  → Agent-runner processes with the configured provider
  → Agent-runner writes response to messages_out in outbound.db
  → Host polls active sessions' outbound.db for responses
  → Host reads response, looks up conversation, delivers through channel adapter
```

## Channel Adapters

Channel adapters are responsible for:
1. Receiving platform events (webhooks, polling, websockets — platform-specific)
2. **Filtering**: deciding which messages to forward to the host for processing. This can be stateless (regex trigger match) or stateful (e.g., "was the bot mentioned in this thread at some point? If so, forward all subsequent messages"). The adapter receives a stream of unfiltered platform messages and decides which ones to pass on. How it decides is an implementation detail — NanoClaw doesn't know or care.
3. Extracting and standardizing two IDs:
   - **Platform channel ID** — identifies the conversation (WhatsApp group, Slack channel, email thread)
   - **Platform thread ID** — optional sub-context (Slack thread, GitHub PR comment thread)
4. Outbound delivery — sending responses back to the platform

The channel adapter does NOT know about agent group IDs or session IDs. It returns platform-level identifiers. The host maps those to the entity model.

The two-level ID scheme (channel ID + thread ID) gives flexibility:
- Want every Slack thread to be a separate session? Return unique thread IDs.
- Want all messages in a Slack channel to share a session? Return the same thread ID (or null).
- This is configured per-channel, not globally.

### Channel Adapter Configuration

Adapters are stateless — they receive config from the host at setup time, not from the DB directly.

**What lives in code (per channel type, doesn't change at runtime):**
- Auto-registration behavior (enabled/disabled, how it works)
- Sender allowlist rules
- Whether allowlisted senders can auto-register groups
- Platform-specific connection and message handling

These are decisions made when setting up the channel adapter. Change them = change the code.

**What lives in the DB (per group, varies group to group):**
- Which agent group handles it
- Trigger / filter rules (regex, @mention-only, exclude certain senders, etc.)
- Response scope (respond to all messages vs only triggered/allowlisted)
- Session mode (shared vs per-thread)

The host reads per-group config from the DB and passes it to the adapter at setup. If config changes at runtime (admin agent registers a new group, changes a trigger), the host calls the adapter's update method.

### Auto-Registration

When the adapter forwards a message from an unknown group, the host needs to decide whether to create the group and a session for it.

**The adapter controls whether to forward unknown messages** — based on its code-level auto-registration rules (sender allowlist, group-add detection, etc.). If the adapter forwards it, the host creates the group + session.

**Session creation for known groups:**
- Shared session mode: host finds the existing session or creates one if it's the first message
- Per-thread session mode: host looks up by threadId. If no session exists for this thread, auto-creates one with the same agent group

**The code-level rules are channel-specific:**
- WhatsApp: if an allowlisted number adds the bot to a group → auto-register. If an unknown number DMs → depends on the adapter's configuration.
- Email: if the sender is known → auto-register the thread. If unknown → drop.
- Slack: if someone @mentions the bot in a new channel → adapter decides whether to forward based on its rules.

No `channel_configs` table — channel-type-level behavior is baked into the adapter code.

### Chat SDK Integration

Chat SDK adapters are wrapped per-channel:
- Each Chat SDK adapter gets its own Chat instance
- Concurrency mode is configured per-channel (concurrent for chat, queue for tasks, debounce for webhooks)
- A bridge wraps the Chat instance + adapter to conform to NanoClaw's standard channel interface
- Chat SDK handles: webhook parsing, dedup, message history, platform API calls, rich content delivery
- NanoClaw handles: routing, agent lifecycle, session management

**Chat SDK's subscription model:**

Chat SDK has its own thread-level subscription concept (distinct from NanoClaw's channel-level registration):
- `onNewMention` / `onNewMessage(regex)` — fires on first contact (e.g., @mention in a Slack thread)
- `thread.subscribe()` — opts into all future messages in that thread
- `onSubscribedMessage` — fires for all messages in subscribed threads

This is sub-channel granularity. NanoClaw registers at the channel level ("listen to this Discord channel"). Chat SDK subscribes at the thread level ("track this specific Slack thread"). The bridge lets Chat SDK manage its own subscriptions internally — NanoClaw doesn't interfere with or replicate this.

**Platform capability differences:**

Capabilities vary significantly across adapters (see [Chat SDK adapter docs](https://chat-sdk.dev/docs/adapters)):
- **Slack**: Full rich content (Block Kit cards, modals, streaming, reactions, ephemeral messages)
- **Discord**: Embeds, buttons, streaming via post+edit
- **WhatsApp (Cloud API)**: DMs only, interactive reply buttons, no streaming, no reactions
- **GitHub/Linear**: Markdown comments, no interactive elements
- **Telegram**: Inline keyboard buttons, streaming via post+edit

The host/bridge handles graceful degradation — if an agent posts a card on a platform that doesn't support cards, it falls back to text.

Non-Chat-SDK channels (WhatsApp via Baileys, Gmail, custom integrations) implement the NanoClaw channel interface directly — no bridge, no Chat SDK types.

## Container Lifecycle

The host is an orchestrator:
1. **Spawn** — when wakeUpAgent is called and no container exists for the session
2. **Idle kill** — when a container has no unprocessed messages for some timeout period

When a container spins up, the agent-runner immediately starts polling `inbound.db`. Messages are already there waiting.

## Media Handling

### Inbound

Media is not downloaded by the host. Instead:
- Messages include download URLs (signed URLs where possible)
- Agent-runner downloads and processes media inside the container
- For channels where signed URLs don't work (e.g., WhatsApp with buffered streams), the channel adapter downloads the media and serves it via a local URL/server that the container can access

**Native content blocks (provider-dependent):**

The agent-runner detects file types and passes supported types as native content blocks where the provider supports it:

| Type | Claude | Codex | OpenCode |
|------|--------|-------|----------|
| Images (JPEG, PNG, GIF, WebP) | Native image content block | Save to disk, reference in prompt | Save to disk, reference in prompt |
| PDFs | Native document content block | Save to disk | Save to disk |
| Audio | Native audio content block | Save to disk | Save to disk |
| Other files (code, data, video, archives) | Save to disk | Save to disk | Save to disk |

"Save to disk" means downloaded to `/workspace/downloads/{messageId}/` and referenced in the prompt text as an available file path. The agent can use tools (Read, Bash) to access it.

The agent-runner builds the prompt differently per provider. For Claude, it constructs multi-part `MessageParam` content with image/document blocks. For Codex/OpenCode, everything is text with file path references.

### Outbound

Outbound file delivery is tool-based. The agent calls a tool (e.g., `send_file`) with a file path. The agent-runner moves the file to the outbox and writes the messages_out row.

```
/workspace/
  outbox/
    {message_id}/        ← one dir per messages_out row
      chart.png
      report.pdf
```

messages_out content references filenames only:

```json
{ "text": "Here's the chart", "files": ["chart.png", "report.pdf"] }
```

No paths in the DB — the convention is the contract. The host reads files from `outbox/{message_id}/` in the mounted session folder and delivers them via the adapter (Chat SDK `FileUpload` with buffer data, or platform-specific upload for native channels). Host cleans up the outbox directory after successful delivery.

Outbound files use a dedicated `send_file` MCP tool (separate from `send_message`). See [agent-runner-details.md](agent-runner-details.md) for the tool interface.

### Message Deduplication

Dedup is the channel adapter's responsibility. Chat SDK handles this internally. Native adapters track platform message IDs as needed. The host does not deduplicate — if the adapter forwards it, the host writes it.

## Session DB Schema

Split across the two files. JSON blobs for content — schema-free, format varies by `kind`.
`seq` is a global ordering counter with a **disjoint parity**: the host writes even seqs to
`messages_in`, the container writes odd seqs to `messages_out`. Each side reads the other's
MAX(seq) to pick its next value, so seq is a single monotonic message id across both tables —
which is why the agent-facing message id it returns from `send_message` (and accepts in
`edit_message` / `add_reaction`) is unambiguous.

```sql
-- inbound.db — host writes, container opens read-only
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,     -- even (host-assigned)
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',  -- host-owned; the host mirrors the container's
                                          -- processing_ack terminal states onto this column
  process_after  TEXT,               -- ISO timestamp. NULL = process immediately.
  recurrence     TEXT,               -- cron expression. NULL = one-shot.
  series_id      TEXT,               -- groups a recurring task's occurrences
  tries          INTEGER DEFAULT 0,  -- number of processing attempts
  trigger        INTEGER NOT NULL DEFAULT 1,  -- 0 = accumulated context (don't wake), 1 = wake
  platform_id    TEXT,               -- routing (stripped before the agent sees content)
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,      -- JSON blob (structure depends on kind)
  source_session_id TEXT,            -- a2a return path: source session that emitted the trigger
  on_wake        INTEGER NOT NULL DEFAULT 0  -- 1 = only deliver on a container's first poll
);

-- outbound.db — container writes, host opens read-only
CREATE TABLE messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,     -- odd (container-assigned)
  in_reply_to    TEXT,              -- references messages_in.id (optional)
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,              -- ISO timestamp. NULL = deliver immediately.
  recurrence     TEXT,              -- cron expression. NULL = one-shot.
  kind           TEXT NOT NULL,     -- copied from messages_in by default
  platform_id    TEXT,              -- routing (default: copied from messages_in)
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL      -- JSON blob (format matches kind)
);

-- outbound.db — container's processing status (it can't write inbound.db).
-- Host reads this to drive the message lifecycle; stale 'processing' rows are
-- cleared on container startup (crash recovery).
CREATE TABLE processing_ack (
  message_id     TEXT PRIMARY KEY,  -- references messages_in.id
  status         TEXT NOT NULL,     -- 'processing' | 'completed' | 'failed'
  status_changed TEXT NOT NULL
);
```

Delivery is tracked host-side in a `delivered` table in `inbound.db` (not a column on
`messages_out`, which the host can't write). `inbound.db` also holds the host-written
`destinations` and `session_routing` tables the container reads live; `outbound.db` also
holds `session_state` (the resume continuation, per provider) and `container_state`
(current tool in flight).

### Scheduling

One-shot and recurring tasks use the same tables — no separate scheduler.

**One-shot:** `process_after` (inbound) or `deliver_after` (outbound) with `recurrence = NULL`.

**Recurring:** Same, plus a `recurrence` cron expression. After the host marks a row as handled/delivered, if `recurrence` is set, it inserts a new row with `process_after`/`deliver_after` advanced to the next cron occurrence. Next time is computed from the scheduled time (not wall clock) to prevent drift.

**Host sweep** (every ~60s across all sessions):
- `inbound.db` → `messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now())` → wake agent
- A `processing_ack` (in `outbound.db`) whose claim, or the `.heartbeat` mtime, is older than the stale threshold → stale detection, increment tries, reschedule `process_after` with backoff
- `outbound.db` → due `messages_out` rows not yet in the host's `delivered` table (in `inbound.db`) → deliver
- After completing/delivering a row with `recurrence`, insert next occurrence

**Active container poll** (~1s) checks the same conditions but only for sessions with running containers.

**Agent-runner creates schedules** by emitting a `messages_out` row with `kind: 'system'` and an `action` (`schedule_task`, `cancel_task`, …) — it cannot write host-owned `inbound.db` directly. The host applies the action during delivery (`src/modules/scheduling/actions.ts`), inserting/updating the `kind: 'task'` `messages_in` row with `process_after` and optionally `recurrence`.

### messages_in content by kind

**`chat`** — simple NanoClaw format. Any channel can produce this.
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Check this PR",
  "attachments": [{ "type": "image", "url": "https://signed-url..." }],
  "isFromMe": false
}
```

**`chat-sdk`** — full Chat SDK `SerializedMessage`, passed through from bridge adapter. Includes `author`, `text`, `formatted` (mdast AST), `attachments`, `isMention`, `links`, `metadata`.

**`task`** — scheduled task firing.
```json
{ "prompt": "Review open PRs", "script": "scripts/review.sh" }
```

**`webhook`** — raw webhook payload.
```json
{ "source": "github", "event": "pull_request", "payload": { ... } }
```

**`system`** — host action result (response to a system action the agent requested).
```json
{ "action": "register_group", "status": "success", "result": { "agent_group_id": "ag-456" } }
```

### messages_out content by kind

Output `kind` determines the format and delivery adapter. Default: agent-runner copies `kind` and routing fields from the messages_in row it's responding to.

**`chat`** — simple NanoClaw format. NanoClaw channel delivers via `sendMessage(text)`.
```json
{ "text": "LGTM, merging now" }
```

**`chat-sdk`** — Chat SDK `AdapterPostableMessage`. Bridge adapter delivers via `thread.post()`. Can be markdown, card, or raw — adapter handles platform conversion.
```json
{ "markdown": "## Review\n**LGTM**", "attachments": [...] }
```
```json
{ "card": { "type": "card", "title": "Review", "children": [...] }, "fallbackText": "..." }
```

**`task`** — task result. Host logs and optionally notifies.
```json
{ "result": "3 PRs reviewed", "status": "success" }
```

**`webhook`** — webhook response. Host sends HTTP response or notifies.
```json
{ "response": { "status": 200, "body": { ... } } }
```

**`system`** — host action request (register group, reset session, etc.). Host reads, validates permissions, executes, writes result back as a `system` messages_in row.
```json
{ "action": "reset_session", "payload": { "session_id": "sess-123" } }
```

### Interactive Operations (Cards, Reactions, Edits)

All interactive operations flow through messages_in/out — the DB is the only IO boundary for the container. The agent uses MCP tools; the agent-runner translates tool calls into structured messages_out rows; the host delivers through the appropriate adapter method.

**Cards with user interaction (e.g., "Ask User Question"):**

1. Agent calls `ask_user_question` tool with question + options
2. Agent-runner writes messages_out with the question card
3. Host delivers as interactive card through adapter (e.g., Slack Block Kit buttons)
4. User clicks an option
5. Platform sends event back to adapter → host writes messages_in with the response
6. Agent-runner reads messages_in, matches to pending tool call, returns selection to agent as tool result

The agent-runner holds the tool call open while waiting for the user's response in messages_in. The round-trip goes: agent → messages_out → host → platform → user clicks → platform → host → messages_in → agent-runner → agent.

**Approvals:**

Two patterns, both handled at the host level:
- **Implicit**: Agent calls a tool that requires approval. Host intercepts, sends approval card to admin, waits for response, then executes or rejects. The agent doesn't know about the approval step.
- **Explicit**: Agent explicitly requests approval via a tool. Agent-runner writes the approval request to messages_out. Same flow as "ask user question" — response comes back through messages_in.

In both cases, the approval and action execution happen on the host side, not the agent side.

**Approval routing:** Privilege is a user-level concept. `user_roles` records `owner` (global only — first user to pair becomes owner) and `admin` (global or scoped to a specific `agent_group_id`). When an action requires approval, `pickApprover(agentGroupId)` returns candidates in order: scoped admins for that agent group → global admins → owners (deduplicated). `pickApprovalDelivery` then takes the first candidate reachable via `ensureUserDm` (with a same-channel-kind tie-break so a Discord approval request prefers a Discord-using approver). The approval card lands in the approver's DM messaging group, not the origin chat. Delivery is resolved through the Chat SDK's `openDM` for resolution-required channels (Discord/Slack/…) or the user's handle directly for direct-addressable channels (Telegram/WhatsApp/…), and the mapping is cached in `user_dms` for subsequent requests. See `src/modules/permissions/access.ts` and `src/modules/permissions/user-dm.ts` (`ensureUserDm`); the approver-picking primitives live in `src/modules/approvals/primitive.ts`.

**Editing a sent message:**

Agent calls an `edit_message` tool with the message ID and new content. Agent-runner writes messages_out with an edit operation. Host calls `adapter.editMessage()`. Messages in the agent's context include integer IDs so the agent can reference them.

**Reactions:**

Agent calls `add_reaction` tool with message ID and emoji. Agent-runner writes messages_out with a reaction operation. Host calls `adapter.addReaction()`.

**Operations in messages_out content:**

```json
// Normal message (default)
{ "text": "LGTM" }

// Interactive card
{ "operation": "ask_question", "title": "Deploy", "question": "Approve deployment?", "options": ["Yes", "No", "Defer"] }

// Edit existing message
{ "operation": "edit", "messageId": "3", "text": "Updated: LGTM with minor comments" }

// Reaction
{ "operation": "reaction", "messageId": "5", "emoji": "thumbs_up" }
```

The host reads the `operation` field (if present) and calls the right adapter method. No operation field = normal message delivery. Platform capabilities vary — the host/bridge handles graceful degradation (e.g., reaction on a platform that doesn't support it → skip or send as text).

### Agent-to-Agent Communication

Sending a message to another agent uses the same routing fields as channel delivery. The agent-runner sets `channel_type: 'agent'` and `platform_id` to the target agent group ID. Optionally, `thread_id` can target a specific session (null = find or create the default session).

From the sending agent's perspective, it's the same mechanism as sending to Slack or WhatsApp — just a messages_out row with different routing. The host reads it, checks that this agent group has permission to message the target, resolves the target session, and writes a messages_in row to that session's DB.

```json
// messages_out routing fields
{ "kind": "chat", "channel_type": "agent", "platform_id": "pr-worker", "thread_id": null }
// messages_out content
{ "text": "Reset your session and re-review", "sender": "Supervisor", "senderId": "agent:pr-admin" }
```

The receiving agent gets a normal chat message. It doesn't need to know the source is another agent unless that's relevant context.

### Routing

**Default behavior:** Agent-runner copies routing fields (`kind`, `platform_id`, `channel_type`, `thread_id`) from the messages_in row to messages_out. Response goes back where it came from.

**Host validation:** Before delivering, the host checks that this agent group is permitted to send to the destination. The agent-runner copies routing; the host validates.

**Multi-destination pattern (customization):** An agent may need to send to a different channel than the origin (e.g., a webhook triggers a Slack notification). This is supported via custom code, not built into the core:

1. Add a `destinations` table to the session DB mapping logical names to routing fields
2. Populate it from the host when setting up the session
3. Modify the agent's prompt to list available destinations
4. Agent chooses a destination by name; agent-runner resolves to routing fields
5. Host validates as usual

This is documented as a pattern, not a built-in feature.

## Core Properties
- Container isolation via filesystem mounts
- Credential proxy (OneCLI)
- Per-agent-group workspace (folder, CLAUDE.md, skills)
- Polling-based (not event-driven)
- Per-agent-group agent-runner recompilation on container startup (agent can modify its own source, request rebuild/restart, changes persist across teardowns)
- Host ↔ container IO through mounted session DBs (`messages_in` / `messages_out`) — no stdin piping, no IPC files
- Agent commands are `messages_out` rows with `kind: 'system'`
- Agent-to-agent supported via target-agent routing on `messages_out`
- Scheduling uses `process_after` / `deliver_after` + `recurrence` on the same message tables
- Media via signed URLs, downloaded in the container
- Channel adapters use the Chat SDK bridge + a standard interface (trunk ships only the bridge/registry; platform adapters install via `/add-<channel>` skills)
- Routing: channel adapter extracts IDs, host maps to entities
- Concurrency: Chat SDK per-channel + container limits
- Session scoping: per-session DB, multiple sessions per agent group

## Design Decisions

**Session DB location:** Not in the agent group folder. Separate directory (e.g., `sessions/{session_id}/`). Each session gets its own folder containing `inbound.db`, `outbound.db`, and — when using the claude provider — the SDK's `.claude/` directory. The session identity IS the folder. The SDK's resume token (session id) is persisted in `outbound.db`'s `session_state` table, so a fresh container picks the conversation back up without the host tracking it centrally.

**Container mount structure:**

```
/workspace/                 ← mount: session folder (read-write)
  .claude/                  ← Claude SDK session data / transcripts (auto-created)
  inbound.db                ← host writes, container reads (opened read-only)
  outbound.db               ← container writes, host reads (opened read-only)
  .heartbeat                ← container touches this; host watches its mtime
  outbox/                   ← agent-runner writes outbound files here
  agent/                    ← mount: agent group folder (nested, read-write)
    CLAUDE.md               ← agent instructions
    skills/                 ← agent skills
    ... working files
```

Two directory mounts: session folder at `/workspace`, agent group folder at `/workspace/agent/`. The agent-runner CDs into `/workspace/agent/` to run the agent. Claude SDK writes `.claude/` at `/workspace/.claude/` (root of the workspace).

The runtime is Docker (`src/container-runtime.ts` hardcodes the `docker` binary); nested bind mounts make this layout straightforward. The layout deliberately sticks to directory mounts (no file-level mounts) so it stays portable to runtimes that only support directory mounts.

**Cross-mount DB access:** The two files exist precisely so each has a single writer — the
host writes `inbound.db`, the container writes `outbound.db` — which removes writer
contention across the mount. Both files use `journal_mode=DELETE`, **not** WAL: WAL keeps its
index in a memory-mapped `-shm` file, and VirtioFS does not propagate that mmap coherency
from host to guest, so a WAL reader in the container would freeze on an early snapshot and
silently never see new host writes. Readers that must see fresh host writes promptly (the
`messages_in` poll) open `inbound.db` with `mmap_size = 0` to bypass SQLite's page cache.

**Session management:** Host-managed. The host creates session folders and mounts them. The container only sees its own session folder.

**Session creation (no race condition):**

1. Message arrives, host checks central DB for a session matching this group + thread
2. No session exists → host atomically creates session row in central DB, creates the session folder, creates the session DB, writes the message
3. More messages arrive before container starts → host finds the existing session, writes to the same session DB
4. Container starts, mounts the folder, agent-runner finds messages waiting

The central DB session row creation is the serialization point. No provider session ID to coordinate — the SDK discovers its own session data in `.claude/` when the agent runs.

**System actions:** The agent uses MCP tools (register group, reset session, schedule task, etc.). The agent-runner handles these tool calls and writes a structured, deterministic messages_out row with `kind: 'system'`. This is not natural language — it's a programmatic, structured payload that the host processes deterministically. Host validates permissions, executes, and writes the result back as a `system` messages_in row.

**Container lifecycle:** No warm pool. Containers are spawned on demand (wakeUpAgent) and torn down from the outside by the host when idle. Existing idle detection + teardown mechanism carries over.

## Operational Behavior

### Output Delivery

NanoClaw does not stream tokens to users. The provider's query interface yields complete results, but a result's text is not delivered as-is: the agent-runner parses it for `<message to="name">...</message>` blocks (`dispatchResultText` in poll-loop.ts) and writes one messages_out row per block, addressed to that destination with its thread context resolved per destination. Everything outside a block — including `<internal>...</internal>` — is scratchpad: logged, never sent. A block naming an unknown destination is dropped into the scratchpad log.

If a result produced text but no valid block, the agent-runner pushes a one-time `<system>` nudge into the live turn asking the agent to re-wrap its response. The exception is a non-retryable error result (e.g. a billing error) with no envelope, which is delivered as an error notice instead of being dropped as scratchpad. Mid-turn interim updates go out through the `send_message` MCP tool; the final-text envelope parsing is how a turn's reply reaches the user. The host delivers complete messages_out rows to channels.

Message editing is supported as an explicit operation (agent calls an `edit_message` tool), not as a streaming mechanism.

Typing indicators: host sets typing when a container is active for a session, clears when the container exits or a response appears in messages_out.

### Message Batching

When multiple messages arrive while the container is down, they accumulate as `status = 'pending'` rows in `messages_in`. When the container wakes up, the agent-runner reads all pending messages (those not yet in `processing_ack`) and processes them as a batch — formatted as a `<context timezone="…" />` header followed by the messages concatenated as consecutive `<message>` blocks. (There is no `<messages>` wrapper element; see [agent-runner-details.md](agent-runner-details.md#message-formatting).)

### Message Lifecycle

```
messages_in.status:   pending ──────────► completed (mirrored from ack)
                              └─────────► failed (host-set, retries exhausted)
processing_ack.status:         processing → completed
```

Because `inbound.db` is read-only in the container, the agent-runner never mutates
`messages_in.status`. It records lifecycle in `processing_ack` (in `outbound.db`); the host
reads that and mirrors completion back.

- **pending**: Host writes the `messages_in` row. Ready to be picked up (if `process_after` is null or past).
- **processing**: Agent-runner upserts a `processing_ack` row (`status = 'processing'`) when it claims the message. Subsequent polls skip any id already in `processing_ack`, so it isn't re-picked.
- **completed**: Agent-runner sets `processing_ack.status = 'completed'` for **every** consumed batch, error outcomes included — a provider error is surfaced to the user as an error chat message in `messages_out`, then the batch is still acked completed. The host's `syncProcessingAcks` copies it onto `messages_in.status`.
- **failed**: Set by the **host** (sweep's `markMessageFailed`) when retries are exhausted — never by the container.

**Liveness / stale detection**: The container touches a `/workspace/.heartbeat` file rather
than writing the DB. The host sweep watches that mtime (widening its tolerance when
`container_state` shows a long-declared Bash running) to decide a container has crashed, then
increments `tries` and reschedules `process_after` with exponential backoff. On the next
container startup, leftover `processing` acks are cleared so orphaned claims re-process.

### Error Handling and Retries

Retries use `process_after` with exponential backoff. Each retry increments `tries` and pushes `process_after` further out:

- Try 1: immediate
- Try 2: +5s
- Try 3: +10s
- Try 4: +20s
- Try 5: +40s
- After max retries: status set to `failed`

The host computes this — not the agent-runner. When the host detects a stale `processing` message or the container exits with an error, it increments `tries`, computes the next `process_after`, and resets status to `pending`.

**Output-sent protection**: If messages_out already has delivered rows for a batch, don't retry (prevents duplicate messages to user).

### Host Polling

Two tiers:
- **Active containers (~1s)**: Poll session DBs for new messages_out rows to deliver
- **All sessions (~60s)**: Sweep all session DBs for due `process_after` / `deliver_after` timestamps, handle recurrence

## Flexibility Model

The architecture is **flexible for code changes, not configurable for everything**. Advanced setups (like the PR Factory below) use custom routing logic and host-side hooks — not database config columns.

### Code Structure for Skill Customization

NanoClaw is customized via skills — branches that get merged into the user's installation. Different skills add different capabilities (channels, integrations, behaviors). The code must be structured so that:

1. **Different customizations don't conflict.** Adding Slack and adding Telegram should not produce merge conflicts. Adding a new MCP tool should not conflict with adding a channel. Each type of customization should touch its own file(s).

2. **Core blocks of functionality are in separate files.** Channel registration, message formatting, MCP tools, routing logic, container management — each in its own file. A skill that changes how messages are formatted doesn't touch the file that handles container spawning.

3. **The index file is thin.** It wires things together (init DB, start adapters, start poll loops) but contains no business logic. All logic lives in purpose-specific modules that skills can modify independently.

4. **Don't over-split.** A simple change (e.g., adding a new message kind) shouldn't require edits across 5 files. Group related logic together. The goal is that each skill touches 1-2 files for its core change.

5. **Registration patterns over switch statements.** Channels, MCP tools, and providers should use registration/plugin patterns. A skill adds a channel by adding a file and a registration call — not by editing a central switch statement alongside every other channel.

**Practical example:** Adding a new channel via skill should require:
- One new file (the channel adapter or Chat SDK config)
- One line in the barrel file (`channels/index.ts`) to import the self-registering module
- Zero changes to routing, formatting, delivery, or container code

### Conflict Hotspots and Solutions

Analysis of 33 skill branches shows these files cause the most merge conflicts:

| Hotspot | Why it conflicts | Solution |
|-----------|-----------------|-------------|
| `src/index.ts` (2000 LOC) | Every skill patches the main loop, imports, init logic | Thin index that wires modules. Logic lives in purpose-specific files (router, delivery, session-manager, host-sweep). |
| `src/config.ts` | Every skill adds env vars to a central file | Config declared where it's used. Each module reads its own env vars. No central config registry that every skill edits. |
| `src/container-runner.ts` | Channel skills add mounts, env vars, credential setup | Declarative mount registration. Channels declare their mounts in their own file. Container runner reads from a registry, not a hardcoded list. |
| `src/db.ts` (750 LOC) | Schema, migrations, and all CRUD in one file | Split by entity. Numbered migrations. Skills add a migration file + edit one entity file. |
| `container/agent-runner/src/index.ts` | Agent protocol, IPC handling, formatting all in one file | Split into poll-loop, formatter, providers/, mcp-tools/. Session DB replaces IPC. |
| `src/ipc.ts` | Every MCP tool addition patches one file | `mcp-tools/` directory with barrel. Skills add a tool file + barrel line. |
| `src/channels/index.ts` | Every channel adds an import line at the same location | Barrel file with comment slots per channel (current pattern works, keep it). |

**Mount registration pattern:** Instead of every channel skill editing `buildVolumeMounts()`, channels declare mounts that the container runner collects:

```typescript
// channels/gmail.ts
registerChannel('gmail', {
  factory: createGmailAdapter,
  mounts: [
    { hostPath: '~/.gmail-mcp', containerPath: '/home/node/.gmail-mcp', readonly: false }
  ],
  env: ['GMAIL_OAUTH_TOKEN'],
});
```

The container runner reads registered mounts from the channel registry — no need to edit `container-runner.ts`.

**Config pattern:** Skills don't patch `config.ts` or `.env.example`. Skill-specific env vars are documented in the skill's SKILL.md — the setup process reads those instructions. Each module reads its own env vars directly:

```typescript
// channels/discord.ts
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// channels/gmail.ts  
const GMAIL_CREDS = process.env.GMAIL_CREDENTIALS_PATH;
```

Shared config (DATA_DIR, TIMEZONE) stays in `config.ts`. Channel/skill-specific config stays in the module that uses it.

### Code Style

**Line width: 120 characters.** Most statements fit on one line without sacrificing readability.

**Concise logging.** A thin wrapper keeps every log call on one line:

```typescript
log.info('IPC message sent', { chatJid, sourceGroup });
log.warn('Unauthorized IPC attempt', { chatJid });
log.error('Error processing', { file, err });
```

### DB File Structure

The DB layer is split by entity rather than kept in one monolithic file:

```
src/db/
  connection.ts              ← singleton, init, WAL mode
  schema.ts                  ← CREATE TABLE statements (current state, for reference)
  migrations/
    index.ts                 ← runner: checks version, applies pending
    001-initial.ts           ← initial schema
    002-pending-questions.ts ← example: adds pending_questions table
    ...                      ← skills append new numbered files
  agent-groups.ts            ← CRUD for agent_groups
  messaging-groups.ts        ← CRUD for messaging_groups + messaging_group_agents
  sessions.ts                ← CRUD for sessions + pending_questions
  index.ts                   ← barrel: re-exports everything
```

**Principles:**
- **Split by entity, not by layer.** Each entity file has its own CRUD functions (~50-100 lines). A skill that adds a column to messaging_groups edits `messaging-groups.ts` — doesn't touch sessions or agent groups.
- **Schema as current state + migrations as history.** `schema.ts` documents what the DB looks like now (read this to understand the schema). Migrations are append-only numbered files that describe how we got here.
- **No inline ALTER TABLE.** A migration runner with a `schema_version` table replaces `try { ALTER TABLE } catch { /* exists */ }` blocks. On startup, it checks the current version and applies pending migrations in order. Each migration is a function: `(db: Database) => void`.
- **Skills add migrations.** A skill that needs a new column adds a new numbered migration file. No conflicts with other skills' migrations as long as numbers don't collide (use timestamps or high-enough numbers for skill branches).

**Agent-runner session DBs** use the same pattern but lighter — no migrations needed since the DB files are created fresh by the host:

```
container/agent-runner/src/db/
  connection.ts          ← open inbound.db (read-only) + outbound.db (DELETE mode) at fixed paths
  messages-in.ts         ← read pending from inbound.db, ack via processing_ack in outbound.db
  messages-out.ts        ← write results/outbox rows to outbound.db (odd seq)
  session-state.ts       ← resume continuation, keyed per provider
  session-routing.ts     ← read the host-written default reply routing
  index.ts               ← barrel
```

### What the base architecture must support primitively

These are the building blocks. None require special abstractions — they fall out of per-session DBs, host-managed routing, and messages_out with `kind: 'system'`:

1. **Multiple agent groups on the same channel with content-based routing.** Different messages in the same thread can route to different agent groups based on content (e.g., @mention routes to supervisor, normal messages route to worker). The channel adapter's routing logic — custom code — decides.

2. **Per-thread sessions from a shared agent group.** Multiple sessions share the same agent group (filesystem, skills, CLAUDE.md) but each gets its own session DB. Standard for worker pools.

3. **Session reset and replay.** Create a new session for the same thread. Mark old messages as unhandled so the poll picks them up again. Old output stays visible in the platform (e.g., Discord thread) for comparison. This is an action an agent can request — not automatic.

4. **Cross-session read access.** Some agents can query other sessions' data. Different access levels: manager sees messages_in/messages_out (review content). Supervisor sees full internals (agent logs, tool calls, debug traces). This is just filesystem/DB access — mount or query the right paths.

5. **Context duplication into new sessions.** When a supervisor is invoked in a worker's thread, a new session is created with relevant messages copied in. Custom host-side code handles this.

6. **Agent-initiated host actions.** The agent uses MCP tools (reset session, update skills, etc.). The agent-runner handles the tool call and writes a structured `system` messages_out row. The host reads and executes with permission checks. The agent can request, but the host decides.

### Example: PR Factory

Three agent groups, one Discord channel (PR Factory), plus an admin channel:

| Role | Agent Group | Where | Session model |
|------|-------------|-------|---------------|
| **Worker** | pr-worker | PR Factory threads | One session per thread (per PR) |
| **Manager** | pr-manager | PR Factory channel | Single session, queries across worker sessions |
| **Supervisor** | pr-admin | Admin channel + PR Factory (when @tagged) | Main session in admin channel; per-thread session when invoked in worker threads |

**Worker flow:** GitHub PR → Discord thread → worker agent reviews (triage, review, test plan). Each thread gets a session from the shared pr-worker group.

**Feedback flow:** User @tags supervisor in worker threads → custom routing sends to supervisor with a new session containing the thread's messages (duplicated). Supervisor collects feedback to filesystem. Worker doesn't see supervisor messages.

**Iteration flow:** User discusses feedback with supervisor in admin channel → supervisor suggests skill changes (shown as rich card with diff) → user approves → supervisor applies changes via host action → supervisor requests session reset + replay → workers re-review same PRs with updated skills in same threads but fresh sessions → user compares reviews side by side.

**Manager flow:** User talks to manager in PR Factory main channel (not in threads). Manager can search across all worker session DBs (messages_in/messages_out) to answer questions like "how many PRs today?" or "what topics are trending?" Can request actions (close PR, re-open).

**What's custom code vs. base architecture:**

| Capability | Base architecture | Custom code (PR Factory) |
|-----------|-------------------|-------------------------|
| Per-thread sessions | ✓ platformThreadId → session | |
| Shared agent group across sessions | ✓ Multiple sessions, one group | |
| Writing messages to session DB | ✓ Standard flow | |
| @mention routing to different agent | | ✓ Channel adapter routing logic |
| Context duplication into supervisor session | | ✓ Host-side hook on supervisor invocation |
| Session reset + replay | ✓ Primitives (new session, mark unhandled) | ✓ Supervisor action triggers it |
| Skill updates | ✓ Filesystem writes | ✓ Supervisor action applies changes |
| Cross-session queries | ✓ DB/filesystem access | ✓ Manager's tools know where to look |
| Rich card output | ✓ Structured output in messages_out | |

## Central DB Schema

The central DB handles routing and entity management. All content and execution state lives in per-session DBs.

```sql
-- Agent workspaces: folder, skills, CLAUDE.md, container config
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,              -- default for sessions (null = system default)
  created_at       TEXT NOT NULL
);
-- Container config is NOT a column here — it lives in a separate container_configs
-- table (migration 014), keyed by agent_group_id, with columns: provider, model,
-- effort, image_tag, assistant_name, max_messages_per_prompt, cli_scope, and JSON
-- columns skills / mcp_servers / packages_apt / packages_npm / additional_mounts.
-- The host materializes it into /workspace/agent/container.json for the container.

-- Platform groups/channels (WhatsApp group, Slack channel, Discord channel, email thread, etc.)
-- One row per chat PER ADAPTER INSTANCE. instance defaults to channel_type
-- (the "default instance"), so single-instance installs never see it.
CREATE TABLE messaging_groups (
  id                     TEXT PRIMARY KEY,
  channel_type           TEXT NOT NULL,     -- 'whatsapp', 'slack', 'discord', 'telegram', 'email'
  platform_id            TEXT NOT NULL,     -- platform-specific ID (JID, channel ID, etc.)
  instance               TEXT NOT NULL,     -- adapter-instance name; default = channel_type
  name                   TEXT,
  is_group               INTEGER DEFAULT 0,
  unknown_sender_policy  TEXT NOT NULL DEFAULT 'strict',  -- 'strict' | 'request_approval' | 'public'
  created_at             TEXT NOT NULL,
  denied_at              TEXT,
  UNIQUE(channel_type, platform_id, instance)
);

-- Users (messaging platform identities, namespaced "<channel_type>:<handle>")
CREATE TABLE users (
  id           TEXT PRIMARY KEY,   -- e.g. 'telegram:123456', 'discord:1470...'
  kind         TEXT NOT NULL,      -- mirrors the channel_type prefix
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Roles (owner is global only; admin can be global or scoped to an agent_group)
CREATE TABLE user_roles (
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,   -- 'owner' | 'admin'
  agent_group_id  TEXT REFERENCES agent_groups(id),  -- NULL for global
  granted_by      TEXT,
  granted_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
-- owner rows must have agent_group_id = NULL (enforced in db/user-roles.ts)

-- Membership (explicit non-privileged access; admin/owner imply membership)
CREATE TABLE agent_group_members (
  user_id         TEXT NOT NULL REFERENCES users(id),
  agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
  added_by        TEXT,
  added_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- DM resolution cache (so cold DMs aren't re-resolved every time)
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Which agent groups handle which messaging groups, with what rules.
-- The opaque trigger_rules JSON + response_scope enum were replaced (migration
-- 010) by four orthogonal axes:
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',  -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,                             -- regex; required for engage_mode='pattern'
                                                           -- ('.' = match every message, the "always" flavor)
  sender_scope           TEXT NOT NULL DEFAULT 'all',      -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',     -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',            -- 'shared' | 'per-thread'
  priority               INTEGER DEFAULT 0,                -- higher = checked first when multiple agents match
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Sessions: one folder = one session = one container when running
-- Folder path is derived: sessions/{agent_group_id}/{session_id}/
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),  -- null for internal/spawned sessions
  thread_id          TEXT,              -- platform thread ID (null for shared session mode)
  agent_provider     TEXT,              -- override per session (null = inherit from agent_group)
  status             TEXT DEFAULT 'active',    -- 'active' | 'closed'
  container_status   TEXT DEFAULT 'stopped',   -- 'running' | 'idle' | 'stopped'
  last_active        TEXT,              -- last message activity timestamp
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Pending interactive questions (cards waiting for user response)
-- Host writes when delivering a question card, deletes when response received
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,     -- the messages_out row that sent the card
  platform_id    TEXT,              -- where the card was delivered
  channel_type   TEXT,
  thread_id      TEXT,
  created_at     TEXT NOT NULL
);
```

### Pending Question Flow

When the host delivers a messages_out row with `operation: 'ask_question'`:
1. Host delivers the card via the channel adapter
2. Host writes a `pending_questions` row mapping `question_id` → `session_id`

When a Chat SDK `ActionEvent` (button click) arrives:
1. Bridge extracts `actionId` from the event
2. Host looks up `pending_questions` by `question_id` (derived from actionId — the bridge maintains the mapping)
3. Host finds the target session, writes a messages_in row with `questionId` + `selectedOption`
4. Host deletes the `pending_questions` row
5. Agent-runner picks up the messages_in row, matches to the pending tool call, returns the selection

This avoids scanning session DBs. The central DB is the routing lookup — same pattern as message routing.

Also used for host-generated approval cards: when the host sends an approval request to the admin's DM, it writes a `pending_questions` row. The admin's response is routed back to the originating session.

### Container lifecycle states

```
stopped → running → idle → stopped
                  ↗
            idle → running (new message while warm)
```

- **stopped**: No container. Swept at 60s for due scheduled messages.
- **running**: Actively processing. Polled at 1s for messages_out.
- **idle**: Done processing, container still warm (up to 30 min timeout). Polled at 1s so new messages are picked up quickly.
- After idle timeout → host kills container → stopped.

## Agent-Runner Architecture

The agent-runner is the process inside the container. It mediates between the session DB and the agent provider — polling for work, formatting messages for the agent, translating tool calls into DB rows, and managing the agent lifecycle.

### IO Model

All IO goes through the session DB. No stdin, no stdout markers, no IPC files.

- Initial input and follow-ups: poll `messages_in`
- Output: write `messages_out` rows
- MCP tools: write DB rows (no IPC files)
- Shutdown: host kills the container on idle timeout, or the agent-runner exits when there's no pending work

### Poll Loop

1. Query `inbound.db` (read-only) for `messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now())`, skipping any id already in `processing_ack`
2. If rows found: upsert `processing_ack` rows with `status = 'processing'` in `outbound.db` (the container can't write `messages_in`)
3. Batch messages into a single prompt (strip routing fields, format by kind)
4. Push into the provider's input stream
5. Process agent output → write `messages_out` rows
6. Set the processed ids' `processing_ack.status = 'completed'` (the host mirrors that onto `messages_in.status`)
7. Back to step 1. If no messages found, sleep briefly and re-poll (container stays warm for idle timeout)

### Message Formatting by Kind

Agent-runner strips routing fields (`platform_id`, `channel_type`, `thread_id`) before formatting. The agent never sees routing info — it only sees content.

- **`chat`** — format into a `<message id="…" from="…" sender="…" time="…">` element
- **`chat-sdk`** — extract text, author, attachments from serialized message; same `<message>` element
- **`task`** — format as a `<task from="…" time="…">` element (script output first if present). Run pre-script if present.
- **`webhook`** — format as a `<webhook source="…" event="…">` element wrapping the JSON payload
- **`system`** — host action results, formatted as `<system_response action="…" status="…">`, not chat

Mixed batches (e.g., a chat message + a system result both pending) are combined into one prompt with clear delimiters.

### MCP Tools

MCP tools write to the container's own `outbound.db`. Anything that needs a change in host-owned `inbound.db` (schedule/cancel/pause/resume/update a task, create an agent, self-modify) is emitted as a `kind: 'system'` `messages_out` action that the host applies during delivery — the container never writes `inbound.db`.

**Messaging & interaction:**

| Tool | What it does |
|------|-------------|
| `send_message` | Resolve `to` (destination name) → routing, write `messages_out` row, `kind: 'chat'`. Omit `to` to reply in place. Also the agent-to-agent path: a `to` naming an `agent`-type destination. |
| `send_file` | Copy file to `outbox/{msg_id}/`, write `messages_out` (`kind: 'chat'`) with filenames, same `to` resolution |
| `send_card` | Write `messages_out`, `kind: 'chat-sdk'`, content `{ type: 'card', … }` |
| `ask_user_question` | Write `messages_out` (`kind: 'chat-sdk'`, `type: 'ask_question'`). Hold tool call open, poll `inbound.db` for the response matching `questionId`. Return selection as tool result. |
| `edit_message` | Write `messages_out` with `operation: 'edit'` (targets the original message's destination) |
| `add_reaction` | Write `messages_out` with `operation: 'reaction'` |

(There is no `send_to_agent` tool — agent-to-agent is `send_message` to an `agent` destination.)

**Scheduling**: scheduled-task management is not an MCP surface — it lives on
`ncl tasks` (create/list/get/update/cancel/pause/resume/run/append-log). Due
task rows live in the agent group's system session and are woken by the host
sweep.

**Central-DB / self-modification** (`kind: 'system'` actions; host authorizes, often via admin approval):

| Tool | What it does |
|------|-------------|
| `create_agent` | `action: 'create_agent'` (name + instructions); host creates the agent group (replaces the old `register_agent_group`) |
| `install_packages` | `action: 'install_packages'`; on approval host rebuilds the per-agent image and restarts |
| `add_mcp_server` | `action: 'add_mcp_server'`; on approval host updates `container.json` and restarts |

See [agent-runner-details.md](agent-runner-details.md) for full MCP tool parameter definitions.

### Cards

**Agent-initiated (outbound):** Tool-based. Agent calls `ask_user_question` (interactive card with options) or `send_card` (structured card). Agent-runner writes the card structure to messages_out. Host/adapter handles platform-specific rendering (Slack Block Kit, Discord embeds, Telegram inline keyboard, text fallback).

**Host-initiated (approval cards):** When an action requires approval, the host generates a standardized approval card and sends it to the admin's DM. These are not agent-initiated — the agent doesn't know about the approval step. The card format is fixed (action description + approve/deny buttons).

**Inbound (card responses):** Not a card — it's a messages_in row with `questionId` + `selectedOption` in the content. Agent-runner matches to the pending `ask_user_question` tool call and returns the selection as the tool result.

### Commands

Messages starting with `/` are checked against three lists:

**Whitelisted commands (pass-through to agent):**
- Standard slash commands that the agent provider handles natively (e.g., Claude's built-in commands)
- Passed raw, no `<messages>` XML wrapping

**Admin-only commands (require admin sender):**
- `/remote-control` — remote control session
- `/clear` — clear session context
- `/compact` — force context compaction
- If sent by a non-admin user, the command is rejected with an error message. Not forwarded to the agent.

**Filtered commands (dropped entirely):**
- Commands that don't make sense in the NanoClaw context or could cause issues
- Silently dropped — no error, no forwarding

The command lists are hardcoded in the agent-runner. Admin verification happens host-side before the message ever reaches the container: `src/command-gate.ts` queries `user_roles` (owner / global admin / scoped-admin-of-this-agent-group) and either passes the message through, drops it, or routes it elsewhere. The container has no notion of admin identity — no env var, no DB query, no per-message check.

### Recurring Tasks

The agent-runner processes recurring task messages like any other messages_in row. After the agent-runner marks a recurring message as `completed`, the **host** handles inserting the next occurrence (new messages_in row with `process_after` advanced to next cron time). The agent-runner doesn't manage recurrence — it just processes what it finds.

Pre-scripts: if a task message has a `script` field, run it first. If `wakeAgent = false`, mark completed without invoking the provider.

### Agent-to-Agent Messaging

**Outbound:** Agent calls `send_message(to="<agent-name>")` where the named destination is of type `agent` → agent-runner writes messages_out with `channel_type: 'agent'`, `platform_id` = target agent group ID. Host validates permissions and writes to the target session's `inbound.db` (recording `source_session_id` so the reply routes back to this exact session).

**Inbound:** Messages from other agents arrive as normal `chat` messages_in rows. The content includes `sender` and `senderId` (e.g., `"senderId": "agent:pr-admin"`). No special formatting — the agent sees it as a chat message.

### Agent-Runner Properties

- AgentProvider interface wraps SDK-specific query logic (trunk ships the `claude` provider; additional providers like OpenCode install via `/add-<provider>` skills)
- Session resume via provider-specific mechanisms
- System prompt loading from CLAUDE.md files
- PreCompact hook for transcript archiving (Claude provider)
- Script execution for task-kind messages

## Open Questions

- **Approval routing** — how does the host find the admin's DM conversation? What if no DM channel exists? Is the approval list configurable per agent group or global?
- **MCP server lifecycle** — does the MCP server process persist across multiple queries in the same container, or restart each time?
- **Container startup config** — what config (if any) is passed to the container at launch beyond env vars? The DB files are at fixed mount paths. System prompt comes from CLAUDE.md. Provider name comes from `container.json` (materialized from the `container_configs` table), not env. What else?
- **Idle detection with pending questions** — when `ask_user_question` is waiting for a response, the container should not be considered idle. Also need to detect when the agent is still working (active tool calls, subagents) and avoid killing the container even if no messages_out have been written recently.

## Related Documents

- **[api-details.md](api-details.md)** — Channel adapter interface (NanoClaw + Chat SDK bridge), message content examples, host delivery logic
- **[agent-runner-details.md](agent-runner-details.md)** — AgentProvider interface, MCP tools, message formatting, media handling, provider implementations
