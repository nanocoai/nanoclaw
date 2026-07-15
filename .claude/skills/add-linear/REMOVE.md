# Remove Linear

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './linear.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/linear.ts src/channels/linear-registration.test.ts
```

## 2. Remove credentials

Remove `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_BOT_USERNAME`, and `LINEAR_TEAM_KEY` from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall @chat-adapter/linear
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
