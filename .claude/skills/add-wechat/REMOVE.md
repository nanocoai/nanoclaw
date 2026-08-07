# Remove WeChat Channel

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './wechat.js';
```

Then delete the copied adapter and its registration test:

```bash
rm -f src/channels/wechat.ts src/channels/wechat-registration.test.ts
```

## 2. Remove credentials

Remove `WECHAT_ENABLED` from `.env`, then re-sync to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## 3. Remove the package

```bash
pnpm uninstall wechat-ilink-client
```

## 4. Remove saved auth + sync state

```bash
rm -rf data/wechat
```

The channel's messaging groups, wirings, and conversation history are **left
intact** — you created those at runtime (wiring + use), not this skill's install,
so removal doesn't touch them. To purge them deliberately, delete them yourself
with `ncl messaging-groups delete <id>`.

## 5. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
