---
name: ncc
description: Install the ncc CLI — NanoClaw operational and health control from the command line (service start/stop/restart, a component health scan, and scheduled-task visibility). Use when you want to manage or monitor the host service without opening a chat app.
---

# ncc — NanoClaw Control

`ncc` is the host-side **operational and health** CLI, a sibling to `ncl`.
Where `ncl` does central-DB entity CRUD (agent groups, wirings, roles, …),
`ncc` covers what `ncl` does not: the host **service lifecycle**, a
**health scan** of every moving part, and **visibility into scheduled work**.

It is a standalone Python 3 script (stdlib only). It reads the SQLite DBs
directly and shells out to `launchctl`/`systemctl`/`docker`, so it keeps
working **even when the host service is down** — which is exactly when you
need `ncc health` and `ncc service start`.

## What it does

- `ncc service status|start|stop|restart` — manage the host service. Auto-detects
  **launchd** on macOS and **systemd (`--user`)** on Linux; discovers the unit
  itself (no hardcoded names).
- `ncc health [--json]` — scans the service, Docker daemon, central DB integrity,
  host disk, the OneCLI gateway, each agent container (autocompact thrashing,
  zombie processes, heartbeat freshness), recent permanent delivery failures, and
  overdue scheduled tasks. Prints `OK` / `WARN` / `FAIL`. **Exits 2 on a hard
  FAIL**, `0` otherwise (WARN is advisory) — safe to wire into monitoring.
- `ncc tasks [--json]` — running agent containers plus pending ad-hoc/one-off tasks.
- `ncc crons [--json]` — recurring scheduled tasks (their cron expression and next run).
- `ncc --version`, `ncc --help`, `ncc <command> --help`.

## Prerequisites

- **Python 3** (3.8+). Uses the standard library only — no `pip install`. Present
  by default on macOS and modern Linux.
- A NanoClaw checkout (this repo). `ncc` finds it via its own install location; set
  `NANOCLAW_HOME=/path/to/checkout` to override.
- **Docker** for the container/gateway checks. Without it those checks report `FAIL`/`WARN`;
  the rest still run.

## Install

Run these from the root of your NanoClaw checkout.

1. Copy the script into the checkout's `scripts/` directory and make it executable:

   ```bash
   mkdir -p scripts
   cp "${CLAUDE_SKILL_DIR}/scripts/ncc" scripts/ncc
   chmod +x scripts/ncc
   ```

2. Symlink it onto your `PATH` (same directory `ncl` uses, so they sit together):

   ```bash
   mkdir -p ~/.local/bin
   ln -sf "$(pwd)/scripts/ncc" ~/.local/bin/ncc
   ```

   Ensure `~/.local/bin` is on your `PATH`. If not, add this to `~/.zshrc` or `~/.bashrc`:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

3. Verify:

   ```bash
   ncc --version
   ncc service status
   ```

The symlink resolves back to `scripts/ncc` in your checkout, so `ncc` always
operates on the right install — run it from anywhere.

## Usage Examples

```bash
# Is the service up?
ncc service status

# Restart it (launchd on macOS, systemd --user on Linux — auto-detected)
ncc service restart

# Full health scan; exit code 2 signals a hard failure
ncc health
ncc health --json

# What is scheduled, and what is queued right now?
ncc crons
ncc tasks --json
```

Wire the health scan into monitoring — it exits non-zero only on a real failure:

```bash
ncc health --json > /tmp/ncc-health.json || echo "NanoClaw needs attention"
```

## Troubleshooting

**`ncc: no NanoClaw ... service ... found`**
`ncc` could not find the service unit. On macOS it looks for
`~/Library/LaunchAgents/com.nanoclaw*.plist`; on Linux for a
`nanoclaw*.service` user unit (`systemctl --user`). Confirm the service was
installed by the NanoClaw setup.

**Health says the DB is unreadable, or tasks/crons are empty when you expect rows**
`ncc` resolves the checkout from its own location. If you copied the script
somewhere unusual, point it at the checkout explicitly:

```bash
NANOCLAW_HOME=/path/to/nanoclaw ncc health
```

**Docker checks report FAIL/WARN**
`ncc` shells out to `docker`. Ensure Docker is running and `docker ps` works for
your user. The non-Docker checks (service, DB, disk, scheduler) still run regardless.

**Linux: `service` says no unit found, or `health` can't see the service — run `ncc` as the service's owning user**
NanoClaw's Linux service is a `systemctl --user` unit, which is only visible to
the user that owns it. Install and run `ncc` as **that** user (not `root`, not a
different account) so `ncc service …` and the service health check can see it.

**`ncc: command not found`**
`~/.local/bin` is not on your `PATH`. See install step 2.
