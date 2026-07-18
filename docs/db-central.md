# NanoClaw — Central DB Schema

Complete reference for `data/v2.db`, the host-owned admin-plane database. Start with [db.md](db.md) for the three-DB overview, the map, and the cross-mount rules.

Access layer: `src/db/`. `src/db/schema.ts`'s `SCHEMA` constant is a *reference copy* of the core tables for orientation — it is not exhaustive: several tables (`agent_destinations`, `pending_approvals`, `container_configs`, `agent_message_policies`, `pending_channel_approvals`, and others) exist only in their migration files under `src/db/migrations/`, which remain the actual source of truth for what's created at runtime.

---

## 1. Tables

### 1.1 `agent_groups`

Agent workspaces. Each maps 1:1 to a `groups/<folder>/` directory containing `CLAUDE.md` and skills. Container config lives in `container_configs` (see §1.x below); a `container.json` file is materialized at spawn time for the container runner to read.

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);
```

- **Readers:** `src/session-manager.ts`, `src/delivery.ts`, `src/router.ts`
- **Writers:** `src/db/agent-groups.ts`

### 1.2 `messaging_groups`

One row per platform chat (one WhatsApp group, one Slack channel, one 1:1 DM, etc.) per adapter instance.

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  instance              TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            TEXT NOT NULL,
  denied_at             TEXT,
  UNIQUE(channel_type, platform_id, instance)
);
```

- `instance`: adapter-instance name — N adapters of one platform (e.g. three Slack apps in one workspace) each own their rows. The default instance IS the channel type: migration 016 backfills `instance = channel_type` and `createMessagingGroup` stamps the same default, so single-instance installs never see the dimension. Inbound lookups are exact-on-instance (an unknown named instance auto-creates its own row); outbound lookups resolve default-instance-first.
- `unknown_sender_policy`: `strict` (drop), `request_approval` (ask admin), `public` (allow).
- **Readers:** `src/router.ts`, `src/delivery.ts`, `src/session-manager.ts`
- **Writers:** `src/db/messaging-groups.ts`, channel setup flows

### 1.3 `messaging_group_agents`

Wiring: which agent group handles which messaging group. Many-to-many — the same channel can route to multiple agents (see [isolation-model.md](isolation-model.md)).

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern';
                                 -- '.' means "match every message"
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

- `session_mode`: `shared` (one session per channel), `per-thread` (one per thread), `agent-shared` (one per agent group across all channels).
- `engage_mode` / `engage_pattern` / `sender_scope` / `ignored_message_policy`: four orthogonal axes (migration 010) that replaced v1's opaque `trigger_rules` JSON + `response_scope` enum. `engage_mode='pattern'` requires `engage_pattern` (`'.'` matches every message — the "always respond" flavor); `sender_scope='known'` restricts engagement to group members; `ignored_message_policy='accumulate'` keeps ignored messages as context instead of dropping them.
- **Side effect:** creating a wiring must also populate `agent_destinations` — don't mutate one without the other (see §1.10).

### 1.4 `users`

Platform user identities. ID is namespaced: `tg:123456`, `discord:abc`, `phone:+1555...`, `email:a@x.com`. One human may own several rows — no cross-channel linking yet.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

- **Writers/readers:** `src/db/users.ts`; channel auth flows

### 1.5 `user_roles`

