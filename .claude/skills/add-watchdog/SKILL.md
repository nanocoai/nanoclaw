---
name: add-watchdog
description: Install the NanoClaw watchdog — a systemd timer that runs every 15 minutes to detect failed/stuck digest sessions and invokes Claude Code to auto-remediate before the user notices digests stopped. Detects three failure modes: dead recurring series (status=failed AND recurrence IS NOT NULL), stuck processing (status=processing >45 min with stale heartbeat), and service down. Use when the user wants proactive digest failure detection and auto-recovery.
---

# add-watchdog

Installs `scripts/watchdog.ts` and a systemd timer that runs it every 15 minutes.
On detecting an issue, the watchdog invokes `claude --dangerously-skip-permissions -p "..."` to fix it and inject a WhatsApp notification task.

## Prerequisites

- NanoClaw is already set up and running (`systemctl --user status nanoclaw-v2-*.service` returns active)
- `claude` CLI is authenticated (`claude whoami` works without interactive prompt)
- Running from the NanoClaw repo root

## Install

### 1. Detect the NanoClaw service name and repo path

```bash
systemctl --user list-units 'nanoclaw-v2-*.service' --no-legend | awk '{print $1}'
pwd
```

Record both values — needed to configure the watchdog.

### 2. Copy scripts

```bash
cp "${CLAUDE_SKILL_DIR}/scripts/watchdog.ts"        scripts/watchdog.ts
cp "${CLAUDE_SKILL_DIR}/scripts/watchdog-prompt.ts" scripts/watchdog-prompt.ts
```

### 3. Patch service name and repo path

Replace the placeholders in the copied scripts:

```bash
REPO="$(pwd)"
SERVICE="<service name from step 1>"

sed -i "s|__NANOCLAW_SERVICE_NAME__|${SERVICE}|g" scripts/watchdog.ts
sed -i "s|__NANOCLAW_SERVICE_NAME__|${SERVICE}|g" scripts/watchdog-prompt.ts
sed -i "s|__NANOCLAW_REPO__|${REPO}|g"            scripts/watchdog-prompt.ts
```

### 4. Generate setup files

```bash
cp "${CLAUDE_SKILL_DIR}/setup/watchdog.timer"              setup/watchdog.timer
cp "${CLAUDE_SKILL_DIR}/setup/install-watchdog-timer.sh"   setup/install-watchdog-timer.sh
chmod +x setup/install-watchdog-timer.sh

# Generate watchdog.service with correct paths
REPO="$(pwd)"
sed "s|__NANOCLAW_REPO__|${REPO}|g" "${CLAUDE_SKILL_DIR}/setup/watchdog.service" > setup/watchdog.service
```

### 5. Install the systemd timer

```bash
bash setup/install-watchdog-timer.sh
```

### 6. Verify installation

```bash
# Dry-run — should print "no issues detected" (or list real issues if any)
pnpm exec tsx scripts/watchdog.ts --dry-run

# Confirm timer is scheduled
systemctl --user list-timers | grep watchdog
```

## Usage

The watchdog runs automatically every 15 minutes via systemd.

Manual invocation:

```bash
# Dry run — detect only, no claude invocation
pnpm exec tsx scripts/watchdog.ts --dry-run

# Normal run — detect and auto-remediate
pnpm exec tsx scripts/watchdog.ts

# Override paths
pnpm exec tsx scripts/watchdog.ts --dry-run --sessions-dir /path/to/data/v2-sessions --repo /path/to/nanoclaw
```

Logs at `logs/watchdog.log` — each run appends timestamped entries; claude invocations include full output.

## What it detects

| Check | Condition | Fix |
|-------|-----------|-----|
| Dead recurring | `status='failed' AND recurrence IS NOT NULL` | Reset `tries=0`, `status='pending'` |
| Stuck processing | `status='processing'` >45 min + stale heartbeat | Reset row, stop stuck container |
| Service down | `systemctl --user is-active` non-zero | `systemctl --user restart` |

After each fix, the watchdog instructs Claude to inject a `kind='task'` row into `inbound.db` so the agent notifies the user via their channel.

## Troubleshooting

### `claude` not found by systemd

Systemd services may have a restricted PATH. Find the full path and hard-code it in the service file:

```bash
which claude
# Then edit setup/watchdog.service — replace 'pnpm exec tsx scripts/watchdog.ts'
# with the full command, e.g. using the full claude path
```

Reinstall after editing: `bash setup/install-watchdog-timer.sh`

### Watchdog finds no sessions

Check that `data/v2-sessions/` exists and contains `<agent_group_id>/<session_id>/inbound.db`. Run `pnpm exec tsx scripts/watchdog.ts --dry-run` from the repo root.

### Timer not firing

```bash
systemctl --user status nanoclaw-watchdog.timer
systemctl --user status nanoclaw-watchdog.service
journalctl --user -u nanoclaw-watchdog.service --since "1 hour ago"
```

### `--dangerously-skip-permissions` requires interactive auth

Run `claude whoami` to verify auth works non-interactively. If it prompts, complete auth first then re-run the watchdog.
