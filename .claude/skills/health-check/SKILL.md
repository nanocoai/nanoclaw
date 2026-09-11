---
name: health-check
description: "One-call health check for a NanoClaw checkout: is the host running, which service/image/containers belong to THIS checkout, recent errors, and an optional end-to-end ping through the CLI channel. Use when asked 'is it working', 'is nanoclaw running', 'check the host', 'start the host', 'health check', or before/after a restart, rebuild, or update. Diagnosis of a failure found here belongs to /debug."
---

# NanoClaw Health Check

Answers "is this install working?" in one command, scoped to the checkout you are standing in. Everything in NanoClaw v2 is keyed by an **install slug** (`sha1(<absolute checkout path>)[0:8]`, see `src/install-slug.ts`), so the launchd label, image tag, and container label differ per checkout. The script derives the slug so you never guess which of several installs on the machine is yours.

## When to use

- User asks whether NanoClaw is running, or to start/restart it and confirm it came back.
- Before and after `./container/build.sh`, `/update-nanoclaw`, or a service kickstart.
- As the first step of a bug report, before opening `/debug`.

## Workflow

1. Run the check:
   ```bash
   bash .claude/skills/health-check/scripts/health.sh          # read-only
   bash .claude/skills/health-check/scripts/health.sh --chat   # + sends "ping" to the wired agent
   NANOCLAW_ROOT=~/nanoclaw-local bash .claude/skills/health-check/scripts/health.sh   # another checkout
   ```
2. Read `RESULT:` on the last line. `healthy` means host, image, and data are all present for this checkout. Each `FAIL`/`WARN` line carries the fix command after `→`.
3. If the host is down, start it the way this checkout is meant to run:

   | Checkout kind | Start | Stop |
   |---|---|---|
   | Service install (plist exists) | `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-<slug>` | `launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-<slug>.plist` |
   | Linux service | `systemctl --user restart nanoclaw-v2-<slug>` | `systemctl --user stop nanoclaw-v2-<slug>` |
   | Dev checkout (no plist) | `pnpm run dev` (foreground, `LOG_LEVEL=debug` for container stderr) | Ctrl-C |

4. Re-run the script. If it is healthy but the agent does not answer in chat, hand off to `/debug` with the session dir from step 2 of the output.

## Reference

| Thing | Where |
|---|---|
| Slug, label, image name | `src/install-slug.ts`; `NANOCLAW_INSTALL_ID` overrides |
| Host process | `pnpm run dev` (tsx) or `dist/index.js` under the service |
| Admin socket / chat socket | `data/ncl.sock` (used by `bin/ncl`) / `data/cli.sock` (used by `pnpm run chat`) |
| Containers for this install | `docker ps --filter label=nanoclaw-install=<slug>` |
| Image for this install | `nanoclaw-agent-v2-<slug>:latest` |
| Logs | `logs/nanoclaw.error.log` first, then `logs/nanoclaw.log` |
| Ad-hoc DB query | `pnpm exec tsx scripts/q.ts data/v2.db "<sql>"` |

## Gotchas

- **`com.nanoclaw` is not the label.** Project docs still mention it, but every v2 install is `com.nanoclaw-v2-<slug>`. `launchctl list | grep nanoclaw` shows all installs on the machine; the script picks yours.
- **`nanoclaw-agent:latest` is not the image.** Same slug rule: `nanoclaw-agent-v2-<slug>:latest`. A `docker images | grep nanoclaw` listing several tags is normal on a machine with several checkouts.
- **A fresh clone has no `node_modules`, `data/`, or `.env`.** `bin/ncl` fails with `Command "tsx" not found` until `pnpm install --frozen-lockfile`, and `ncl` cannot answer until a host has been started here at least once.
- **`--chat` needs a `cli/local` wiring.** Created by `/init-first-agent` or `/manage-channels`. Without it, `data/cli.sock` exists but no agent replies and the script times out after two minutes.
- **Containers are `--rm`.** "No containers running" is the idle state, not a failure. A container that appears and vanishes within seconds is the failure; see `/debug` "Container exits immediately".
- **Two host processes for one checkout** means a stale `pnpm run dev` is fighting the service for the sockets. Stop the dev one.
