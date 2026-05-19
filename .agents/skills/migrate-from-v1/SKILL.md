---
name: migrate-from-v1
description: Finish migrating a NanoClaw v1 install into v2. Run after `bash migrate-v2.sh` completes. Seeds the owner, cleans up Codex.local.md files, reconciles container configs, and helps port custom v1 code. Triggers on "migrate from v1", "finish migration", "v1 migration".
---

# Finish v1 → v2 migration

`bash migrate-v2.sh` already ran the deterministic migration. It handled:

- .env keys merged
- v2 DB seeded (agent_groups, messaging_groups, wiring)
- Group folders copied (v1 AGENTS.md → v2 Codex.local.md)
- Session data copied with conversation continuity (incl. Codex memory + JSONL transcripts)
- Scheduled tasks ported
- Channel code installed and auth state copied (incl. WhatsApp Baileys keystore)
- WhatsApp LIDs resolved from `store/auth` and aliased into `messaging_groups`
- Container skills copied
- Container image built

Your job is the parts that need human judgment: triage any failed steps, seed the owner, clean up Codex.local.md files, reconcile configs, and port any fork customizations.

Read `logs/setup-migration/handoff.json` first — it has `overall_status`, per-step results in `steps`, and a `followups` list.

## Preflight: was the script run?

Before anything else, check that `logs/setup-migration/handoff.json` exists. If it doesn't, the user is invoking this skill before `migrate-v2.sh` ran. Stop and tell them, verbatim:

> This skill finishes a migration that `migrate-v2.sh` started. Run that first, in your terminal — not from inside Codex:
>
> ```bash
> bash migrate-v2.sh
> ```
>
> It needs interactive prompts (channel selection, service switchover) and runs Node/pnpm bootstrap, Docker, OneCLI setup, and a container build that don't fit inside a Codex session. When it finishes, it'll hand control back to Codex automatically — at which point this skill picks up.

Do not attempt to run the script yourself, simulate its effects, or pick up the migration mid-stream. The deterministic side has dependencies on a real interactive shell.

Once `handoff.json` exists, proceed to Phase 0.

## Phase 0: Get v2 routing real messages

Before any deeper migration work, prove v2 actually answers messages on the user's real channels. v1 is paused, not touched — flipping back is a service restart.

### 0a — Fix blockers only

Walk `handoff.steps`. Fix only the failures that would stop the bot from routing one message; defer the rest to its later phase.

### 0b — Smoke test, then continue

Tell the user the switch is non-destructive (v1 is paused, not modified; reverting is one command). Help them stop v1's service unit and start v2's, tail the host log for a clean boot, and have them send a real test message. Use `AskUserQuestion` to confirm the bot responded.

If yes, continue to Phase 1. If no, diagnose from `logs/nanoclaw.log` and re-test — don't proceed to deeper work on a broken router.

### Deferred failures

Re-visit anything you skipped in 0a before declaring the migration done. Most surface naturally in later phases (`1c-groups` ↔ Phase 2, `1e-tasks` ↔ task verification).

## Phase 1: Owner and access

v2 auto-creates a `users` row for every sender it sees (via `extractAndUpsertUser` in `src/modules/permissions/index.ts`). By the time this skill runs, the owner's row likely already exists — it just needs the `owner` role granted.

**User ID format**: always `<channel_type>:<platform_handle>`. Each channel populates this differently:
- **Telegram**: `telegram:<numeric_user_id>` (e.g. `telegram:6037840640`)
- **Discord**: `discord:<snowflake_user_id>` (e.g. `discord:123456789012345678`)
- **WhatsApp**: `whatsapp:<phone>@s.whatsapp.net` (e.g. `whatsapp:14155551234@s.whatsapp.net`)
- **Slack**: `slack:<user_id>` (e.g. `slack:U04ABCDEF`)
- **Others**: `<channel_type>:<platform_id>`

**Steps:**