Permissions. **Privilege is user-level, never agent-group-level.**

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
```

Invariants:
- `role = 'owner'` → must be global (`agent_group_id IS NULL`). Enforced in `grantRole()`.
- `role = 'admin'` → global (NULL) or scoped to one agent group.
- Admin @ A implies membership in A — no `agent_group_members` row required.

Access layer: `src/db/user-roles.ts`, `src/access.ts`.

### 1.6 `agent_group_members`

Explicit membership for non-privileged users. Owner and admins don't need rows here — they're implicit members.

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### 1.7 `user_dms`

Cache of DM channel discovery. Lets the host send a cold DM (approval card, pairing code) without hitting the platform's `openConversation` API every time.

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

Populated lazily by `ensureUserDm()` in `src/user-dm.ts`. Cold DMs resolve via the channel's default adapter instance — `PRIMARY KEY (user_id, channel_type)` is per-platform, not per-instance.

### 1.8 `sessions`

Session registry. One row per (agent group, messaging group, thread) tuple subject to `session_mode`. Stores lifecycle metadata only — no messages.

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

- **Resolved by:** `resolveSession()` in `src/session-manager.ts`.
- Creating a session also provisions the session folder and both session DBs via `initSessionFolder()` — see [db-session.md](db-session.md).

### 1.9 `pending_questions`

The `ask_user_question` MCP tool parks an interactive question here, and the container matches incoming `system` messages back to it by `questionId`.

```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

### 1.10 `agent_destinations`

Permission ACL *and* name-resolution map for outbound sending. An agent asking to `send_message(to="dev-channel")` must have a row here with `local_name = 'dev-channel'`, or the send is rejected as `unknown destination`.

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

