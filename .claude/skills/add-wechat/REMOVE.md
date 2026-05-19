# Remove WeChat Channel

Undo `/add-wechat`.

### 1. Remove credentials

Delete WeChat lines from `.env`:

```bash
sed -i.bak '/^WECHAT_ENABLED=/d' .env && rm -f .env.bak
cp .env data/env/env
```

### 2. Remove adapter and import

```bash
rm -f src/channels/wechat.ts
sed -i.bak "/import '\.\/wechat\.js';/d" src/channels/index.ts && rm -f src/channels/index.ts.bak
```

### 3. Uninstall the package

```bash
pnpm remove wechat-ilink-client
```

### 4. Remove saved auth + sync state

```bash
rm -rf data/wechat
```

### 5. Remove DB wiring

```sql
-- Remove any sessions first (foreign key)
DELETE FROM sessions WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = 'wechat');
DELETE FROM messaging_group_agents WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE channel_type = 'wechat');
DELETE FROM messaging_groups WHERE channel_type = 'wechat';
```

### 6. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```
