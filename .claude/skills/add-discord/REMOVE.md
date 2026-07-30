# Remove Discord

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './discord.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/discord.ts src/channels/discord-registration.test.ts
```

## 2. Remove credentials

Remove `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_PUBLIC_KEY` from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall @chat-adapter/discord
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
