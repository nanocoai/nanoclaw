---
name: add-slack
description: Add Slack channel integration via Chat SDK.
---

# Add Slack Channel

Adds Slack support via the Chat SDK bridge. Trunk ships no channels — this skill
copies the Slack channel layer (adapter, shared lib, bot-inbound guard,
provisioning core, container skills) in from the `channels` branch. The **Apply**
steps carry `nc:` directive fences (an agent applies the prose, a parser the
directives); all idempotent.

This is the base Slack experience: one bot, DM and channel chat. The Slack
**agents** feature — child bots provisioned from `create_agent`, shared rooms,
canvases, DM onboarding — ships separately in `/slack-a2a-rooms` +
`/slack-agent-flow`; the setup wizard applies them automatically, and they can be applied on top
of this install at any time.
Existing classic installs that want the Slack agents experience should use
`/migrate-slack-agents` rather than re-running this skill (classic keeps
working; that migration is optional).

## Apply

### 1. Copy the channel payload

Fetch the `channels` branch and copy the payload into place (overwrite — the branch is canonical):
```nc:copy from-branch:channels
src/channels/slack.ts
src/channels/slack-lib.ts
src/channels/slack-lib.test.ts
src/channels/slack-a2a-guard.ts
src/channels/slack-a2a-guard.test.ts
src/channels/slack-registration.test.ts
src/channels/slack-instances-registration.test.ts
src/provisioning/slack-app.ts
src/provisioning/slack-app.test.ts
container/skills/slack-formatting/SKILL.md
```

- **Adapter + shared lib** (`slack.ts`, `slack-lib.ts`): bridge registration, wiring defaults, conversation resolver, the native `SLACK_INSTANCES` loop — pinned by the two registration tests.
- **Bot-inbound guard** (`slack-a2a-guard.ts`): drops bot-authored inbound at the bridge by default; feature skills register a narrower admission policy on its seam.
- **Provisioning core** (`src/provisioning/slack-app.ts`): manifest template, scope/event constants, and the broker + manager-token transports for creating a Slack app programmatically. Nothing on the adapter path imports it — the setup wizard's auto-provision pre-step and feature skills do.
- **Container skills**: `slack-formatting/` (mrkdwn syntax; synced to `~/.claude/skills`).

The room/canvas/onboarding host modules, their container files, and the Slack
welcome-tour addendum (it describes rooms, canvases, and the agents access
model) are part of the agents feature and install with `/slack-agent-flow`,
not here.

### 2. Register the payload

Append the self-registration imports (each append is skipped if its first
line is already present). The adapter and the guard, in the channel barrel:
```nc:append to:src/channels/index.ts
import './slack.js';
```
```nc:append to:src/channels/index.ts
import './slack-a2a-guard.js';
```

### 3. Install the adapter package

Pinned exactly — the supply-chain policy rejects ranges and `latest`:
```nc:dep
@chat-adapter/slack@4.29.0
```

### 4. Build and validate

The build guards the typed `createChatSdkBridge(...)` call and proves the dependency
installed; the tests pin registration (barrel import, dependency, the `SLACK_INSTANCES`
loop), the guard, the shared lib, and the provisioning core.
```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/slack-registration.test.ts src/channels/slack-instances-registration.test.ts src/channels/slack-lib.test.ts src/channels/slack-a2a-guard.test.ts src/provisioning/slack-app.test.ts
```

## Credentials

Socket Mode (an outbound WebSocket — no public URL, the right default behind NAT)
vs webhook delivery (needs a public HTTPS Request URL); the adapter picks Socket
Mode automatically whenever `SLACK_APP_TOKEN` is set.
```nc:prompt connection validate:^(socket|webhook|provisioned)$ choices:socket|webhook
How should Slack deliver events? `socket` (Socket Mode — no public URL, recommended for local or behind-NAT installs) or `webhook` (needs a public HTTPS Request URL).
```

`provisioned` is never offered interactively (`choices:` limits the select;
`validate:` stays wider because pre-bound inputs may exceed the offered set) —
it arrives only via pre-bound `inputs` (a programmatically created app) and
behaves like Socket Mode minus the walkthrough below.

For Socket Mode, tell the user:
```nc:operator when:connection=socket
Create the Slack app (Socket Mode):
1. Go to api.slack.com/apps and create a new app using whichever creation flow is currently available (e.g. starting from scratch or from a manifest). Name it (e.g. "NanoClaw") and pick your workspace.
2. OAuth & Permissions → add these Bot Token Scopes: chat:write, im:write, channels:history, groups:history, im:history, channels:read, groups:read, mpim:read, users:read, reactions:write, files:read, files:write.
3. App Home → enable the Messages Tab, and check "Allow users to send Slash commands and messages from the messages tab."
4. Basic Information → App-Level Tokens → "Generate Token and Scopes" → add the connections:write scope → copy the token (starts with xapp-).
5. Socket Mode → toggle "Enable Socket Mode" on.
6. Event Subscriptions → toggle "Enable Events" on, then under "Subscribe to bot events" add: message.channels, message.groups, message.im, app_mention. Save Changes. (No Request URL is needed in Socket Mode.)
7. Install to Workspace, then copy the Bot User OAuth Token (starts with xoxb-).
```

For webhook delivery, tell the user:
```nc:operator when:connection=webhook
Create the Slack app (webhook delivery):
1. Go to api.slack.com/apps and create a new app using whichever creation flow is currently available (e.g. starting from scratch or from a manifest). Name it (e.g. "NanoClaw") and pick your workspace.
2. OAuth & Permissions → add these Bot Token Scopes: chat:write, im:write, channels:history, groups:history, im:history, channels:read, groups:read, mpim:read, users:read, reactions:write, files:read, files:write.
3. App Home → enable the Messages Tab, and check "Allow users to send Slash commands and messages from the messages tab."
4. Install to Workspace, then copy the Bot User OAuth Token (starts with xoxb-).
5. Basic Information → copy the Signing Secret.
```

