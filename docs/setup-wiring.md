# Setup Wiring — Status & Remaining Work

Last updated: 2026-07-10

## What's Done

### Two-DB Split (session DB write isolation)
- Session DB split into `inbound.db` (host-owned) and `outbound.db` (container-owned)
- Each file has exactly one writer — eliminates SQLite write contention across host-container mount
- Host uses even seq numbers, container uses odd (collision-free)
- Container heartbeat via file touch (`/workspace/.heartbeat`) instead of DB UPDATE
- Scheduling MCP tools emit system actions via messages_out; host applies them to inbound.db in `delivery.ts:handleSystemAction()`
- Host sweep reads `processing_ack` table + heartbeat file mtime for stale detection
- Container clears stale `processing_ack` entries on startup (crash recovery)
- Files: `src/db/schema.ts` (INBOUND_SCHEMA + OUTBOUND_SCHEMA), `src/session-manager.ts`, `src/delivery.ts`, `src/host-sweep.ts`, `container/agent-runner/src/db/connection.ts`, `messages-in.ts`, `messages-out.ts`, `poll-loop.ts`, `mcp-tools/scheduling.ts`, `mcp-tools/interactive.ts`
- Container image rebuilt with tsconfig (`container/agent-runner/tsconfig.json`)
- E2E verified: host → Docker container → agent responds → "E2E works!" ✓

### OneCLI Integration
- `ensureAgent()` call added before `applyContainerConfig()` in `src/container-runner.ts`
- Without `ensureAgent`, OneCLI rejects unknown agent identifiers and returns false, leaving container with no credentials
- E2E verified with OneCLI credential injection ✓

### Channel Barrel
- `src/index.ts` imports `./channels/index.js` (the barrel)
- Trunk ships the barrel + Chat SDK bridge only; `/add-<channel>` skills drop adapter files in and register them via the barrel slot
- No channel adapters ship in trunk

### Setup Registration (partially)
- `setup/register.ts` creates entities (`agent_groups`, `messaging_groups`, `messaging_group_agents`) in `data/v2.db`
- Accepts `--platform-id` flag
- `getMessagingGroupAgentByPair()` prevents duplicate wiring
- `setup/verify.ts` checks the central DB (counts agent groups with wiring)

### Router Logging
- `src/router.ts` logs `MESSAGE DROPPED` at WARN level when no agents wired, with actionable guidance

### Channel Defaults (two-level model)

