# 07 — Data restoration from `/tmp/nanoclaw-state/`

## Problem

v2's DB schema is fundamentally different from v1's:
- v1: single `store/messages.db` with mixed tables
- v2: central `data/v2.db` (entities, wiring, approvals, etc.) + per-session `data/v2-sessions/<id>/inbound.db` and `outbound.db`

User explicit 2026-05-27: do NOT run `migrate-v2.sh`. Plan is intent-based, the DB will be reseeded; only the group's filesystem data and a re-created agent group/wiring carry over.

## What we keep vs drop

| Source | What | Action | Why |
|---|---|---|---|
| `store/messages.db: chats` | WhatsApp chat metadata sync | DROP | Telegram only, irrelevant |
| `store/messages.db: messages` | 234 chat history messages | DROP | Recoverable from Telegram; v2 doesn't ingest old v1 history; agent has its own `conversations/` |
| `store/messages.db: registered_groups` | 1 row (`tg:42582289`, `telegram_main`, trigger `@Andy`) | RESEED manually | One row, easy to recreate in v2's new entity model |
| `store/messages.db: router_state` | last-processed timestamps | DROP | v2 has its own state machinery |
| `store/messages.db: scheduled_tasks` | 5 live cron + 4 dead | DROP (see [05-business-logic.md](05-business-logic.md)) | Agent re-creates via `schedule_task` |
| `store/messages.db: sessions` | v1 session rows | DROP | v2 has new session model |
| `store/messages.db: task_run_logs` | execution history | DROP | informational only |
| `groups/telegram_main/CLAUDE.md` | agent persona + HTML formatting block | KEEP — review against v2 conventions | Source of truth for what agent knows |
| `groups/telegram_main/scripts/` | Bybit + Valtrex + voice | KEEP (see [05-business-logic.md](05-business-logic.md)) | Business logic |
| `groups/telegram_main/config/groq.json` | Groq API key | KEEP, but move into `.env` as `GROQ_API_KEY` | Idiomatic v2 secret location |
| `groups/telegram_main/.tailscale-state/` | Tailscale node identity | KEEP — copy as-is | Reinstall = re-invite |
| `groups/telegram_main/bin/` | agent-installed binaries | KEEP | Save the agent re-installing them |
| `groups/telegram_main/node_modules/` | puppeteer-extra, ssh2, tweetnacl | DROP, rebuild | Re-run `npm install` via v2's group init |
| `groups/telegram_main/package.json` | dependency declarations | KEEP | Driver for the rebuild |
| `groups/telegram_main/memory/` | agent's persistent notes | KEEP | Agent's working memory |
| `groups/telegram_main/conversations/` | agent's own conversation log | KEEP | Cross-session memory |
| `groups/telegram_main/data/` | per-group app data | KEEP, audit case-by-case | Mostly portable |
| `groups/telegram_main/attachments/` | voice + photos from chat | DROP | Old chat media |
| `groups/telegram_main/logs/` | container logs | DROP | Old debug logs |
| `groups/main/CLAUDE.md` | control-group persona | KEEP, compare against v2's seed | Lightweight |
| `groups/global/CLAUDE.md` | cross-group memory | KEEP, compare against v2's seed | Lightweight |
| `data/sessions/*/agent-runner-src/` | host-mount copy of agent-runner | DROP | v2 generates this differently |
| `data/ipc/` | IPC task files | DROP | v2 has no IPC dir |

## Reseed registered group in v2

v2 entity model is: `users → messaging_groups → agent_groups → sessions` (see v2 CLAUDE.md).

The v1 row `tg:42582289 / Main / telegram_main / @Andy / isMain=1 / requiresTrigger=0` maps to:

1. **User**: the Telegram operator (you). Created during `/init-first-agent` or `ncl users create`.
2. **Messaging group**: one Telegram DM/chat at `tg:42582289` with `unknown_sender_policy='allow'` (or whatever).
3. **Agent group**: an `agent_group` named `Main` with:
   - workspace: `groups/telegram_main/`
   - personality / CLAUDE.md: seeded from the carried-over file
   - container config: standard + any custom mounts (Tailscale socket if needed — see [05-business-logic.md](05-business-logic.md))
4. **Wiring**: `messaging_group → agent_group` with `session_mode` ("single" for DM, or whatever the v2 default is) and `trigger_rules` (no trigger needed since it's the main DM).

The skill **`/init-first-agent`** walks through 1–4 for a DM. Use it.

## How to apply (Stage 3)

```bash
# 1. Bring snapshot to workspace
mkdir -p groups/telegram_main
rsync -a --exclude=node_modules --exclude=attachments --exclude=logs \
      /tmp/nanoclaw-state/groups/telegram_main/ groups/telegram_main/

# 2. Extract Groq key into .env
node -e 'console.log("GROQ_API_KEY=" + require("/tmp/nanoclaw-state/groups/telegram_main/config/groq.json").api_key)' >> .env

# 3. Walk through /init-first-agent
# (interactive — operator runs it, agent group is created, DM is wired)

# 4. Drop the old config/groq.json from group folder (now in .env)
rm groups/telegram_main/config/groq.json
```

## Validation

After init-first-agent + reseed:
- `ncl groups list` → shows one entry `Main`
- `ncl messaging-groups list` → shows `tg:42582289`
- `ncl wirings list` → shows one wiring connecting them
- Sending a Telegram message → agent responds
- Then move to Stage 4 (capabilities)