**Projection invariant (load-bearing).** The central table is the source of truth, but each running container reads from a projection in its own `inbound.db` (see [db-session.md §2.3](db-session.md#23-destinations)). Any code that mutates `agent_destinations` while a container is running must also call `writeDestinations()` (`src/session-manager.ts`) or the container will reject sends with stale data. Known call sites: `createMessagingGroupAgent()` in `src/db/messaging-groups.ts`, the `create_agent` system action in `src/delivery.ts`.

Access layer: `src/db/agent-destinations.ts`.

### 1.11 `pending_approvals`

Two workflows share this table:

- **Session-bound MCP approvals** — `install_packages`, `add_mcp_server`. `session_id` is set.
- **OneCLI credential approvals** — `session_id` may be NULL; `agent_group_id` + `channel_type` + `platform_id` route the admin card.

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

- `status`: `pending` | `approved` | `rejected` | `expired`.
- `platform_message_id` lets the host edit the admin card in place after a decision.
- Access layer: `src/db/sessions.ts`; sweep + delivery: `src/onecli-approvals.ts`.

### 1.12 `unregistered_senders`

Audit trail: every time a message gets dropped (unknown sender, strict policy), we increment a counter here so admins can see who's been trying to knock.

```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

Writer: `recordDroppedMessage()` in `src/db/dropped-messages.ts`. On conflict, bumps `message_count` + `last_seen`.

### 1.13 Chat SDK bridge tables

State backing the `SqliteStateAdapter` used by the Chat SDK bridge (see [api-details.md](api-details.md)). NanoClaw code rarely touches these directly — they're owned by `src/state-sqlite.ts`.

```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER                    -- unix ts, nullable
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

### 1.14 `schema_version`

Migration ledger, written by the migration runner (§2).

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);
```

### 1.15 `container_configs`

Per-agent-group container runtime config. Source of truth for provider, model, packages, MCP servers, mounts, CLI scope, etc. Materialized to `groups/<folder>/container.json` at spawn time.

```sql
CREATE TABLE container_configs (
  agent_group_id         TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider               TEXT,
  model                  TEXT,
  effort                 TEXT,
  image_tag              TEXT,
  assistant_name         TEXT,
  max_messages_per_prompt INTEGER,
  skills                 TEXT NOT NULL DEFAULT '"all"',
  mcp_servers            TEXT NOT NULL DEFAULT '{}',
  packages_apt           TEXT NOT NULL DEFAULT '[]',
  packages_npm           TEXT NOT NULL DEFAULT '[]',
  additional_mounts      TEXT NOT NULL DEFAULT '[]',
  cli_scope              TEXT NOT NULL DEFAULT 'group',   -- disabled | group | global
  updated_at             TEXT NOT NULL
);
```

- **Readers:** `src/container-config.ts`, `src/container-runner.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts`
- **Writers:** `src/db/container-configs.ts`, `src/modules/self-mod/apply.ts`, `src/backfill-container-configs.ts`

### 1.16 `pending_sender_approvals`

In-flight state for the `unknown_sender_policy = 'request_approval'` flow. A row exists while an admin-approval card is outstanding for a first-time sender in a wired messaging group; `UNIQUE(messaging_group_id, sender_identity)` dedups concurrent attempts from the same sender instead of spamming the admin with repeat cards.

```sql
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,    -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,    -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',       -- added by migration 013
  options_json       TEXT NOT NULL DEFAULT '[]',     -- added by migration 013
  UNIQUE(messaging_group_id, sender_identity)
);
```

Deleted on admin approve (after adding the sender as a member) or deny.

- Access layer: `src/modules/permissions/db/pending-sender-approvals.ts`
- **Readers/writers:** `src/modules/permissions/sender-approval.ts`, `src/modules/permissions/index.ts`, `src/db/sessions.ts` (`getAskQuestionRender`), `src/cli/resources/groups.ts`

### 1.17 `pending_channel_approvals`

In-flight state for the unknown-channel registration flow. When a channel with no `messaging_group_agents` wiring receives a mention or DM, the router escalates to the owner; `PRIMARY KEY(messaging_group_id)` gives free in-flight dedup via `INSERT OR IGNORE` — a second mention while a card is pending drops silently.

```sql
CREATE TABLE pending_channel_approvals (
  messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
                     -- agent the approved wiring will target (earliest
                     -- agent_group by created_at, picked at request time)
  original_message   TEXT NOT NULL,      -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',       -- added by migration 013
  options_json       TEXT NOT NULL DEFAULT '[]'      -- added by migration 013
);
```

Approve creates the `messaging_group_agents` wiring and replays the triggering event; deny sets `messaging_groups.denied_at` so future messages on that channel drop without re-prompting. Either way, this row is deleted.

- Access layer: `src/modules/permissions/db/pending-channel-approvals.ts`
- **Readers/writers:** `src/modules/permissions/channel-approval.ts`, `src/modules/permissions/index.ts`, `src/router.ts`, `src/db/sessions.ts` (`getAskQuestionRender`), `src/cli/resources/groups.ts`

### 1.18 `agent_message_policies`

Per-message approval gate on an agent-to-agent connection between two agent groups. No row for a `(from, to)` pair means free flow (no approval required); a row names the `approver` who must sign off on each message.

```sql
CREATE TABLE agent_message_policies (
  from_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  to_agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
  approver            TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (from_agent_group_id, to_agent_group_id)
);
```

- Access layer: `src/modules/agent-to-agent/db/agent-message-policies.ts`
- **Readers/writers:** `src/cli/resources/policies.ts`; approved messages create a row in `pending_approvals` (see §1.11) via the a2a send path.

---

## 2. Migration system

Migrations live in `src/db/migrations/`, one file per migration. Runner: `runMigrations()` in `src/db/migrations/index.ts`. It:

1. Creates `schema_version` if absent.
2. Reads every already-applied `name` from `schema_version` into a `Set` and filters the `migrations` barrel array down to the ones whose `name` isn't in that set — dedup is by **name**, not by the numeric `version` field.
3. Runs each pending migration's `up(db)` inside a transaction, in the barrel array's literal order (which is *not* sorted by `version`), then inserts a `schema_version` row.
4. The `version` column stored in `schema_version` is **not** the migration's own `version` field — it's `COALESCE(MAX(version), 0) + 1`, i.e. an auto-assigned applied-order number computed at insert time. The `version` field on the `Migration` object is just an ordering hint for humans reading the barrel file; it lets module migrations (installed later by skills) pick arbitrary numbers without coordinating with trunk.

A few migrations also set `disableForeignKeys: true` (needed for table recreates — SQLite can't relax a table-level `UNIQUE` without DROP+RENAME, which fails FK integrity checks with live child rows). The runner toggles `PRAGMA foreign_keys` around the transaction and runs `PRAGMA foreign_key_check` inside it, snapshotting pre-existing violations so it only fails on violations the migration itself introduced.

Several early migrations were later renamed/retired and replaced by "module" files (their original `name` is retained on the new file so already-migrated DBs don't re-run them):

| Ver. | Name (stored in `schema_version`) | File | Introduces |
|---|---|------|------------|
| 1 | `initial-v2-schema` | `001-initial.ts` | Core tables: `agent_groups`, `messaging_groups`, `messaging_group_agents` (with the original `trigger_rules`/`response_scope` columns — see v10), `users`, `user_roles`, `agent_group_members`, `user_dms`, `sessions`, `pending_questions` |
| 2 | `chat-sdk-state` | `002-chat-sdk-state.ts` | `chat_sdk_kv`, `chat_sdk_subscriptions`, `chat_sdk_locks`, `chat_sdk_lists` |
| 3 | `pending-approvals` | `module-approvals-pending-approvals.ts` | `pending_approvals` (session-bound + OneCLI fields) |
| 4 | `agent-destinations` | `module-agent-to-agent-destinations.ts` | `agent_destinations` + backfill from existing `messaging_group_agents` wirings |
| 7 | `pending-approvals-title-options` | `module-approvals-title-options.ts` | Retroactive `ALTER TABLE pending_approvals` add `title`, `options_json` for DBs that ran migration 3 before its `CREATE TABLE` was edited to include those columns |
| 8 | `dropped-messages` | `008-dropped-messages.ts` | `unregistered_senders` |
| 9 | `drop-pending-credentials` | `009-drop-pending-credentials.ts` | Drop the defunct `pending_credentials` table |
| 10 | `engage-modes` | `010-engage-modes.ts` | `messaging_group_agents`: add `engage_mode`, `engage_pattern`, `sender_scope`, `ignored_message_policy`; backfill from `trigger_rules`/`response_scope`; drop those two legacy columns (see §1.3) |
| 11 | `pending-sender-approvals` | `011-pending-sender-approvals.ts` | `pending_sender_approvals` (see §1.16) |
| 12 | `channel-registration` | `012-channel-registration.ts` | `messaging_groups.denied_at` + `pending_channel_approvals` (see §1.17) |
| 13 | `approval-render-metadata` | `013-approval-render-metadata.ts` | `title`, `options_json` columns on `pending_channel_approvals` and `pending_sender_approvals` |
| 14 | `container-configs` | `014-container-configs.ts` | `container_configs` — per-agent-group container runtime config |
| 15 | `cli-scope` | `015-cli-scope.ts` | `ALTER TABLE container_configs ADD COLUMN cli_scope` |
| 16 | `messaging-group-instance` | `016-messaging-group-instance.ts` | `messaging_groups` gets an `instance` column (adapter-instance dimension); table recreate (`disableForeignKeys: true`) backfills `instance = channel_type` on every existing row and relaxes the `UNIQUE` to `(channel_type, platform_id, instance)` |
| 17 | `agent-message-policies` | `017-agent-message-policies.ts` | `agent_message_policies` (see §1.18) |
| 18 | `approvals-approver-user-id` | `018-approvals-approver-user-id.ts` | `pending_approvals.approver_user_id` — names a single required approver for a2a message-gate policies |

Numbers 5 and 6 are intentionally absent — migrations were renumbered during early development.

Session DB schemas (`INBOUND_SCHEMA`, `OUTBOUND_SCHEMA`) are **not** versioned here. They're `CREATE TABLE IF NOT EXISTS` so new columns land via the session-DB lazy migration helpers (`migrateDeliveredTable()` etc.) when a session file from an older build is reopened. See [db-session.md](db-session.md).
