# Remove Telegram

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './telegram.js';
```

Then delete the copied adapter, helpers, tests, registration test, and setup step:

```bash
rm -f src/channels/telegram.ts src/channels/telegram-registration.test.ts \
  src/channels/telegram-pairing.ts src/channels/telegram-markdown-sanitize.ts \
  src/channels/telegram-pairing.test.ts src/channels/telegram-markdown-sanitize.test.ts \
  setup/pair-telegram.ts
```

## 2. Remove the setup step

Delete this entry from the `STEPS` map in `setup/index.ts` (skip if already gone):

```typescript
'pair-telegram': () => import('./pair-telegram.js'),
```

## 3. Remove credentials

Remove `TELEGRAM_BOT_TOKEN` from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 4. Remove the package

```bash
pnpm uninstall @chat-adapter/telegram
```

## 5. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
