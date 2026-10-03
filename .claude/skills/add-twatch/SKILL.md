---
name: add-twatch
description: Add T-Watch S3 as a wrist-worn voice terminal channel. HTTP server for speak, memo, remind, notifications, OTA firmware updates, and Signal mirror. Open-source firmware at github.com/jorgenclaw/nanoclaw-watch.
---

# Add T-Watch Channel (V2)

Turn a LilyGo T-Watch S3 into a wrist-worn voice terminal for your NanoClaw agent. The watch communicates over WiFi via an HTTP API — tap to speak, capture voice memos, set reminders, check inbox, find your phone, and control your TV via IR.

**Not a notification display.** The watch is a full input device — voice capture, button actions, and two-way communication with your agent. Your agent replies directly on the watch face.

**Open-source firmware:** [github.com/jorgenclaw/nanoclaw-watch](https://github.com/jorgenclaw/nanoclaw-watch) — PlatformIO project, flash via USB or OTA.

**Battle-tested:** Production-proven since April 2026. Daily voice input, memo capture, and status checks.

## What you get

### Watch → Agent (input)
- **Speak** — tap to record voice, transcribed and sent to agent, reply on watch face
- **Capture** — voice memo filed to daily journal (no agent round-trip)
- **Remind** — "remind me at 3pm to call Mom" → agent schedules a one-shot Signal reminder
- **Inbox** — agent summarizes unread Proton Mail
- **Status** — plain-language system status (online, last active, pending tasks, next scheduled)
- **Find Phone** — sends "FIND MY PHONE" to Scott's Signal so the phone buzzes

### Agent → Watch (output)
- **Sync reply** — agent response displayed on watch face within the HTTP request (fast path)
- **Poll fallback** — if agent takes >45s, watch polls `/api/watch/poll` for queued replies
- **Notifications** — Signal messages and emails pushed to watch as banner alerts (90s poll)
- **OTA updates** — watch checks `/api/watch/version`, downloads firmware from `/api/watch/firmware`

### Signal mirror
Every watch interaction is mirrored to Scott's Signal chat — both inbound ("Watch: Scott said X") and outbound ("↳ agent replied Y"). Lets you follow watch conversations from your phone.

## Architecture

```
T-Watch S3 (WiFi, HTTP client)
  ↓ POST /api/watch/message (JSON or audio/wav)
  ↓ POST /api/watch/memo, /api/watch/reminder
  ↓ GET  /api/watch/poll, /api/watch/notifications
  ↓ GET  /api/watch/version, /api/watch/firmware (OTA)
NanoClaw Watch Adapter (src/channels/watch.ts, HTTP server on port 3000)
  ↓ InboundMessage → Router → Session → Container → Agent
  ↓ OutboundMessage → deliver() → sync reply or poll queue
  ↓ mirrorToSignal() → Signal adapter
```

All endpoints authenticated via `X-Watch-Token` header (HMAC timing-safe comparison).

## HTTP API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/watch/message` | POST | Voice or text to agent (sync reply) |
| `/api/watch/memo` | POST | Voice memo → transcribe → daily journal file |
| `/api/watch/reminder` | POST | Voice → transcribe → agent schedules reminder |
| `/api/watch/poll` | GET | Retrieve queued replies after sync timeout |
| `/api/watch/notify` | POST | Push notification to watch (from other adapters) |
| `/api/watch/notifications` | GET | Poll for new notifications since timestamp |
| `/api/watch/version` | GET | Current published firmware version |
| `/api/watch/firmware` | GET | Download firmware binary (OTA update) |

## Prerequisites

### 1. T-Watch S3 hardware

Buy a [LilyGo T-Watch S3](https://www.lilygo.cc/products/t-watch-s3) (~$45). The S3 Plus (with GPS) also works.

### 2. Flash the firmware

Clone and flash via USB (first time only — future updates via OTA):

```bash
git clone https://github.com/jorgenclaw/nanoclaw-watch.git
cd nanoclaw-watch

# Edit src/config.h:
# - NANOCLAW_HOST_URL = "http://YOUR_HOST_IP:3000"
# - WATCH_AUTH_TOKEN = (generate a 64-char hex secret)
# - WEATHER_LOCATION = "YourCity,State"

# Install PlatformIO and flash:
pio run --target upload
```

### 3. WiFi

The watch connects via WiFi. First boot opens a captive portal ("Jorgenclaw-Setup") to enter WiFi credentials. Supports up to 10 saved networks.

## Install (host side)

### Phase 1: Pre-flight

```bash
test -f src/channels/watch.ts && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/twatch-v2
git checkout origin/skill/twatch-v2 -- src/channels/watch.ts
```

Add the import to `src/channels/index.ts`:

```typescript
import './watch.js';
```

Add config exports to `src/config.ts`:

```typescript
// In readEnvFile array:
'WATCH_AUTH_TOKEN',
'WATCH_HTTP_PORT',
'WATCH_HTTP_BIND',
'WATCH_JID',
'WATCH_GROUP_FOLDER',
'WATCH_SYNC_TIMEOUT_MS',
'WATCH_SIGNAL_MIRROR_JID',
'WATCH_FIRMWARE_DIR',

// Exports:
export const WATCH_AUTH_TOKEN = process.env.WATCH_AUTH_TOKEN || envConfig.WATCH_AUTH_TOKEN || '';
export const WATCH_HTTP_PORT = parseInt(process.env.WATCH_HTTP_PORT || envConfig.WATCH_HTTP_PORT || '3000', 10);
export const WATCH_HTTP_BIND = process.env.WATCH_HTTP_BIND || envConfig.WATCH_HTTP_BIND || '0.0.0.0';
export const WATCH_JID = process.env.WATCH_JID || envConfig.WATCH_JID || 'watch:device';
export const WATCH_GROUP_FOLDER = process.env.WATCH_GROUP_FOLDER || envConfig.WATCH_GROUP_FOLDER || 'watch';
export const WATCH_SYNC_TIMEOUT_MS = parseInt(
  process.env.WATCH_SYNC_TIMEOUT_MS || envConfig.WATCH_SYNC_TIMEOUT_MS || '45000', 10);
export const WATCH_SIGNAL_MIRROR_JID = process.env.WATCH_SIGNAL_MIRROR_JID || envConfig.WATCH_SIGNAL_MIRROR_JID || '';
export const WATCH_FIRMWARE_DIR = process.env.WATCH_FIRMWARE_DIR || envConfig.WATCH_FIRMWARE_DIR || path.join(DATA_DIR, 'watch-firmware');
```

Add to `.env`:

```bash
WATCH_AUTH_TOKEN=<same-64-char-hex-as-firmware-config.h>
WATCH_SIGNAL_MIRROR_JID=signal:<your-signal-uuid>  # optional, for Signal mirror
```

### Phase 3: Build and restart

```bash
pnpm run build
systemctl --user restart nanoclaw
```

### Phase 4: Wire the watch to an agent group

After the watch sends its first message, the router auto-creates a messaging group. Wire it:

```bash
# Find the watch messaging group
sqlite3 data/v2.db "SELECT id FROM messaging_groups WHERE channel_type='watch'"

# Wire to your agent group
sqlite3 data/v2.db "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, priority, created_at) VALUES ('mga-'||hex(randomblob(8)), 'mg-WATCHID', 'ag-YOURID', 'shared', 0, datetime('now'))"

# Add the watch device as a member
sqlite3 data/v2.db "INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES ('watch:device', 'ag-YOURID', NULL, datetime('now'))"
```

## OTA firmware updates

Publish new firmware for wireless updates:

```bash
# scripts/publish-firmware.sh builds and copies the binary
./scripts/publish-firmware.sh
```

Users tap "Update" on the watch → checks `/api/watch/version` → downloads → flashes → reboots.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCH_AUTH_TOKEN` | (required) | Shared secret matching firmware config.h |
| `WATCH_HTTP_PORT` | `3000` | HTTP server port |
| `WATCH_HTTP_BIND` | `0.0.0.0` | Bind address |
| `WATCH_JID` | `watch:device` | Platform ID for the watch channel |
| `WATCH_SYNC_TIMEOUT_MS` | `45000` | Max wait for sync reply before poll fallback |
| `WATCH_SIGNAL_MIRROR_JID` | (none) | Signal UUID to mirror watch conversations to |
| `WATCH_FIRMWARE_DIR` | `data/watch-firmware/` | Where OTA firmware binary + version.json live |

## Firmware features (v11)

| Tile | Function |
|------|----------|
| Weather | 3-day forecast via wttr.in |
| Capture | Voice memo → daily journal |
| Remind | Voice → scheduled Signal reminder |
| Clock | Alarm, timer, stopwatch, Pomodoro |
| Remote | IR remote for Vizio TV (customizable NEC codes) |
| WiFi | Saved network manager, tap-to-forget |
| Status | Plain-language system status |
| DND | Do Not Disturb (suppress notification buzzes) |
| Inbox | Unread email summary |
| Find Phone | Ring Scott's phone via Signal |
| Flashlight | Full white screen |
| Update | OTA firmware update |

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Watch shows "Host unreachable" | Wrong IP or port in firmware config.h | Reflash with correct NANOCLAW_HOST_URL |
| Messages dropped with `not_member` | Watch device not in agent group | Add `watch:device` to agent_group_members |
| Signal mirror not working | WATCH_SIGNAL_MIRROR_JID has `signal:` prefix | Adapter strips it automatically (V2 fix) |
| OTA says "Up to date" | Published version <= flashed version | Bump FIRMWARE_VERSION in config.h, run publish-firmware.sh |
| Blank reply on watch | Sync timeout + no poll | Check agent is responding; watch polls at 60s intervals |

## Removal

```bash
rm src/channels/watch.ts
# Remove watch import from src/channels/index.ts
# Remove WATCH_* exports from src/config.ts
# Remove WATCH_* from .env
pnpm run build
```