Each adapter declares its own wiring-time defaults (`ChannelDefaults`, see [api-details.md](api-details.md#channel-defaults)): per-context (DM vs group) engage mode, engage pattern, thread policy, and unknown-sender policy, plus how the platform signals mentions (`'platform' | 'dm-only' | 'never'`). Exactly two levels exist:

1. **Adapter declaration** — a static const in the adapter module (and its `ChannelRegistration`, so offline scripts resolve it without credentials). Adapters are skill-installed and user-owned; install-wide changes mean editing the adapter copy. No DB config table.
2. **Per-wiring override** — the explicit value chosen at creation (`ncl` flag, wizard answer, card-flow value), stored on the row. Existing rows are never re-resolved; declarations are consulted only at creation, except threading, which stays live via `messaging_group_agents.threads` (`NULL` = inherit).

All creation paths (`ncl wirings`/`messaging-groups`, `setup/register.ts`, the router's auto-create, the channel-approval card flow, the bootstrap scripts `scripts/init-first-agent.ts` / `scripts/init-cli-agent.ts`) go through the shared helpers in `src/channels/channel-defaults.ts`, so a platform's defaults are declared once and apply everywhere.

**Shared-identity pattern.** When the platform identity the adapter connects as belongs to a human (WhatsApp shared-number mode: `ASSISTANT_HAS_OWN_NUMBER` unset), the adapter itself suppresses mention signals — it never sets `isMention` and declares `mentions: 'never'`, group defaults of a name-pattern (`\b{name}\b`) and `strict` sender policy. With no mention signal, the router never auto-creates messaging groups or fires approval cards for the human's own conversations — the spam dies at the source, with zero core conditionals. The pattern is entirely channel-local and reusable by any adapter riding a personal identity (iMessage, Signal) with no core involvement.

**Back-compat contract.** A trunk update alone changes no behavior: stale (undeclared) adapters resolve through a behavior-faithful fallback at runtime, `ncl` keeps its legacy static defaults for them (gated on `hasDeclaredChannelDefaults`), existing DB rows are untouched, and the new `threads` column ships `NULL` everywhere — which reproduces today's `supportsThreads`-derived routing exactly. Updating an adapter copy (via its `/add-<channel>` skill) is what opts an install into that channel's new defaults, and even then only for wirings created afterwards. The one deliberate exception is the isGroup bugfix: card-approved groups on non-threaded platforms now wire via the group default instead of pattern `'.'` (group-ness comes from `event.message.isGroup ?? mg.is_group`, never `threadId !== null`).

---

## Previously Open — Now Resolved

### 1. ~~Channel Skills Don't Register Groups~~ ✅

Channel skills now point to `/manage-channels` in their "Next Steps" section. Registration is handled by the `/manage-channels` skill, which reads each channel's `## Channel Info` section for platform-specific guidance. Channel skills stay lean (credentials only).

### 2. ~~Setup SKILL.md Missing Group Registration Step~~ ✅

Added step 5a "Wire Channels to Agent Groups" between channel installation (step 5) and mount allowlist (step 6). This step invokes `/manage-channels` which handles agent group creation, isolation level decisions, and wiring.

### 3. ~~Channel Skills Should Know Channel Type~~ ✅

Each channel skill has a `## Channel Info` structured section with: type, terminology, how-to-find-id, supports-threads, typical-use, default-isolation. The `/manage-channels` skill reads this for contextual recommendations.

### 4. ~~Verify Step Channel Auth Check~~ ✅

`setup/verify.ts` checks all channel tokens: DISCORD_BOT_TOKEN, TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN+SLACK_APP_TOKEN, GITHUB_TOKEN, LINEAR_API_KEY, GCHAT_CREDENTIALS, TEAMS_APP_ID+TEAMS_APP_PASSWORD, WEBEX_BOT_TOKEN, MATRIX_ACCESS_TOKEN, RESEND_API_KEY, WHATSAPP_ACCESS_TOKEN, IMESSAGE_ENABLED, plus WhatsApp Baileys auth dir.

### 5. Agent-Shared Session Mode ✅

Added `session_mode: 'agent-shared'` for cross-channel shared sessions (e.g. GitHub + Slack in one conversation). Session resolution looks up by agent_group_id instead of messaging_group_id when this mode is set.

---

## Architecture Reference

### Entity Model
```
agent_groups (id, name, folder, agent_provider)
    ↕ many-to-many                       (container runtime config lives in the separate container_configs table)
messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, denied_at)
    via
messaging_group_agents (messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, threads)

users (id, kind, display_name)          -- namespaced as "<channel>:<handle>"
user_roles (user_id, role, agent_group_id)    -- owner / admin (global or scoped)
agent_group_members (user_id, agent_group_id) -- unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id)  -- cold-DM cache
```

Privilege is a user-level concept — there is no "main" agent group or "admin" messaging group. `user_roles` carries `owner` (global only, first pairing sets it) and `admin` (global or scoped to an `agent_group_id`). Unknown-sender gating is per-messaging-group via `messaging_groups.unknown_sender_policy` (`strict | request_approval | public`).

### Message Flow
```
Channel adapter → routeInbound() → resolve messaging_group → resolve agent via messaging_group_agents
→ resolve/create session → write to inbound.db → wake container → agent-runner polls inbound.db
→ agent responds → writes to outbound.db → host delivery poll reads outbound.db → deliver via adapter
```

### Key Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, imports channel barrel |
| `src/channels/index.ts` | Channel barrel — registry/Chat SDK bridge only in trunk; skills drop adapters in |
| `src/router.ts` | Inbound routing, auto-creates messaging groups |
| `src/session-manager.ts` | Creates inbound.db + outbound.db per session |
| `src/delivery.ts` | Polls outbound.db, delivers, handles system actions |
| `src/host-sweep.ts` | Syncs processing_ack, stale detection, recurrence |
| `src/container-runner.ts` | Spawns containers, OneCLI ensureAgent + applyContainerConfig |
| `setup/register.ts` | Creates entities (agent_group, messaging_group, wiring) |
| `setup/verify.ts` | Checks central DB for registered groups |
| `container/agent-runner/src/db/connection.ts` | Two-DB connection layer (inbound read-only, outbound read-write) |
