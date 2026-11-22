# Remove Matrix

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './matrix.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/matrix.ts src/channels/matrix-registration.test.ts \
  src/channels/matrix-instances.ts src/channels/matrix-instances.test.ts
```

## 2. Remove credentials

Remove the Matrix env vars apply set — `MATRIX_BASE_URL`, `MATRIX_USER_ID`, `MATRIX_BOT_USERNAME`, and whichever auth path you chose (`MATRIX_USERNAME` + `MATRIX_PASSWORD`, or `MATRIX_ACCESS_TOKEN`) — from `.env`, plus `MATRIX_INSTANCES` and any `MATRIX_*_<NAME>` variables of additional accounts.

## 3. Remove the package

```bash
pnpm pkg delete 'pnpm.patchedDependencies[@beeper/chat-adapter-matrix@0.2.0]'
pnpm uninstall @beeper/chat-adapter-matrix
rm -f patches/@beeper__chat-adapter-matrix@0.2.0.patch
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
