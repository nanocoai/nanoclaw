# 05 — Business logic (Bybit P2P, Valtrex, Tailscale)

> ✅ **VERIFIED** against v2 source on 2026-05-27:
> - `ncl groups config add-package`: confirmed at `origin/main:src/cli/resources/groups.ts:304-336`
> - `packages_npm` storage: confirmed at `origin/main:src/db/container-configs.ts` (JSON_COLUMNS)
> - `additional_mounts` column exists but no dedicated CLI verb found
> - CLAUDE.local.md auto-migration: confirmed at `origin/main:src/claude-md-compose.ts:144-187`

User explicit 2026-05-27: preserve functionality, port close to v1 but expose through v2's mechanisms.

## Files — straight copy

v2 still uses `groups/<folder>/` for per-agent-group filesystem (verified at `origin/main:src/group-init.ts`). The container mounts it r/w. Scripts/state/binaries port 1:1.

```bash
# After Stage 3 (agent group created, group folder exists)
rsync -a --exclude=node_modules --exclude=attachments --exclude=logs \
      /tmp/nanoclaw-state/groups/telegram_main/ groups/telegram_main/
```

**CLAUDE.md rename is automatic.** `origin/main:src/claude-md-compose.ts:144-187` migrates `CLAUDE.md` → `CLAUDE.local.md` on first spawn if the local file doesn't exist. Operator does not manually rename.

## NPM dependencies (puppeteer-extra, ssh2, tweetnacl)

**v2 bakes npm packages into the container image** — not per-group `npm install`, not runtime install.

Verified at `origin/main:src/cli/resources/groups.ts:304-336`:

```
'config add-package': {
  Add a package to a group. Requires `ncl groups restart --rebuild` to take effect.
  Use --id <group-id> and --apt <pkg> or --npm <pkg>.
}
```

So:

```bash
ncl groups config add-package --id <agent-group-id> --npm puppeteer-extra
ncl groups config add-package --id <agent-group-id> --npm puppeteer-extra-plugin-stealth  # if used
ncl groups config add-package --id <agent-group-id> --npm ssh2
ncl groups config add-package --id <agent-group-id> --npm tweetnacl

ncl groups restart --id <agent-group-id> --rebuild
```

Storage: `packages_npm` JSON array column in `container_configs` table (verified at `origin/main:src/db/container-configs.ts`).

The `--rebuild` is mandatory — packages don't appear in the running container until image rebuild. There's also `install_packages` from the agent's side (referenced in `groups.ts:336`) — agent can request packages via a self-mod tool; that path triggers an approval flow. For the initial setup, doing it via `ncl` from the host is simpler.

Drop the v1 per-group `package.json` after — v2 sources package list from the DB row, not from a per-group file.

## Scheduled tasks — agent re-creates via `schedule_task` tool

v2 scheduling is "the agent owns its schedule" (verified at `origin/main:src/modules/scheduling/index.ts`). Five action handlers are registered: `schedule_task`, `cancel_task`, `pause_task`, `resume_task`, `update_task`. The agent calls these via its MCP tool surface; host's delivery action handler creates the recurring tasks as `messages_in` rows with `kind='task'` (piggybacks on core schema, no separate scheduling table).

After the group is wired (Stage 3 done), send one Telegram message to the agent:

```
Re-create my recurring tasks:

1. `0 4 * * *` — daily Bybit P2P report + chart, runs `scripts/bybit_report.sh`
2. `*/5 * * * *` — Bybit P2P data collector, runs `scripts/bybit_collect.sh`
3. `*/5 * * * *` — Bybit P2P USDT alert, runs `scripts/bybit_alert.sh`
4. `0 6 * * *` — morning script, runs `scripts/morning.sh`
5. `*/5 * * * *` — Bybit-related, runs `scripts/bybit_X.sh`
```

(Exact script names + commands taken from `store/messages.db:scheduled_tasks` on the v1 server. Fill in from snapshot before sending.)

Agent will call `schedule_task` 5 times.

## Tailscale — Path A (host-side socket mount)

User decision 2026-05-27: «Мне нужно только для того, чтобы через него потенциально могли ходить какие-то отдельные сервисы, которые завязаны на домашнюю мою сеть.» Translation: access to home-network services through Tailscale — no need for a separate agent node identity. Path A.

### What we do

- `tailscaled` runs on the NixOS host (already in your NixOS module — verify when porting to v2)
- Container mounts `/var/run/tailscale/tailscaled.sock` r/w via `container_configs.additional_mounts`
- Inside container, `tailscale` CLI talks to the socket → host's identity → home network reachable

### Verified

- `additional_mounts` JSON column exists in `container_configs` (verified at `origin/main:src/db/container-configs.ts`, JSON_COLUMNS set)
- No dedicated `ncl groups config add-mount` verb was found, but the row can be updated via `ncl groups config update` JSON path OR via direct SQL through the in-tree wrapper (per v2 `CLAUDE.md`: `pnpm exec tsx scripts/q.ts <db> "<sql>"`)

### Steps

```bash
# 1. Ensure tailscaled runs on host (NixOS module — when we update nixserver)

# 2. Add the socket mount to the agent group's container config
# First check CLI shape:
ncl groups config help
# Look for `update` verb + mount-related flag, OR `add-mount` verb.
# Per v2 CLAUDE.md, additional_mounts is a JSON column — likely settable via:
ncl groups config update --id <agent-group-id> \
  --additional-mounts '[{"host":"/var/run/tailscale","container":"/var/run/tailscale","readonly":false}]'

# If that flag form doesn't exist, fall back to direct SQL:
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '[{\"host\":\"/var/run/tailscale\",\"container\":\"/var/run/tailscale\",\"readonly\":false}]' WHERE agent_group_id = '<id>'"

# 3. Add tailscale CLI binary as an apt package
ncl groups config add-package --id <agent-group-id> --apt tailscale

# 4. Rebuild + restart
ncl groups restart --id <agent-group-id> --rebuild
```

### What we drop from v1

- `.tailscale-state/` from the snapshot — **not needed** in Path A. Identity lives on the host now, no per-container state.
- Tailscale auth key — host already authenticated, agent just uses the socket.

### What to verify on first run

```bash
# Inside the agent's container:
tailscale status         # should show the host's identity + tailnet peers
tailscale ping <home-host-on-tailnet>   # should succeed
```

If both work, Tailscale Path A is done.

## How to apply (Stage 3 + Stage 4.2)

1. **Stage 3.1** — `rsync` group files (skip `node_modules`, `attachments`, `logs`)
2. **Stage 3.2** — copy `CLAUDE.md` into the group folder; the composer renames it to `CLAUDE.local.md` automatically on first spawn (no manual step)
3. **Stage 3.3** — pick Tailscale path A or B; apply via `additional_mounts` + `--apt tailscale`
4. **Stage 3.4** — `ncl groups config add-package --npm` for each of: `puppeteer-extra`, `ssh2`, `tweetnacl` (+ stealth if used)
5. **Stage 3.5** — `ncl groups restart --rebuild`
6. **Stage 4.2** — ask agent via Telegram to re-create the 5 scheduled tasks

## Things to verify before Stage 3 (small recon)

- Exact script filenames in `/tmp/nanoclaw-state/groups/telegram_main/scripts/` (INVENTORY.md only lists prefixes)
- Exact cron strings + commands in v1's `store/messages.db:scheduled_tasks` table
- Whether the agent's container in v1 had any non-default container config (Tailscale path = identity decision input)
- Whether `ncl groups config` has a mount-related verb OR if `additional_mounts` is set via raw `config update` JSON (one CLI command away from confirming)
