---
name: add-slack
description: Add Slack channel integration via Chat SDK.
---

# Add Slack Channel

Adds Slack support via the Chat SDK bridge. NanoClaw doesn't ship channels in
trunk — this skill copies the Slack adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter, registration test, and formatting skill

Fetch the `channels` branch and copy the Slack adapter, its registration test,
and the formatting container skill into place (overwrite — the branch is
canonical):

```nc:copy from-branch:channels
src/channels/slack.ts
src/channels/slack-registration.test.ts
container/skills/slack-formatting/SKILL.md
```

The `slack-formatting` container skill is part of the channel payload: it
reaches agents via `~/.claude/skills` (synced at spawn) and teaches Slack's
mrkdwn syntax. Trunk does not ship it — without this copy step agents send
Slack messages with generic markdown that renders literally.

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './slack.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/slack@4.29.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/slack-registration.test.ts
```

`slack-registration.test.ts` imports the real channel barrel and asserts the
registry contains `slack`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/slack` isn't installed (the
import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real workspace is verified manually once the service runs.

## Credentials

Slack can deliver events two ways. Socket Mode holds an outbound WebSocket open
— no public URL, so it works on a laptop or behind NAT — and is the right
default. Webhook delivery needs a public HTTPS Request URL but avoids the
long-lived socket. The adapter picks Socket Mode automatically whenever
`SLACK_APP_TOKEN` is set; otherwise it serves the webhook.

```nc:prompt connection validate:^(socket|webhook)$
How should Slack deliver events? `socket` (Socket Mode — no public URL, recommended for local or behind-NAT installs) or `webhook` (needs a public HTTPS Request URL).
```

Walk the operator through creating the Slack app, then collect the secrets it
hands back. The adapter is already installed and registered — it just can't
receive a message until this is done. For Socket Mode, tell the user:

```nc:operator when:connection=socket
Create the Slack app (Socket Mode):
1. Go to api.slack.com/apps → Create New App → From scratch. Name it (e.g. "NanoClaw") and pick your workspace.
2. OAuth & Permissions → add these Bot Token Scopes: chat:write, im:write, channels:history, groups:history, im:history, channels:read, groups:read, users:read, reactions:write, files:read, files:write.
3. App Home → enable the Messages Tab, and check "Allow users to send Slash commands and messages from the messages tab."
4. Basic Information → App-Level Tokens → "Generate Token and Scopes" → add the connections:write scope → copy the token (starts with xapp-).
5. Socket Mode → toggle "Enable Socket Mode" on.
6. Event Subscriptions → toggle "Enable Events" on, then under "Subscribe to bot events" add: message.channels, message.groups, message.im, app_mention. Save Changes. (No Request URL is needed in Socket Mode.)
7. Install to Workspace, then copy the Bot User OAuth Token (starts with xoxb-).
```

For webhook delivery, tell the user:

```nc:operator when:connection=webhook
Create the Slack app (webhook delivery):
1. Go to api.slack.com/apps → Create New App → From scratch. Name it (e.g. "NanoClaw") and pick your workspace.
2. OAuth & Permissions → add these Bot Token Scopes: chat:write, im:write, channels:history, groups:history, im:history, channels:read, groups:read, users:read, reactions:write, files:read, files:write.
3. App Home → enable the Messages Tab, and check "Allow users to send Slash commands and messages from the messages tab."
4. Install to Workspace, then copy the Bot User OAuth Token (starts with xoxb-).
5. Basic Information → copy the Signing Secret.
```

Collect the secrets and store them (the bridge reads them from `.env`; the
app-level token doubles as the Socket Mode switch, the signing secret
authenticates webhook requests — each mode needs only its own):

```nc:prompt bot_token secret validate:^xoxb-
Paste the Bot User OAuth Token — OAuth & Permissions, starts with `xoxb-`.
```
```nc:prompt app_token secret validate:^xapp- reuse:SLACK_APP_TOKEN when:connection=socket
Paste the App-Level Token — Basic Information → App-Level Tokens, starts with `xapp-`.
```
```nc:prompt signing_secret secret validate:^[a-fA-F0-9]{16,}$ when:connection=webhook
Paste the Signing Secret — Basic Information.
```
```nc:env-set
SLACK_BOT_TOKEN={{bot_token}}
```
```nc:env-set when:connection=socket
SLACK_APP_TOKEN={{app_token}}
```
```nc:env-set when:connection=webhook
SLACK_SIGNING_SECRET={{signing_secret}}
```