1. Query `users` table: `SELECT id, kind, display_name FROM users`.
2. If exactly one user exists, confirm: `AskUserQuestion`: "Is `<display_name>` (`<id>`) you?" — Yes / No, let me type it.
3. If multiple users exist, present them as options in `AskUserQuestion`.
4. If no users exist yet (service hasn't received a message), ask the user to send a test message first, then re-query.
5. Once confirmed, check `user_roles` — if the owner role already exists, skip. Otherwise insert:
   ```sql
   INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
   VALUES ('<user_id>', 'owner', NULL, NULL, datetime('now'))
   ```

Use the DB helpers in `src/db/user-roles.ts` — they keep indexes correct. Init the DB first:

```ts
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR } from '../src/config.js';
import path from 'path';
const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);
```

### Access policy

After seeding the owner, discuss the access policy. v2's `messaging_groups.unknown_sender_policy` controls who can interact with the bot. `migrate-v2.sh` set it to `public` so the bot would respond during the switchover test, but the user may want to tighten it.

Present the options via `AskUserQuestion`:

1. **Public** (current) — anyone can message the bot. Good for personal DM bots.
2. **Known users only** — only users in `agent_group_members` can trigger the bot. Others are silently dropped.
3. **Approval required** — unknown senders trigger an approval request to the owner. Good for group chats where you want to vet new members.

If the user picks option 2 or 3, seed the known users from v1's message history. The v1 database is at `<handoff.v1_path>/store/messages.db`. It has a `messages` table with `sender` and `sender_name` columns. For each group:

```sql
-- v1: unique senders per chat (excluding bot messages)
SELECT DISTINCT sender, sender_name
FROM messages
WHERE chat_jid = '<v1_jid>' AND is_from_me = 0 AND sender IS NOT NULL
```

The `sender` value is a platform handle (e.g. `6037840640` for Telegram). Build the v2 user ID by inferring the channel type from the chat JID prefix (use `parseJid` from `setup/migrate-v2/shared.ts`) and combining: `<channel_type>:<sender>`.

For each sender:
1. Upsert into `users(id, kind, display_name)` if not already present.
2. Insert into `agent_group_members(user_id, agent_group_id)` for each agent group wired to that messaging group.

Show the user the list of senders being imported and let them deselect any they don't want.

Then update the messaging groups:
```sql
UPDATE messaging_groups SET unknown_sender_policy = '<chosen_policy>'
WHERE id IN (SELECT id FROM messaging_groups WHERE channel_type IN (<migrated_channels>))
```

## Phase 2: Clean up Codex.local.md

The migration copied v1's entire AGENTS.md into Codex.local.md for each group. This file now contains v1 boilerplate that v2 handles through its own composed fragments (`container/AGENTS.md` + `.Codex-fragments/module-*.md`). The user's customizations are buried inside.

For each group that has a `Codex.local.md`:

1. Read the file.
2. Read the v1 template it was based on. Determine which template by checking the v1 install:
   - If the group had `is_main=1` in v1's `registered_groups`, the template was `groups/main/AGENTS.md`
   - Otherwise, the template was `groups/global/AGENTS.md`
   - The v1 path is in `handoff.json` → `v1_path`
3. Diff the file against the template. Identify sections that are:
   - **Stock boilerplate** (identical to template) — remove. v2's fragments cover this.
   - **User customizations** (added sections, modified sections) — keep.
4. The following v1 sections are now handled by v2 fragments and should be removed even if slightly modified:
   - "What You Can Do" → v2 runtime system prompt
   - "Communication" / "Internal thoughts" / "Sub-agents" → `container/AGENTS.md` + `module-core.md`
   - "Your Workspace" / workspace path references → `container/AGENTS.md`
   - "Memory" (the stock version) → `container/AGENTS.md`
   - "Message Formatting" → `container/AGENTS.md`
   - "Admin Context" → v2 uses `user_roles`, not is_main
   - "Authentication" → v2 uses OneCLI
   - "Container Mounts" → v2 mounts are different
   - "Managing Groups" / "Finding Available Groups" / "Registered Groups Config" → v2 entity model, no IPC
   - "Global Memory" → v2 has `.Codex-shared.md` symlink
   - "Scheduling for Other Groups" → `module-scheduling.md`
   - "Task Scripts" → `module-scheduling.md`
   - "Sender Allowlist" → v2 uses `unknown_sender_policy` + `user_roles`
5. Fix path references in kept sections:
   - `/workspace/group/` → `/workspace/agent/`
   - `/workspace/project/` → these paths don't exist in v2; discuss with the user
   - `/workspace/ipc/` → gone; remove references
   - `/workspace/extra/` → v2 uses `container.json` `additionalMounts`; keep but note the path may change
6. Keep the `# Name` heading and first paragraph (identity) — this is the user's agent personality.
7. Show the user the proposed new Codex.local.md before writing it. Use `AskUserQuestion`: "Here's what I'd keep — look right?" with options to approve, edit, or keep the original.

If a Codex.local.md has no user customizations (pure template copy), write a minimal file with just the identity heading.

## Phase 3: Container config

`migrate-v2.sh` writes `container.json` directly from v1's `container_config` (the `additionalMounts` shape is identical). If the v1 config was unparseable, it falls back to a `.v1-container-config.json` sidecar.

For each group, check:

1. If `container.json` exists, read it and verify the `additionalMounts` host paths are still valid on this machine. Flag any that don't exist.
2. If `.v1-container-config.json` exists (parse failure fallback), read it, discuss with the user, and write a proper `container.json`. Then delete the sidecar.
3. Check for `env` or `packages` fields — `env` may overlap with OneCLI vault, `packages` (apt/npm) are portable.

## Phase 4: Fork customizations

Check whether the user's v1 install was a customized fork.

```bash
cd <v1_path>
git remote -v
git log --oneline <upstream>/main..HEAD 2>/dev/null
```

If no commits ahead of upstream: stock v1, skip this phase.

If there are commits:

1. Show the commit list to the user.
2. `AskUserQuestion`: "How do you want to handle your v1 customizations?"
   - **Copy portable items** (recommended) — copy `container/skills/*`, `.Codex/skills/*`, `docs/*`. Scan each with `scanForV1Patterns` from `setup/migrate-v2/shared.ts`.
   - **Full walkthrough** — go commit by commit, decide together.
   - **Reference only** — stash to `docs/v1-fork-reference/` for later.
3. Source code (`src/*`, `container/agent-runner/src/*`) is NOT portable — v2's architecture is fundamentally different. Stash to `docs/v1-fork-reference/` with a README explaining what each file did. Don't translate.

## Principles

- **v1 checkout is read-only.** Never modify files under `handoff.v1_path`.
- **Show before writing.** Show diffs/proposed content before modifying Codex.local.md or container.json.
- **Mask credentials** when displaying (first 4 + `...` + last 4 characters).
- **`handoff.json` is the recovery point.** If context gets compacted, re-read it and `git status` to recover state.

## Setup steps you can run

The setup flow at `setup/index.ts` has individual steps you can invoke if something is missing or failed:

```bash
pnpm exec tsx setup/index.ts --step <name>
```

| Step | When to use |
|------|-------------|
| `onecli` | OneCLI not installed or not healthy |
| `auth` | No Anthropic credential in vault |
| `container` | Container image needs rebuild |
| `service` | Service not installed or not running |
| `mounts` | Mount allowlist missing |
| `verify` | End-to-end health check (run after everything else) |
| `environment` | System check (Node, dirs) |

## When done

1. Run the verify step to confirm everything works:
   ```bash
   pnpm exec tsx setup/index.ts --step verify
   ```
2. Delete `logs/setup-migration/handoff.json` — offer to save as `docs/migration-<date>.md` first.
3. Restart the service if running so changes take effect:
   ```bash
   # Linux
   systemctl --user restart nanoclaw-v2-*
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-*
   ```
