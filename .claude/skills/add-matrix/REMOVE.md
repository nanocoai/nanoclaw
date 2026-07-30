# Remove Matrix

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './matrix.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/matrix.ts src/channels/matrix-registration.test.ts
```

## 2. Remove credentials

Remove the Matrix env vars apply set — `MATRIX_BASE_URL`, `MATRIX_USER_ID`, `MATRIX_BOT_USERNAME`, and whichever auth path you chose (`MATRIX_USERNAME` + `MATRIX_PASSWORD`, or `MATRIX_ACCESS_TOKEN`) — from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall @beeper/chat-adapter-matrix
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