With webhook delivery, the bridge serves port 3000 at `/webhook/slack`
automatically; to receive replies, that port must be reachable from the internet
and registered with Slack as the Request URL (Socket Mode needs no public URL —
with the bot events subscribed above, events arrive over the socket as soon as
the service restarts). Tell the user:

```nc:operator when:connection=webhook
Set up event delivery (needs a public HTTPS URL for port 3000 — ngrok, a Cloudflare Tunnel, or a reverse proxy on a VPS):
1. Event Subscriptions → Enable Events. Set the Request URL to https://<your-public-host>/webhook/slack and wait for the challenge to pass.
2. Subscribe to bot events: message.channels, message.groups, message.im, app_mention. Save Changes.
3. Interactivity & Shortcuts → toggle Interactivity on, set the same Request URL, Save Changes, then reinstall the app when Slack prompts.
```

## Resolve your DM channel

The agent talks to you in your direct-message channel with the bot. Resolve its
address so the owner-wiring step can target it. Validating the token here, before
the restart, fast-fails a bad credential while it's still cheap to fix. You'll
need your Slack member ID: open your profile (your avatar, bottom-left), then
**⋮** → **Copy member ID** — it starts with `U`.

```nc:prompt owner_handle validate:^U[A-Z0-9]{8,}$
Your Slack member ID (Profile → ⋮ → "Copy member ID"; starts with U).
```

Confirm the bot token works and capture the bot identity — `auth.test` returns the
bot user and workspace, and fails here if the token is bad:

```nc:run capture:connected_as effect:fetch
curl -sf -X POST https://slack.com/api/auth.test -H "Authorization: Bearer {{bot_token}}" | jq -er '"@" + .user + " in " + .team'
```

Open the DM with `conversations.open` and take the channel id it returns as the
conversation address `slack:<channelId>` (if Slack returns no channel, the bot is
missing the `im:write` scope — add it and reinstall):

```nc:run capture:platform_id effect:fetch
curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '{"users":"{{owner_handle}}"}' | jq -er '"slack:" + .channel.id'
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
greeting goes out over `chat.postMessage`, which works right away. Receiving
replies needs the event path live: with Socket Mode that happens as soon as the
service restarts below; with webhook delivery, finish the Event Subscriptions
and Interactivity steps above first.

## Restart

With the credential validated, restart the service so it loads the Slack adapter
and the secrets you just stored, and wait for its CLI socket before wiring:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **platform-id-format**: `slack:{channelId}` for channels (e.g., `slack:C0123ABC`), `slack:{dmId}` for DMs (e.g., `slack:D0ARWEBLV63`)
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). For DMs, the ID starts with D. Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.

## Troubleshooting

**A token paste is rejected.** Each secret has a fixed shape: the Bot User OAuth Token starts `xoxb-` (OAuth & Permissions, after Install to Workspace), the App-Level Token starts `xapp-` (Basic Information → App-Level Tokens), and the Signing Secret is a hex string (Basic Information). The classic mix-up is pasting a user token (`xoxp-`) instead of the bot token, or the app's Client Secret instead of the Signing Secret.

**`auth.test` fails, or `conversations.open` returns no channel.** A failing `auth.test` means the bot token is wrong or the app was never installed to the workspace. `conversations.open` coming back empty means the `im:write` scope is missing — add it under OAuth & Permissions and **reinstall the app**; scope changes only take effect after reinstall, which also mints a new `xoxb-` token to store.

**The greeting arrives but your replies vanish.** Sending works with just the bot token; *receiving* needs the event path. Socket Mode: the toggle on, `SLACK_APP_TOKEN` set with `connections:write`, and the bot events (`message.im`, `message.channels`, `message.groups`, `app_mention`) subscribed. Webhook: the Request URL must have passed Slack's challenge and the same events subscribed. Either way, App Home's Messages Tab must be enabled or Slack refuses DMs to the app.

**Adapter registered but Slack never connects.** Run `pnpm exec vitest run src/channels/slack-registration.test.ts` — red means the barrel import or the `@chat-adapter/slack` install drifted, so re-run the Apply steps. If green, restart the service (`bash setup/lib/restart.sh`) so it picks up the adapter and tokens, then check `logs/nanoclaw.error.log`.
