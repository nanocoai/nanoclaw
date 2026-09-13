---
name: setup-system-digest
description: Install the daily system-state digest — sets up the script and timer that diffs agent groups, channels, wirings, and scheduled tasks, then delivers a summary message to your primary channel only when something changed. Zero LLM tokens when nothing changed.
---

# System Digest

Installs a daily script that diffs NanoClaw's configuration state and delivers a summary to your primary channel when anything changes. If nothing changed, it exits silently — no message, no tokens.

The script (`scripts/system-digest.ts`) writes directly to the delivery agent's `outbound.db`, bypassing the agent container entirely.

## What it tracks

- Agent groups (name, provider, model, CLI scope, MCP servers, packages)
- Messaging groups (name, access policy)
- Wirings (session mode, engage mode/pattern)
- Scheduled tasks (recurrence changes, new/removed tasks)
- Global model defaults from `.env`
- Alerts: pending approvals, new unregistered sender attempts

## Install Steps

### 1. Discover the delivery target

Find the owner and their primary DM channel:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT mg.id AS mg_id, mg.channel_type, mg.platform_id,
         mga.agent_group_id
  FROM messaging_groups mg
  JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
  WHERE mg.is_group = 0
  ORDER BY mg.created_at ASC
"
```

Pick the preferred DM channel. Note the `mg_id`, `channel_type`, `platform_id`, and `agent_group_id`.

### 2. Copy the script (new installs only)

If `scripts/system-digest.ts` does not already exist:

```bash
cp "${CLAUDE_SKILL_DIR}/scripts/system-digest.ts" scripts/system-digest.ts
```

### 3. Patch the delivery constants

Edit the four `PLACEHOLDER_*` constants at the top of `scripts/system-digest.ts`:

```typescript
const DELIVERY_AGENT_GROUP_ID = '<agent_group_id from step 1>';
const DELIVERY_MG_ID = '<mg_id from step 1>';
const DELIVERY_PLATFORM_ID = '<platform_id from step 1>';
const DELIVERY_CHANNEL_TYPE = '<channel_type from step 1>';
```

### 4. Choose a daily delivery time

Ask the user what time they want the digest delivered. Compute the UTC equivalent using `TIMEZONE` from `src/config.ts`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT 1" 2>/dev/null
node -e "
const { TIMEZONE } = require('./src/config.js');
const d = new Date();
d.setHours(<desired_local_hour>, 0, 0, 0);
const utcH = d.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'UTC' });
console.log('UTC hour:', utcH, '(TIMEZONE:', TIMEZONE + ')');
"
```

### 5a. Linux (systemd) — create timer

```bash
cat > ~/.config/systemd/user/nanoclaw-snapshot.service << 'EOF'
[Unit]
Description=NanoClaw system snapshot
After=network.target

[Service]
Type=oneshot
ExecStart=/home/<USER>/nanoclaw-v2/node_modules/.bin/tsx /home/<USER>/nanoclaw-v2/scripts/system-digest.ts
WorkingDirectory=/home/<USER>/nanoclaw-v2
Environment=HOME=/home/<USER>
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/<USER>/.local/bin
StandardOutput=append:/home/<USER>/nanoclaw-v2/logs/system-digest.log
StandardError=append:/home/<USER>/nanoclaw-v2/logs/system-digest.log
EOF

cat > ~/.config/systemd/user/nanoclaw-snapshot.timer << 'EOF'
[Unit]
Description=Daily NanoClaw system snapshot

[Timer]
OnCalendar=*-*-* <UTC_HOUR>:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-snapshot.timer
```

Replace `<USER>` with the actual username (`echo $USER`) and `<UTC_HOUR>` with the value from step 4.

### 5b. macOS (launchd) — create plist

```bash
cat > ~/Library/LaunchAgents/com.nanoclaw.snapshot.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw.snapshot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<USER>/nanoclaw-v2/node_modules/.bin/tsx</string>
    <string>/Users/<USER>/nanoclaw-v2/scripts/system-digest.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/<USER>/nanoclaw-v2</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer><LOCAL_HOUR></integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/<USER>/nanoclaw-v2/logs/system-digest.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/<USER>/nanoclaw-v2/logs/system-digest.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/<USER></string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.nanoclaw.snapshot.plist
```

Replace `<USER>` with the actual username and `<LOCAL_HOUR>` with the desired local hour (integer, 24h).

### 6. Run once to initialize the baseline

```bash
pnpm exec tsx scripts/system-digest.ts
```

This saves `data/system-digest.json` as the baseline. The first run never delivers a message — it only stores state to diff against.

Verify the snapshot was written:
```bash
ls -lh data/system-digest.json
```

### 7. Verify delivery

Make a small traceable change (e.g., rename a messaging group with `ncl messaging-groups update --id <id> --name "test"`), run the script again, then revert:

```bash
pnpm exec tsx scripts/system-digest.ts
```

A message should arrive on the delivery channel. Revert the test change and run once more to reset the baseline.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/system-digest.ts` | The snapshot + diff + delivery script |
| `data/system-digest.json` | Persisted baseline snapshot |
| `logs/system-digest.log` | Script output log |
| `${CLAUDE_SKILL_DIR}/scripts/system-digest.ts` | Skill's generalized template |
