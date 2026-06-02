# Roni Server Setup and Local Cody Baseline

Date: 2026-05-30 KST

## Status

This note records the operational baseline after moving Roni to the cloud and keeping Cody on the local Mac.

Important: this document is background context. The most recent operational result for the Roni-Cody bridge is recorded in:

- `docs/operations/2026-05-30-roni-cody-nanotalk-bridge.md`

If the two documents differ, prefer the bridge document because it includes later work, especially the Roni-to-Cody pull sync and NanoTalk session display fixes.

## Final Topology

- Roni runs on the Hetzner server.
- Cody runs only on the local Mac.
- The local Mac remains the place for local filesystem work, especially writing and scrap files under the user's home directory.
- Roni handles always-on Telegram availability from the server.
- Cody is not deployed on the server.

Known identifiers at the time of this record:

```text
Roni server host: root@5.78.42.198
Roni server project root: /opt/nanoclaw
Roni agent group: ag-1779753187257-7xmvcg
Cody local project root: /Users/songylee/nanoclaw
Cody agent group: ag-1779782931755-x43x64
Local NanoClaw launchd label: com.nanoclaw-v2-f5d8a708
```

Secrets, tokens, and API keys are intentionally not recorded here.

## Server Setup Outcome

Roni was moved from the local Mac to the server so it can keep running while the MacBook is asleep or powered off.

The local "shadow Roni" was removed to avoid duplicate Telegram polling and confusing agent state:

- local Roni group removed
- local Roni session data removed
- local Roni containers stopped
- local Roni Telegram bot token removed from local runtime config

The server now owns Roni's always-on runtime. The local Mac should not run a second Roni Telegram poller using the same bot token.

## Local Cody Outcome

Cody remains local by design.

Reasons:

- Cody needs access to local Mac files.
- Cody should not be reachable as a cloud agent unless explicitly designed later.
- Keeping Cody local avoids mixing private local workspace automation with the server-hosted Roni runtime.

Local Cody still runs through local NanoClaw and the Cody Telegram DM.

## Cody-to-Roni Bridge

A local `server_roni` channel was added so Cody can send messages to Roni on the server.

Key files:

- `src/channels/server-roni.ts`
- `scripts/inject-remote-agent-message.ts`

The local adapter sends Cody's outbound message to the server over SSH. The server-side injection script writes the message into Roni's server-side session inbound DB.

This was the first bridge direction:

```text
Local Cody -> local server_roni adapter -> SSH -> server Roni inbound DB
```

The later reverse direction is documented in the bridge recovery record:

- `docs/operations/2026-05-30-roni-cody-nanotalk-bridge.md`

## Cody Wake Watcher

A local wake watcher was added so Cody can be told when the MacBook or local Cody runtime starts again.

Key files:

- `scripts/cody-wake-watcher.ts`
- `launchd/com.nanoclaw.cody-wake-watcher.plist`

Installed launchd label:

```text
com.nanoclaw.cody-wake-watcher
```

Initial purpose:

1. On watcher startup, send Cody a system-style message saying the local watcher started.
2. Detect wake from sleep by checking whether the event loop timer gap is larger than 90 seconds.
3. Send Cody a system-style wake message when that happens.
4. Throttle repeated notifications to reduce noise.

Later, the same watcher was extended to pull pending Roni-to-Cody messages from the server every 30 seconds. That newer behavior is the current operational behavior and is documented in the bridge recovery record.

State file:

```text
data/cody-wake-watcher.json
```

Logs:

```text
logs/cody-wake-watcher.log
logs/cody-wake-watcher.error.log
```

## Current Operating Rules

- Roni belongs on the server.
- Cody belongs on the local Mac.
- Do not restore local Roni unless explicitly requested.
- Do not deploy Cody to the server unless the product architecture changes.
- Do not run duplicate Telegram pollers for the same bot token.
- Treat `docs/operations/2026-05-30-roni-cody-nanotalk-bridge.md` as the latest bridge-state document.

## Useful Checks

Check local services:

```bash
launchctl list | rg 'com\\.nanoclaw|cody-wake'
ps aux | rg 'dist/index.js|cody-wake-watcher'
```

Check Cody wake watcher logs:

```bash
tail -100 logs/cody-wake-watcher.log
tail -100 logs/cody-wake-watcher.error.log
```

Check server Roni service:

```bash
ssh root@5.78.42.198 "systemctl status nanoclaw-v2-3282970f.service --no-pager --lines=30"
```
