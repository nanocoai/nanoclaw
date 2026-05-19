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

## Steps

### 1. Install the npm package

```bash
pnpm install @nanoco/nanoclaw-dashboard
```

### 2. Copy the pusher module

Copy the resource file into src:

```
.claude/skills/add-dashboard/resources/dashboard-pusher.ts → src/dashboard-pusher.ts
```

### 3. Add exports to src/db/index.ts

Add these two export blocks if not already present:

```typescript
// After the messaging-groups exports, add:
export {
  getMessagingGroupsByAgentGroup,
} from './messaging-groups.js';

// Before the credentials exports, add:
export {
  createDestination,
  getDestinations,
  getDestinationByName,
  getDestinationByTarget,
  hasDestination,
  deleteDestination,
} from './agent-destinations.js';
```

### 4. Wire into src/index.ts

Add the `readEnvFile` import at the top if not already present:

```typescript
import { readEnvFile } from './env.js';
```

Add after step 7 (OneCLI approval handler), before the `log.info('NanoClaw running')` line:

```typescript
  // 8. Dashboard (optional)
  const dashboardEnv = readEnvFile(['DASHBOARD_SECRET', 'DASHBOARD_PORT']);
  const dashboardSecret = process.env.DASHBOARD_SECRET || dashboardEnv.DASHBOARD_SECRET;
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || dashboardEnv.DASHBOARD_PORT || '3100', 10);
  if (dashboardSecret) {
    const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
    const { startDashboardPusher } = await import('./dashboard-pusher.js');
    startDashboard({ port: dashboardPort, secret: dashboardSecret });
    startDashboardPusher({ port: dashboardPort, secret: dashboardSecret, intervalMs: 60000 });
  } else {
    log.info('Dashboard disabled (no DASHBOARD_SECRET)');
  }
```

### 5. Add environment variables to .env

```
DASHBOARD_SECRET=<generate-a-random-secret>
DASHBOARD_PORT=3100
```

Generate the secret: `node -e "console.log('nc-' + require('crypto').randomBytes(16).toString('hex'))"`

### 6. Build and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

### 7. Verify

```bash
curl -s http://localhost:3100/api/status
curl -s -H "Authorization: Bearer <secret>" http://localhost:3100/api/overview
```

Open `http://localhost:3100/dashboard` in a browser.

## Dashboard Pages

| Page | Shows |
|------|-------|
| Overview | Stats, token usage + cache hit rate, context windows, activity chart |
| Agent Groups | Sessions, wirings, destinations, members, admins |
| Sessions | Status, container state, context window usage bars |
| Channels | Live/offline status, messaging groups, sender policies |
| Messages | Per-session inbound/outbound messages |
| Users | Privilege hierarchy: owner > admin > member |
| Logs | Real-time log streaming with level filter |

## Troubleshooting

- **"No data yet"**: Wait 60s for first push, or check logs for push errors
- **401 errors**: Verify `DASHBOARD_SECRET` matches in `.env`
- **Port conflict**: Change `DASHBOARD_PORT` in `.env`
- **No logs**: Check `logs/nanoclaw.log` exists

## Removal

```bash
pnpm uninstall @nanoco/nanoclaw-dashboard
rm src/dashboard-pusher.ts
# Remove the dashboard block from src/index.ts
# Remove DASHBOARD_SECRET and DASHBOARD_PORT from .env
pnpm run build
```
