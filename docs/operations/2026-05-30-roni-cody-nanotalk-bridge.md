# Roni-Cody NanoTalk Bridge Recovery

Date: 2026-05-30 KST

## Summary

Roni now runs on the Hetzner server, while Cody runs on the local Mac. This split made Cody able to send messages to Roni through the `server_roni` bridge, but Roni-to-Cody messages were failing because the server only had a placeholder `remote_cody` channel and no real adapter for delivering those messages to the Mac.

The fix was to make the local Mac pull pending Roni-to-Cody messages from the server and inject them into Cody's local NanoClaw session.

## Current Topology

- Roni host: `root@5.78.42.198:/opt/nanoclaw`
- Roni agent group: `ag-1779753187257-7xmvcg`
- Cody host: local Mac, `/Users/songylee/nanoclaw`
- Cody agent group: `ag-1779782931755-x43x64`
- Local Cody session currently in use: `sess-1780036006868-jm6vmk`
- Server Roni session currently in use: `sess-1779753187264-tz308a`
- NanoTalk dashboard: `http://127.0.0.1:4377`

## What Was Broken

Roni attempted to send messages to Cody with:

- `channel_type = remote_cody`
- `platform_id = ag-1779782931755-x43x64`

Delivery failed on the server with:

```text
unknown messaging group for remote_cody/ag-1779782931755-x43x64
```

This was expected because `remote_cody` was not a real server-side channel adapter.

## What Was Changed

### Local Cody Wake Watcher

Updated:

- `scripts/cody-wake-watcher.ts`

The watcher now does two jobs:

1. Notifies Cody when the Mac starts or wakes.
2. Every 30 seconds, SSHes into the server, reads Roni's `messages_out` rows where `channel_type = 'remote_cody'`, fetches any attached outbox files, and injects those messages into Cody's local session through the local CLI socket.

Delivered remote message IDs are recorded in:

- `data/cody-wake-watcher.json`

This prevents repeated delivery.

### Cody Destination Alias

Added a Cody destination alias:

- `parent -> server_roni`

This matters because Cody tried to reply with `<message to="parent">...</message>`, but `parent` was not configured. It is now mapped to the same Roni bridge as `roni`.

Central DB row added locally:

```text
agent_group_id = ag-1779782931755-x43x64
local_name = parent
target_type = channel
target_id = mg-server-roni
```

The running session projection was also updated in Cody's local `inbound.db`.

### Stable Sawyer Alias

Added stable human-readable aliases on both sides:

- `sawyer`
- `sawyer-telegram`

These point to Sawyer's Telegram DM for each agent's own host environment:

- Roni server: `sawyer -> mg-1779753100866-rxi2xf`
- Cody local Mac: `sawyer -> 742ffa87-c4da-499f-b1d4-f78fd7265a8c`

The old `telegram-mg-17797` alias is still present for compatibility, but agents should not use generated `telegram-mg-*` names in new instructions. Roni and Cody instructions now say to use `sawyer` or `sawyer-telegram` when they need to address Sawyer directly.

### NanoTalk Session Display

Updated:

- `scripts/roni-cody-dashboard.ts`

NanoTalk now hides sessions whose `container_status = 'stopped'` in the sidebar session list. This prevents old/stale Cody sessions from appearing as if Cody has two running instances.

The stale Cody session was:

```text
sess-1779942011006-9qbq5e
```

It had no real running container, but its DB row still said `running`. It was corrected to:

```text
container_status = stopped
```

## Verification

Confirmed actual running Cody container:

```text
nanoclaw-v2-unnamed-1780127469682
```

Confirmed Cody received Roni's queued messages in local inbound DB:

```text
cli-1780127469664-gnm0vr
cli-1780127469767-6vwvs2
cli-1780127469871-tg5fyz
cli-1780127469977-3ne0nd
cli-1780127470079-4alsrb
```

Confirmed Cody processed the scrap queue and saved these files:

```text
/Users/songylee/writing/scraps/2026-05-29-jeffrey-kim-hangang-vibe-coding.md
/Users/songylee/writing/scraps/2026-05-29-seeyong-lee-k-skill.md
/Users/songylee/writing/scraps/2026-05-29-jeongmin-lee-claude-code-6-skills.md
```

Confirmed Roni received completion notice and sent a Telegram update:

```text
코디가 스크랩 3개 모두 로컬에 저장 완료했어요!
```

Roni's server-side queue was updated:

```text
/opt/nanoclaw/groups/dm-with-sawyer/scrap-queue.md
```

All rows now show delivered.

Typecheck passed:

```text
pnpm exec tsc --noEmit
```

## Operational Notes

- Do not run a second Roni Telegram poller on the Mac with the same bot token. Telegram `getUpdates` allows only one active poller per bot token.
- The current split is intentional:
  - Roni stays on the server for always-on Telegram handling.
  - Cody stays on the Mac for local filesystem work, especially `/Users/songylee/writing`.
- Roni-to-Cody is pull-based from the Mac. This avoids opening inbound access from the server to the Mac.
- Cody-to-Roni is push-based through the existing `server_roni` SSH bridge.
- NanoTalk merges server and local DB snapshots. Duplicate-looking historical messages can appear because the same conversation exists in both source DBs, but current session display now filters stopped sessions.

## Useful Checks

Server status:

```bash
ssh root@5.78.42.198 "systemctl status nanoclaw-v2-3282970f.service --no-pager --lines=30"
```

Local Cody host:

```bash
ps aux | rg 'dist/index.js|cody-wake-watcher'
docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}' | grep nanoclaw
```

NanoTalk API:

```bash
curl -sS http://127.0.0.1:4377/api/dashboard
```

Cody watcher logs:

```bash
tail -100 logs/cody-wake-watcher.log
tail -100 logs/cody-wake-watcher.error.log
```
