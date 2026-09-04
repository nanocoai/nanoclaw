# Remove Web Chat Channel

Reverses everything `/add-webchat` applied. Safe to run partially — every step
is a no-op if the thing is already gone.

## 1. Unwire the channel (host service running)

```bash
pnpm run ncl wirings list          # find the wiring for the webchat messaging group
pnpm run ncl wirings delete <wiring-id>
pnpm run ncl messaging-groups list # find the webchat messaging group
pnpm run ncl messaging-groups delete <mg-id>
```

## 2. Remove the source files

```bash
rm -f src/channels/webchat.ts src/channels/webchat.test.ts src/channels/webchat-registration.test.ts
```

## 3. Remove the barrel import

Delete this line from `src/channels/index.ts`:

```typescript
import './webchat.js';
```

## 4. Remove the .env entries

Delete the `WEBCHAT_ENABLED`, `WEBCHAT_CHANNEL_PORT`, `WEBCHAT_AUTH_TOKEN`,
and `WEBCHAT_PLATFORM_ID` lines from `.env`.

## 5. Rebuild and restart

```bash
pnpm run build
systemctl --user restart <your-nanoclaw-unit>   # or launchctl on macOS
```

## Verify removal

`pnpm exec vitest run src/channels/` passes with no webchat files, and
`curl http://127.0.0.1:8767/` refuses to connect after the restart.
