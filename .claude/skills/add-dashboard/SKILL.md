---
name: add-dashboard
description: Add a monitoring dashboard to NanoClaw. Installs @nanoco/nanoclaw-dashboard and a pusher that sends periodic JSON snapshots.
---

# /add-dashboard — NanoClaw Dashboard

Adds a local monitoring dashboard showing agent groups, sessions, channels, users, token usage, context windows, message activity, and real-time logs.

## Architecture

```
NanoClaw (pusher)              Dashboard (npm package)
┌──────────┐    POST JSON      ┌──────────────┐
│ collects │ ────────────────→ │ /api/ingest  │
│ DB data  │   every 60s       │ in-memory    │
│ tails    │ ────────────────→ │ /api/logs/   │
│ log file │   every 2s        │   push       │
└──────────┘                   │ serves UI    │
                               └──────────────┘
```

The pusher reads through two boundaries and never around them: central state via the async `DbDriver` (`getDb()`), per-session messages via the host mailbox seam (`withExistingMailboxSession`) — the same read path `ncl sessions history` uses. So the dashboard works on any composed backend, not just SQLite files under `data/v2-sessions/`.

## Steps

### 1. Install the npm package

```bash
pnpm install @nanoco/nanoclaw-dashboard@0.3.0
```

Pinned, like every other skill dependency: this package owns the snapshot contract, so a caret range could pull a version that renames snapshot fields while the pusher keeps posting the old shape — and the shipped tests mock the package, so they would not notice.

### 2. Copy the pusher module and its tests

Copy all three resource files into `src/`. The tests ship with the skill and run against the composed project — they're how you confirm the skill works and is wired in correctly.

```
.claude/skills/add-dashboard/resources/dashboard-pusher.ts       → src/dashboard-pusher.ts
.claude/skills/add-dashboard/resources/dashboard-pusher.test.ts  → src/dashboard-pusher.test.ts
.claude/skills/add-dashboard/resources/dashboard-wiring.test.ts  → src/dashboard-wiring.test.ts
```

- `dashboard-pusher.test.ts` — behavior: starts the pusher against a real test DB and the real mailbox seam, posts a snapshot to a fake dashboard, and tears down through the host's shutdown registry.
- `dashboard-wiring.test.ts` — the code edit in step 3: asserts (via the TS AST) that `index.ts` dynamically imports `./dashboard-pusher.js` and `await`s `startDashboard()` as colocated statements of `main()`, after DB init and before the boot-complete log. Delete or misplace the edit and this goes red. It also guards the pusher's two read boundaries, which stay invisible to a behavior test on an all-SQLite install.

### 3. Wire into src/index.ts

This is the skill's one integration point, and it's deliberately minimal and self-contained: all the startup logic lives in `dashboard-pusher.ts`, and the import is **colocated** with the call so the whole edit is a single block in one place — there's no separate top-of-file import to add (or to remember to remove).

Add this block inside `main()`, just before the `log.info('NanoClaw running')` line:

```typescript
  // Dashboard (optional; no-ops without DASHBOARD_SECRET)
  const { startDashboard } = await import('./dashboard-pusher.js');
  await startDashboard();
```

`startDashboard()` reads `DASHBOARD_SECRET`/`DASHBOARD_PORT` itself and no-ops if the secret is unset, so nothing else in core needs to change.

Teardown rides the host's own lifecycle registry: `dashboard-pusher.ts` registers `stopDashboard()` with `onHostShutdown()` at import time, so `shutdown()` → `stopHostModules()` stops the 60s push timer and the 2s log-tail timer and closes the dashboard socket — before `closeDb()`, so a push can never fire into a closed driver. Startup stays the single edit; the `tears down from the host shutdown path` test in `dashboard-pusher.test.ts` covers the teardown leg.

### 4. Add environment variables to .env

```
DASHBOARD_SECRET=<generate-a-random-secret>
DASHBOARD_PORT=3100
```

Generate the secret: `node -e "console.log('nc-' + require('crypto').randomBytes(16).toString('hex'))"`

**`DASHBOARD_SECRET` is the dashboard's only access control, and the dashboard is reachable from your local network.** `@nanoco/nanoclaw-dashboard@0.3.0` listens on `0.0.0.0` and its config accepts only `{ port, secret }` — there is no bind option to narrow it to loopback, so the pusher logs a warning naming the exposure at every boot. The snapshot carries full conversation content (`/api/overview`, `/api/messages`, `/api/logs`), so:

- Use the generator above. A guessable secret is the whole security model.
- On a shared or untrusted network, block the port at the firewall and reach the UI over an SSH tunnel: `ssh -L 3100:127.0.0.1:3100 <host>`.
- Confirm what is listening: `ss -lptn | grep <DASHBOARD_PORT>` (Linux) or `lsof -nP -iTCP:<DASHBOARD_PORT> -sTCP:LISTEN` (macOS).

### 5. Build, test, and restart

Run from your NanoClaw project root:

```bash
pnpm run build
pnpm exec vitest run src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts   # behavior + wiring
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Run `build` **before** the tests: it's what guards the `@nanoco/nanoclaw-dashboard` dependency. `dashboard-pusher.ts` reaches the package through `await import('@nanoco/nanoclaw-dashboard')`, so if step 1 was skipped, `pnpm run build` fails with `TS2307: Cannot find module '@nanoco/nanoclaw-dashboard'`. The behavior test deliberately *mocks* that package — its `startDashboard` binds a real dashboard port, a side effect we don't want in a test — so the test alone would pass with the dependency missing. Build is therefore the leg that verifies the dependency is installed; keep it ahead of the tests in the validate step.

### 6. Verify (runtime smoke check)

Once the service is restarted, confirm the dashboard is live:

```bash
curl -s -H "Authorization: Bearer <secret>" http://localhost:3100/api/status
curl -s -H "Authorization: Bearer <secret>" http://localhost:3100/api/overview
```

`/api/status` returns `{"ok":true,...}`; without the header it returns `{"error":"Unauthorized"}`, which is itself proof the server is up and enforcing the secret. `hasData` stays `false` until the first push lands.

Open `http://localhost:3100/dashboard` in a browser.

## Dashboard Pages

| Page | Shows |
|------|-------|
| Overview | Stats, token usage + cache hit rate, context windows, activity chart |
| Agent Groups | Sessions, wirings, destinations, members, admins |
| Sessions | Status, container state, context window usage bars |
| Channels | Live/offline status, messaging groups, sender policies |
| Messages | Per-session inbound/outbound messages (timestamp, kind, content) |
| Users | Privilege hierarchy: owner > admin > member |
| Logs | Real-time log streaming with level filter |

## Troubleshooting

- **"No data yet"**: Wait 60s for first push, or check logs for push errors
- **401 errors**: Verify `DASHBOARD_SECRET` matches in `.env`
- **Port conflict**: Change `DASHBOARD_PORT` in `.env`
- **No logs**: Check `logs/nanoclaw.log` exists
- **Host won't start — `Upgrade tripwire: install not on the sanctioned path`**: this install has no upgrade marker, which is normal in a fresh clone or worktree and blocks step 5's restart before the dashboard ever loads. Record the current state with the project's own command, then restart: `pnpm exec tsx scripts/upgrade-state.ts set`
- **Sessions or messages missing from the dashboard**: the Messages page and the activity chart list sessions from the central `sessions` table, so a session whose row was deleted no longer appears even if old data lingers on disk. A single session busier than 500 messages per side in 24h contributes only its newest 500 to the chart.

## Removal

See [REMOVE.md](REMOVE.md).
