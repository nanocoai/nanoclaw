# Remove Mailtrap Email Channel

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './mailtrap.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/mailtrap.ts src/channels/mailtrap-registration.test.ts
```

## 2. Remove credentials

Remove `MAILTRAP_API_TOKEN`, `MAILTRAP_FROM_ADDRESS`, `MAILTRAP_FROM_NAME`, and `MAILTRAP_WEBHOOK_SECRET` from `.env`.

## 3. Remove the package

```bash
pnpm uninstall @mailtrap/chat-sdk-adapter
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
