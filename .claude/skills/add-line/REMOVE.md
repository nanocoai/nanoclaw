# Remove LINE

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './line.js';
```

Then delete the copied adapter and its tests:

```bash
rm -f src/channels/line.ts \
      src/channels/line-signature.ts \
      src/channels/line-signature.test.ts \
      src/channels/line-registration.test.ts
```

## 2. Remove credentials

Remove these lines from `.env` (and re-sync the container copy: `cp .env data/env/env`):

```bash
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
```

## 3. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## 4. Clean up on the LINE side (optional)

In the [LINE Developers console](https://developers.line.biz/console/): clear the channel's **Webhook URL**, disable **Use webhook**, and revoke the channel access token if it won't be reused. If you ran a tunnel just for LINE (e.g. a zrok share), stop it and release the reserved name.

## Verification

```bash
grep -i "line channel" logs/nanoclaw.log | tail -3
```

Expected: no `LINE channel ready` entry after the last restart.
