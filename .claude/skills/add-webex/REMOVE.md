# Remove Webex

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './webex.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/webex.ts src/channels/webex-registration.test.ts
```

## 2. Remove credentials

Remove `WEBEX_BOT_TOKEN` and `WEBEX_WEBHOOK_SECRET` from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall @bitbasti/chat-adapter-webex
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
