# Remove Signal

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './signal.js';
```

Then delete the copied adapter and its tests:

```bash
rm -f src/channels/signal.ts src/channels/signal-registration.test.ts src/channels/signal.test.ts
```

## 2. Remove credentials

Remove the `SIGNAL_*` lines from `.env`:

```bash
SIGNAL_ACCOUNT
SIGNAL_TCP_HOST
SIGNAL_TCP_PORT
SIGNAL_CLI_PATH
SIGNAL_MANAGE_DAEMON
SIGNAL_DATA_DIR
```

Then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
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

## 4. Unlink the Signal account (optional)

To unlink NanoClaw's device from the Signal account:

```bash
signal-cli -a +1YOURNUMBER removeDevice --deviceId <id>
```

Find the device id with `signal-cli -a +1YOURNUMBER listDevices`.
