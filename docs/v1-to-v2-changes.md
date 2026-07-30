# NanoClaw v1 → v2 — what changed

Big-picture differences between NanoClaw v1 (the `~/nanoclaw` checkout you've been running) and v2 (this rewrite). Not a migration guide — that's what `bash migrate-v2.sh` and the `/migrate-from-v1` skill are for. This doc is the **vocabulary**: when something has moved or been renamed, find it here.

Read this before touching the migration code or porting customizations forward.

---

## One-line summary

v1 was one Node process with one SQLite file and native channel adapters. v2 is a host that spawns per-session Docker containers, splits state across a central DB + per-session DB pair, routes through an explicit entity model, and installs channels as skills from a sibling branch.

---

## Entity model — the biggest shift

**v1:** one flat table `registered_groups(jid, name, folder, trigger_pattern, requires_trigger, is_main, channel_name)`. A group folder is the unit of agent identity. A chat (JID) is wired to exactly one folder, and `trigger_pattern` is an opaque regex the router applies to every incoming message.

**v2:** three tables, with a deliberate many-to-many in the middle:

```
agent_groups  ─┐
               ├─ messaging_group_agents ─┬─ messaging_groups
               │   (engage_mode,          │   (channel_type,
               │    engage_pattern,       │    platform_id,
               │    sender_scope,         │    unknown_sender_policy)
               │    ignored_message_policy,
               │    session_mode, priority)
```

Consequences:

- **One agent can answer on many chats, and one chat can fan out to many agents.** v1 couldn't do either.
- **No `is_main` flag.** Privilege is now explicit via `user_roles` (owner/admin, global or scoped). See below.
- **No `trigger_pattern` regex.** Replaced with four orthogonal columns. Mapping rule used by the automated migration and by the `/migrate-from-v1` skill:
  - v1 `trigger_pattern` non-empty → v2 `engage_mode='pattern'`, `engage_pattern = <the regex>`
  - v1 `requires_trigger=0` or pattern was `.`/`.*` → v2 `engage_mode='pattern'`, `engage_pattern='.'` (the "always" flavor)
  - no pattern and requires a trigger → v2 `engage_mode='mention'`
  - `sender_scope` and `ignored_message_policy` are new; defaults `all` / `drop`
- **JID decomposition.** v1's `jid` column stored `dc:12345` / `tg:67890`. v2 splits this into `channel_type` + `platform_id`. Concretely: `dc:12345` becomes `channel_type='discord'`, `platform_id='discord:12345'`. Prefix aliases (`dc` → `discord`, `tg` → `telegram`, `wa` → `whatsapp`) are in `setup/migrate-v2/shared.ts`.
- **`channel_name` was unreliable in v1.** Many rows had it empty; the actual channel had to be guessed from the JID prefix. v2's `channel_type` is always explicit.

---

## Central DB vs session DBs

**v1:** one SQLite file at `store/messages.db`. Every chat, message, registered group, scheduled task, and session lived there. Host and any agent processes all opened the same file.

**v2:** three DB shapes.

1. `data/v2.db` — **central**. Everything that isn't per-session: users, roles, agent groups, messaging groups, wirings, pending approvals, user DMs, schema migrations.
2. `data/v2-sessions/<session_id>/inbound.db` — **host writes, container reads**. `messages_in`, routing, destinations, pending questions, processing_ack. This is where scheduled tasks live (see "Scheduling" below).
3. `data/v2-sessions/<session_id>/outbound.db` — **container writes, host reads**. `messages_out`, session_state.

Exactly one writer per file. No cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

Message history (v1 `messages` table, v1 `chats` table) is **not migrated**. The migration copies operationally important state forward (agents, channels, wirings, scheduled tasks, group folders) and leaves chat logs behind.

---

## Scheduling

**v1:** dedicated `scheduled_tasks` table in `store/messages.db` with its own columns (`schedule_type`, `schedule_value`, `next_run`, `last_run`, `context_mode`, `script`, `status`). A separate cron-ish scheduler process read from it.

**v2:** scheduled tasks are **`messages_in` rows with `kind='task'`** in a session's `inbound.db`. Relevant columns:
- `process_after` (ISO8601) — host sweep wakes the container when `datetime(process_after) <= datetime('now')`
- `recurrence` — cron string; `NULL` = one-shot
- `series_id` — groups recurring occurrences; set to the task id on first insert
- `status` — `pending` | `processing` | `completed` | `failed` | `paused`

The public API is `insertTask()` in `src/modules/scheduling/db.ts`. Recurrence is computed in the user's TZ via `cron-parser` (see `src/modules/scheduling/recurrence.ts`). The migration maps v1's `schedule_type`+`schedule_value` pair into a single cron string before calling `insertTask()`.

Tasks can exist before a session is awake — the host sweep creates/wakes the container on the first due tick.

---

## Credentials

**v1:** `.env` — plain environment variables. `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, etc. The host read them directly and passed them in to any code that needed them.

**v2:** OneCLI Agent Vault. A separate local service at `http://127.0.0.1:10254` holds secrets. Agents are *scoped* to specific secrets and the vault injects them into approved API requests as they leave the container. The container never sees the raw secret value.

Note: auto-created agents default to `all` secret mode — every vault secret whose host pattern matches is injected automatically. See the "Secret modes" section of the root CLAUDE.md if you want per-agent control (`onecli agents set-secret-mode --mode selective`).

**What the automated migration does:** copies every v1 `.env` key verbatim into v2 `.env`, never overwriting existing v2 keys. The OneCLI vault migration is a separate step owned by the `/init-onecli` skill, which knows how to pull from `.env`.

---

## Channel adapters

**v1:** native adapters (e.g. `discord.js` used directly) imported in `src/channels/`. Installing a channel meant editing code, adding a dependency, and setting env vars.

**v2:** channel adapters live on a sibling `channels` branch. Each `/add-<channel>` skill:
1. `git fetch origin channels`
2. `git show channels:src/channels/<name>.ts > src/channels/<name>.ts`
3. Appends `import './<name>.js';` to `src/channels/index.ts`
4. `pnpm install @chat-adapter/<name>@<pinned>`
5. `pnpm run build`

Idempotent — re-running is a no-op. Pinned versions keep the supply chain honest. The automated migration detects which channels were wired in v1 (via distinct `channel_name` / JID prefix) and runs the matching `setup/install-<channel>.sh` for each. Channels in v1 that don't have a v2 skill (rare now, more common as v2 catches up) are recorded in the handoff file for the `/migrate-from-v1` skill to raise with the user.

**Channel auth beyond `.env`.** Some channels store session state on disk (Baileys WhatsApp keystore, Matrix sync state, iMessage tokens). The `channel-auth` step has a per-channel registry (`setup/migrate-v2/shared.ts: CHANNEL_AUTH_REGISTRY`) that knows which file globs to copy alongside env keys.

---

## Privilege — from implicit to explicit

**v1:** `registered_groups.is_main = 1` flagged one group as the privileged one. No `users` table. Permissions were conventions, not enforced.

**v2:** explicit tables.
- `users(id = "<channel_type>:<handle>", kind, display_name)` — one row per messaging-platform identifier
- `user_roles(user_id, role ∈ {owner, admin}, agent_group_id nullable, granted_by, granted_at)` — owner is always global; admin can be global or scoped
- `agent_group_members(user_id, agent_group_id, ...)` — "known" membership for the `sender_scope='known'` gate

Owner gets seeded during the `/migrate-from-v1` skill's interview phase ("Which handle is you?"). The automated migration doesn't guess — v1 has no source of truth for it.

**Default access — "anyone can talk to the bot" vs "only known users".** v1 stored this implicitly (via trigger regex + `is_main`). v2 exposes it as `messaging_groups.unknown_sender_policy ∈ {'strict', 'request_approval', 'public'}`. The skill asks the user which mode v1 ran in and flips the migrated messaging groups accordingly.

---

## Group folders on disk

**v1:** `groups/<folder>/CLAUDE.md` and optional `logs/`. `CLAUDE.md` was a plain instruction file, group-specific.

**v2:** each group still lives at `groups/<folder>/`, but the shape is richer:
- `CLAUDE.md` or `AGENTS.md` — **composed at container spawn** from the provider's shared base, standing instructions, and capability fragments. **Don't edit it directly.**
- `instructions.prepend.md` — provider-neutral standing role, personality, and behavior.
- `memory/` — provider-neutral durable memory. Its index and system definition are injected when a context window starts.
- `CLAUDE.local.md` — legacy staging only. The deterministic v1 migration writes the old `CLAUDE.md` here; `/migrate-from-v1` invokes `/migrate-memory` to move and distill it.
- `container.json` — optional per-group container config (apt deps, env, mounts). v1's `registered_groups.container_config` JSON is close but not identical — the migration stores the v1 payload at `groups/<folder>/.v1-container-config.json` for the skill to reconcile, rather than silently mapping it.
- Provider document fragments are installed at spawn, and the container scaffolds `memory/` without importing legacy files.

---

## Host process vs containers

**v1:** single Node process. The "agent" was the same process as the router.

**v2:** Node host at top, Bun-runtime Docker container per session. They communicate only via the two session DBs. No shared modules, no IPC, no stdin piping. If you wrote custom code that reached from the agent into host internals (or vice versa), that surface no longer exists — porting it is a `/migrate-from-v1` skill topic, not a mechanical copy.

Lockfiles: host uses `pnpm-lock.yaml`, agent-runner uses `bun.lock`. `minimumReleaseAge: 4320` on the host side (3-day supply-chain wait); agent-runner has no release-age gate.

---

## Self-modification and MCP tools

**v1:** if you added MCP servers or self-modification plumbing, it was usually direct edits to the long-running process.

**v2:**
- MCP servers register through `container/agent-runner/src/mcp-tools/*.ts` and load per-session. There's also `install_packages` and `add_mcp_server` self-mod tools that go through an admin-approval flow (`src/modules/self-mod/apply.ts`) before rebuilding the container image.
- Custom MCP tools you wrote in v1 map cleanly to the v2 tool registry, but the import paths, runtime (Bun vs Node), and SQL helper differences (`bun:sqlite` uses `$name`-prefixed params) may need adjustment. The skill walks through this.

---

## Things that are gone or don't map

- **`scheduled_tasks` as a separate table** — moved into session `inbound.db` under `kind='task'`. Migration ports active rows; inactive/completed are exported to `logs/setup-migration/inactive-tasks.json` for reference.
- **`messages` / `chats` tables (chat history)** — not migrated. Stay in the v1 checkout if you need them.
- **`router_state` (key/value)** — not migrated. v2 state lives in the explicit tables above.
- **`sessions` (v1 group→session_id)** — v1 sessions don't map; v2 sessions are keyed by `(agent_group_id, messaging_group_id, thread_id)` and are created on demand.
- **Raw access to the old `store/messages.db`** — the v1 DB is left in place and untouched. If migration goes wrong you can re-run it (the migration sub-steps are idempotent for agents/channels/wirings; folders use rsync semantics).

---

## Migration surface — where the code lives

- `migrate-v2.sh` — entry point: `bash migrate-v2.sh` from the v2 checkout.
- `setup/migrate-v2/*.ts` — individual migration steps (env, db, groups, sessions, tasks, channel-auth, select-channels, switchover-prompt).
- `setup/migrate-v2/shared.ts` — JID parsing, trigger mapping, channel auth registry.
- `logs/setup-migration/handoff.json` — written by `migrate-v2.sh`, read by the `/migrate-from-v1` skill.
- `logs/migrate-steps/*.log` — raw per-step stdout.
- `.claude/skills/migrate-from-v1/SKILL.md` — Claude skill for owner seeding, CLAUDE.md cleanup, container config validation, fork porting.
- `migrate-v2-reset.sh` — development helper to wipe v2 state for re-testing.
- See [docs/migration-dev.md](migration-dev.md) for the full development guide.
