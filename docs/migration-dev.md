# v1 → v2 Migration — Development Guide

How to test, develop, and debug the migration flow.

## Quick start

```bash
# Full cycle: reset → migrate → Claude finishes
bash migrate-v2-reset.sh && bash migrate-v2.sh
```

## Architecture

Two-part migration:

1. **`migrate-v2.sh`** — deterministic bash script. Handles prerequisites, DB seeding, file copies, channel install, container build, service switchover. Writes `logs/setup-migration/handoff.json` then `exec`s into Claude.

2. **`/migrate-from-v1` skill** — Claude-driven. Reads the handoff, seeds owner/roles, invokes `/migrate-memory`, validates container configs, and ports fork customizations.

## File layout

```
migrate-v2.sh                        # Entry point
migrate-v2-reset.sh                  # Wipe v2 state for re-testing
setup/migrate-v2/
  env.ts                             # Phase 1a: merge .env
  db.ts                              # Phase 1b: seed v2 DB
  groups.ts                          # Phase 1c: copy group folders + container.json
  sessions.ts                        # Phase 1d: copy sessions + set continuation
  tasks.ts                           # Phase 1e: port scheduled tasks
  channel-auth.ts                    # Phase 2b: copy channel auth state
  select-channels.ts                 # Phase 2a: clack multiselect
  switchover-prompt.ts               # Service switch prompts
setup/migrate-v2/shared.ts           # Shared helpers (JID parsing, trigger mapping, etc.)
.claude/skills/migrate-from-v1/      # The Claude skill
logs/setup-migration/handoff.json    # Written by migrate-v2.sh, read by skill
logs/migrate-steps/*.log             # Per-step raw output
```

## Development loop

```bash
# Reset v2 to clean state (keeps node_modules)
bash migrate-v2-reset.sh

# Run migration with non-interactive channel selection
NANOCLAW_CHANNELS="telegram" bash migrate-v2.sh

# Or run interactively (clack multiselect)
bash migrate-v2.sh
```

`migrate-v2-reset.sh` wipes: `data/`, `logs/`, `.env`, `groups/` (restores git-tracked), `container/skills/` (restores git-tracked), `src/channels/` (restores git-tracked).

It does NOT wipe `node_modules/` (expensive to reinstall).

## Testing individual steps

Each step is a standalone TypeScript file:

```bash
# Run a single step (after pnpm install)
pnpm exec tsx setup/migrate-v2/env.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/db.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/groups.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/sessions.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/tasks.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/channel-auth.ts /path/to/v1 telegram discord
```

Each prints `OK:<details>`, `SKIPPED:<reason>`, or errors to stdout. Exit 0 on success/skip, non-zero on failure.

## Debugging

### Check what was migrated

```bash
# Agent groups
sqlite3 data/v2.db "SELECT * FROM agent_groups"

# Messaging groups + wiring
sqlite3 data/v2.db "SELECT mg.id, mg.channel_type, mg.platform_id, mg.unknown_sender_policy, mga.engage_mode, mga.engage_pattern FROM messaging_groups mg JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id"

# Sessions
sqlite3 data/v2.db "SELECT * FROM sessions"

# Users and roles
sqlite3 data/v2.db "SELECT * FROM users"
sqlite3 data/v2.db "SELECT * FROM user_roles"

# Session continuation (which Claude Code session will be resumed)
AG_ID=$(sqlite3 data/v2.db "SELECT id FROM agent_groups LIMIT 1")
SESS_ID=$(sqlite3 data/v2.db "SELECT id FROM sessions LIMIT 1")
sqlite3 data/v2-sessions/$AG_ID/$SESS_ID/outbound.db "SELECT * FROM session_state"

# Scheduled tasks
sqlite3 data/v2-sessions/$AG_ID/$SESS_ID/inbound.db "SELECT id, kind, recurrence, status FROM messages_in WHERE kind='task'"
```

### Check handoff

```bash
python3 -m json.tool logs/setup-migration/handoff.json
```

### Common issues

**Bot doesn't respond after switchover:**
1. Check both services aren't running: `systemctl --user list-units 'nanoclaw*'`
2. Check error log: `tail logs/nanoclaw.error.log`
3. Check sender policy: `sqlite3 data/v2.db "SELECT unknown_sender_policy FROM messaging_groups"` — must be `public` before owner is seeded
4. Check engage pattern: `sqlite3 data/v2.db "SELECT engage_mode, engage_pattern FROM messaging_group_agents"` — should be `pattern` / `.` for respond-to-everything

**Session not continuing from v1:**
1. Check continuation is set: see "Session continuation" query above
2. Check JSONL exists at the right path: `ls data/v2-sessions/<ag_id>/.claude-shared/projects/-workspace-agent/`
3. The v1 session JSONL should be copied from `-workspace-group/` to `-workspace-agent/` (v2 container CWD is `/workspace/agent`)

**Service switchover revert didn't work:**
1. The v2 service name is `nanoclaw-v2-<hash>` — find it: `systemctl --user list-units 'nanoclaw*'`
2. Manually stop: `systemctl --user stop <unit> && systemctl --user disable <unit>`
3. Restart v1: `systemctl --user start nanoclaw`

### Step logs

Each step writes raw output to `logs/migrate-steps/<step>.log`. Read these when a step fails:

```bash
cat logs/migrate-steps/1b-db.log
cat logs/migrate-steps/1d-sessions.log
```

## Key decisions

- `unknown_sender_policy` is set to `public` during migration so the bot responds immediately. The `/migrate-from-v1` skill tightens it after seeding the owner.
- `requires_trigger=0` in v1 takes priority over a non-empty `trigger_pattern` — it means "respond to everything."
- v1 `container_config.additionalMounts` is written directly to v2 `container.json` (same shape).
- v1 Claude Code sessions are copied from `-workspace-group/` to `-workspace-agent/` and the session ID is written to `outbound.db` as `continuation:claude` so the agent-runner resumes the same conversation.
- `exec claude "/migrate-from-v1"` at the end replaces the bash process — `write_handoff` is called explicitly before `exec` since EXIT traps don't fire on `exec`.
