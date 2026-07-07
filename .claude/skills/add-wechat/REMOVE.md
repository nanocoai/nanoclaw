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

## 5. Remove DB wiring

```sql
-- Remove any sessions first (foreign key)
DELETE FROM sessions WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = 'wechat');
DELETE FROM messaging_group_agents WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = 'wechat');
DELETE FROM messaging_groups WHERE channel_type = 'wechat';
```

## 6. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
