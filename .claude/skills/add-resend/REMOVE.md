# Remove Resend Email Channel

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './resend.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/resend.ts src/channels/resend-registration.test.ts
```

## 2. Remove credentials

Remove `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_FROM_NAME`, and `RESEND_WEBHOOK_SECRET` from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall @resend/chat-sdk-adapter
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