Store the secrets in `.env` (the app-level token doubles as the Socket Mode switch, the signing secret authenticates webhook requests):
```nc:prompt bot_token secret validate:^xoxb-
Paste the Bot User OAuth Token — OAuth & Permissions, starts with `xoxb-`.
```
```nc:prompt app_token secret validate:^xapp- reuse:SLACK_APP_TOKEN when:connection=socket
Paste the App-Level Token — Basic Information → App-Level Tokens, starts with `xapp-`.
```
```nc:prompt app_token secret validate:^xapp- when:connection=provisioned
Paste the App-Level Token of the provisioned app (starts with `xapp-`).
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
```nc:env-set when:connection=provisioned
SLACK_APP_TOKEN={{app_token}}
```
```nc:env-set when:connection=webhook
SLACK_SIGNING_SECRET={{signing_secret}}
```

**Additional bot identities (optional).** The adapter natively reads
`SLACK_INSTANCES=<name>[,…]` from `.env`, registering one `slack-<name>` instance per
name from suffixed keys (`SLACK_BOT_TOKEN_<NAME>` etc.) — see `/slack-multi-instance`.

With webhook delivery, the bridge serves port 3000 at `/webhook/slack`; that
URL must be publicly reachable and registered with Slack. Tell the user:
```nc:operator when:connection=webhook
Set up event delivery (needs a public HTTPS URL for port 3000 — ngrok, a Cloudflare Tunnel, or a reverse proxy on a VPS):
1. Event Subscriptions → Enable Events. Set the Request URL to https://<your-public-host>/webhook/slack and wait for the challenge to pass.
2. Subscribe to bot events: message.channels, message.groups, message.im, app_mention. Save Changes.
3. Interactivity & Shortcuts → toggle Interactivity on, set the same Request URL, Save Changes, then reinstall the app when Slack prompts.
```

## Resolve your DM channel

Resolve the owner DM address the owner-wiring step needs; validating the token here, before the restart, fast-fails a bad credential.
```nc:prompt owner_handle validate:^U[A-Z0-9]{8,}$
Your Slack member ID (Profile → ⋮ → "Copy member ID"; starts with U).
```

`auth.test` confirms the bot token works and captures the bot identity:
```nc:run capture:connected_as effect:fetch
curl -sf -X POST https://slack.com/api/auth.test -H "Authorization: Bearer {{bot_token}}" | jq -er '"@" + .user + " in " + .team'
```

`conversations.open` yields the DM address `slack:<channelId>` (no channel back = the `im:write` scope is missing — add it and reinstall):
```nc:run capture:platform_id effect:fetch
curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '{"users":"{{owner_handle}}"}' | jq -er '"slack:" + .channel.id'
```

`owner_handle` and `platform_id` feed the owner-wiring step. Sending works immediately;
receiving needs the event path (Socket Mode: live after the restart below; webhook: the steps above first).

## Restart

Restart so the service loads the adapter and secrets; wait for its CLI socket before wiring:
```nc:run effect:restart
bash setup/lib/restart.sh
```

## Next Steps

Mid-`/setup`: return to the setup flow. Otherwise wire the channel with `/init-first-agent`
(or `/manage-channels`). For the Slack agents feature (child bots from
`create_agent`, shared rooms, canvases), apply `/slack-a2a-rooms` then
`/slack-agent-flow` — the setup wizard does both automatically by default.

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **platform-id-format**: `slack:{channelId}` for channels (e.g., `slack:C0123ABC`), `slack:{dmId}` for DMs (e.g., `slack:D0ARWEBLV63`)
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). For DMs, the ID starts with D. Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.

## Troubleshooting

- **A token paste is rejected.** Each secret has a fixed shape: the Bot User OAuth Token starts `xoxb-` (OAuth & Permissions, after Install to Workspace), the App-Level Token starts `xapp-` (Basic Information → App-Level Tokens), and the Signing Secret is a hex string (Basic Information). The classic mix-up is pasting a user token (`xoxp-`) instead of the bot token, or the app's Client Secret instead of the Signing Secret.
- **`auth.test` fails, or `conversations.open` returns no channel.** A failing `auth.test` means the bot token is wrong or the app was never installed to the workspace. An empty `conversations.open` means the `im:write` scope is missing — add it and **reinstall the app**; scope changes only take effect after reinstall, which also mints a new `xoxb-` token to store.
- **The greeting arrives but your replies vanish.** Sending works with just the bot token; *receiving* needs the event path. Socket Mode: the toggle on, `SLACK_APP_TOKEN` set with `connections:write`, and the bot events (`message.im`, `message.channels`, `message.groups`, `app_mention`) subscribed. Webhook: the Request URL must have passed Slack's challenge and the same events subscribed. Either way, App Home's Messages Tab must be enabled or Slack refuses DMs to the app.
- **Adapter registered but Slack never connects.** Run `pnpm exec vitest run src/channels/slack-registration.test.ts` — red means the barrel import or the `@chat-adapter/slack` install drifted, so re-run the Apply steps. If green, restart the service (`bash setup/lib/restart.sh`) and check `logs/nanoclaw.error.log`.
- **Rooms, canvases, or DM onboarding are missing.** Those are the agents feature, not this adapter install — they arrive with `/slack-a2a-rooms` + `/slack-agent-flow` (setup applies both by default). If those skills were applied, check `src/modules/index.ts` carries their module imports, then restart.
