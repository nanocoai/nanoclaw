---
name: add-line
description: Add LINE Official Account channel integration via the LINE Messaging API. Native adapter — no Chat SDK bridge, zero new npm dependencies. Requires a public HTTPS webhook endpoint.
---

# Add LINE Channel

Adds LINE messaging support via a native adapter that talks to the [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/) directly — webhook in, push out. There is no `@chat-adapter/line` package, so no Chat SDK bridge; the adapter uses only Node builtins (`node:crypto`, `node:http`) and global `fetch`. Zero new npm dependencies.

LINE is the dominant messaging platform in Japan, Taiwan, and Thailand. Bots run as **Official Accounts** (OAs) that users add as friends; NanoClaw acts as the webhook backend of an Official Account.

## Prerequisites

### 1. A LINE Official Account with a Messaging API channel

1. Create an Official Account at https://manager.line.biz (free)
2. Enable the **Messaging API** for it — this creates a Messaging API channel in the [LINE Developers console](https://developers.line.biz/console/)
3. From the channel's **Basic settings** tab, copy the **Channel secret**
4. From the **Messaging API** tab, issue a long-lived **Channel access token**

### 2. A public HTTPS webhook endpoint

LINE delivers inbound messages **only via webhook over public HTTPS** — there is no polling mode (unlike Telegram). The adapter serves `/webhook/line` on the shared webhook server (`WEBHOOK_PORT`, default 3000); a public HTTPS URL must reach it.

- **Production:** a domain + reverse proxy (Caddy/nginx) in front of `127.0.0.1:3000`.
- **Local development:** use a tunnel **with a stable URL**, e.g. a [zrok](https://zrok.io) reserved name (free) or Tailscale Funnel:

  ```bash
  zrok enable <account-token>                 # one-time
  zrok create name my-nanoclaw-line           # reserves a permanent hostname
  zrok share public localhost:3000 -n public:my-nanoclaw-line --headless
  # → https://my-nanoclaw-line.shares.zrok.io — survives restarts, set once in the console
  ```

> ⚠ Avoid ephemeral tunnels (`cloudflared tunnel --url`, random-URL ngrok) beyond a first smoke test. Their hostname dies with the process, LINE keeps POSTing to the dead URL, and inbound messages are **silently lost** — webhook redelivery is off by default, and the host logs show nothing because nothing arrives.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/line.ts`, `src/channels/line-signature.ts`,
  `src/channels/line-signature.test.ts`, and `src/channels/line-registration.test.ts` all exist
- `src/channels/index.ts` contains `import './line.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its tests

```bash
git show origin/channels:src/channels/line.ts                    > src/channels/line.ts
git show origin/channels:src/channels/line-signature.ts          > src/channels/line-signature.ts
git show origin/channels:src/channels/line-signature.test.ts     > src/channels/line-signature.test.ts
git show origin/channels:src/channels/line-registration.test.ts  > src/channels/line-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './line.js';
```

### 4. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/line-registration.test.ts src/channels/line-signature.test.ts
```

Both must be clean before proceeding. `line-registration.test.ts` is the integration test: it imports the real channel barrel and asserts the registry contains `line` — it goes red if the `import './line.js';` line is deleted or the barrel fails to evaluate. Importing is safe: the factory returns null without credentials, and the webhook route is registered only in `setup()`, never at import. There is no npm package to guard — the adapter has zero dependencies.

## Credentials

Add to `.env`:

```bash
LINE_CHANNEL_SECRET=your-channel-secret
LINE_CHANNEL_ACCESS_TOKEN=your-long-lived-access-token
```

The adapter reads them from the process environment first, then falls back to `.env`, so it works under launchd/systemd without extra sourcing.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Restart

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

The log should show `LINE channel ready { path: '/webhook/line' }`.

## Point LINE at the webhook

In the [LINE Developers console](https://developers.line.biz/console/), open the channel → **Messaging API** tab → **Webhook settings**:

1. Set **Webhook URL** to `https://<your-public-host>/webhook/line` → **Update**
2. Click **Verify** — expect **Success**
3. Enable **Use webhook**
4. Under the OA's response settings (LINE Official Account Manager), disable **Auto-reply messages** so LINE's canned replies don't interleave with the agent's

> The **Verify** button is not a GET — it sends a **signed POST with an empty `events` array**. A passing Verify therefore proves the whole inbound chain at once: the URL resolves, the tunnel/proxy reaches the host, the adapter is up, and the channel secret matches the signature.

## Wiring

### DMs

Add the OA as a friend (QR code on the console's Messaging API tab), then send it any message. The router auto-creates a `messaging_groups` row for the chat. Then:

```bash
ncl messaging-groups list --channel line
```

Pass the `mg-…` id to `/init-first-agent` (first agent) or `/manage-channels` (wire to an existing agent group).

New LINE senders are dropped until granted access — grant membership (and a role, if this is the operator):

```bash
ncl users list                                   # find line:U… (or: ncl dropped-messages list)
ncl members add --user "line:U…" --group <agent-group-id>
ncl roles grant --user "line:U…" --role owner    # operator identity only
```

### Group chats

Enable **Allow bot to join group chats** in the OA settings, invite the OA to the group, and @mention it. Group/room chats route with `isGroup: true`; the bot engages on explicit @mentions (LINE reports these via mention metadata). Wire the auto-created messaging group the same way as DMs.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/init-first-agent` to create an agent wired to your LINE DM, or `/manage-channels` to wire this channel to an existing agent group.

## Channel Info

- **type**: `line`
- **terminology**: 1:1 chats with friends, group chats, and multi-person rooms
- **supports-threads**: no
- **platform-id-format**:
  - DM: the sender's LINE userId (`U` + 32 hex chars); user ids are `line:U…`
  - Group: `C…` groupId · Room: `R…` roomId
- **how-to-find-id**: message the OA, then `ncl messaging-groups list --channel line` (or `ncl dropped-messages list` for ungranted senders)
- **typical-use**: personal assistant or team inbox in markets where LINE is the default messenger (JP/TW/TH)
- **default-isolation**: one agent group per OA is typical; group chats with other people should use `isolated` session mode

### Features

- Text in / text out; long replies are chunked to LINE's 5000-char limit and batched (up to 5 message objects per push)
- Webhook signature verification (constant-time HMAC-SHA256, diagnosable reason codes)
- Group @mention detection via LINE's mention metadata (`isMention`)
- Delivery returns the platform message id (`sentMessages[0].id`), on par with bridge channels
- Media (image/file/video/audio) arrives as a typed placeholder — `[attachment:image] message_id=…` — content is **not** downloaded. The message id is exactly what a future media integration needs to fetch the binary from LINE's content endpoint (`api-data.line.me`); note LINE expires stored content, so any such fetch must happen promptly at webhook time.

### Design notes and limits

- **Push-only outbound, and push costs quota.** LINE reply tokens are single-use with a ~1-minute TTL; NanoClaw's host delivers asynchronously (it polls `outbound.db`), so reply tokens are stale by delivery time and every outbound message is a push. Pushes count against the OA plan's monthly free message allowance (e.g. 200/month on the free plan, counted **per recipient**, not per message object). When the cap is hit, LINE returns an error and the message is not sent — upgrade the OA plan for heavier traffic. Check live usage anytime:

  ```bash
  curl -s -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
    https://api.line.me/v2/bot/message/quota/consumption
  ```

- Not supported: outbound file attachments (text only), Flex/rich messages (if needed later, the pinned `@line/bot-sdk` is the upgrade path), follow/unfollow events, typing indicator.

## Troubleshooting

### Console "Verify" fails

The chain is URL → tunnel/proxy → host → adapter → secret. Test from outside:

```bash
curl -i https://<your-public-host>/webhook/line   # expect HTTP 200, body "ok"
```

- Connection/DNS error → tunnel or proxy is down (ephemeral tunnel URLs die with their process)
- 200 here but Verify fails → check `grep "LINE channel ready" logs/nanoclaw.log` (adapter running?) and the signature warning below (wrong secret)

### `LINE webhook signature rejected` in logs

The `reason` field says why: `no_secret` (env var missing), `no_signature` (request didn't come from LINE), `mismatch` (LINE_CHANNEL_SECRET doesn't match this channel — re-copy it from the console's Basic settings tab).

### First DM does nothing

The messaging group is auto-created but the sender isn't granted access yet — messages drop until membership is granted. Check `ncl dropped-messages list`, then grant as shown in Wiring.

### Messages stopped arriving after a restart

If you use a tunnel: did its URL change? The console still points at the old hostname and LINE's deliveries vanish silently. Re-check the webhook URL and re-Verify. This is the failure mode the stable-tunnel recommendation exists for.

### Push fails / quota

`LINE push failed` with status 429 or a quota message means the monthly free push allowance is exhausted — it's a hard wall, not overage billing. Note the OA console's billing page shows **charges** (zero while inside the free tier) and its daily stats aggregate with a day's delay; for real-time usage use the `quota/consumption` endpoint shown above.
