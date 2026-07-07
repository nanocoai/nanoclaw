# Remove Microsoft Teams

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './teams.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/teams.ts src/channels/teams-registration.test.ts
```

## 2. Remove credentials

Remove the `TEAMS_*` lines from `.env`, then re-sync to the container:

```bash
TEAMS_APP_ID
TEAMS_APP_PASSWORD
TEAMS_APP_TENANT_ID
TEAMS_APP_TYPE
```

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall @chat-adapter/teams
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
