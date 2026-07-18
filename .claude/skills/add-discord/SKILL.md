---
name: add-discord
description: Add Discord bot channel integration via Chat SDK.
---

# Add Discord Channel

Adds Discord bot support via the Chat SDK bridge. NanoClaw doesn't ship channels
in trunk — this skill copies the Discord adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Discord adapter and its registration
test into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/discord.ts
src/channels/discord-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './discord.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/discord@4.29.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/discord-registration.test.ts
```

`discord-registration.test.ts` imports the real channel barrel and asserts the
registry contains `discord`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/discord` isn't installed
(the import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real server is verified manually once the service runs.

## Credentials

Discord app setup is human and interactive — no parser can click through the
Discord Developer Portal. The adapter is installed and registered, but it can't
receive a message until the bot exists, has Message Content Intent, and shares a
server with you. Tell the user:

```nc:operator
Create the Discord bot:
1. Go to https://discord.com/developers/applications → New Application. Name it (e.g. "NanoClaw Assistant").
2. Bot tab → Add Bot if needed → Reset Token, then copy the Bot Token (it's shown only once).
3. Bot tab → Privileged Gateway Intents → enable Message Content Intent.
4. OAuth2 → URL Generator → Scopes: bot; Bot Permissions: Send Messages, Read Message History, Add Reactions, Attach Files, Use Slash Commands.
5. Open the generated URL and invite the bot to a server you're also in (a personal server is fine) — the bot can only DM you once you share a server.
```

Paste the Bot Token (it's shown only once). You don't paste the Application ID or
the Public Key by hand — the bot's own application record carries both, so a
single call derives them from the token:

```nc:prompt bot_token secret validate:^[A-Za-z0-9._-]{50,}$
Paste the Bot Token — Bot tab. Click `Reset Token` if you need a new one.
```

Read the application's own record. `GET /oauth2/applications/@me` returns the
Application ID (`id`), the Public Key (`verify_key`), and your own account as the
app's owner (`owner.id`) — so the App ID, the Public Key, and your Discord user ID
all come from this one call instead of being copied by hand. A bad token fails
here, before the restart, rather than silently later:

```nc:run capture:application_id=.id,public_key=.verify_key,owner_handle=.owner.id effect:fetch
curl -sf https://discord.com/api/v10/oauth2/applications/@me -H "Authorization: Bot {{bot_token}}"
```

Store the token and the two derived credentials — the adapter reads them from
`.env` and fails to start without `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID`
(set-if-absent, so a value you've already filled in is never overwritten):

```nc:env-set
DISCORD_BOT_TOKEN={{bot_token}}
DISCORD_APPLICATION_ID={{application_id}}
DISCORD_PUBLIC_KEY={{public_key}}
```
## Restart

Restart the service so it loads the Discord adapter and the credentials you just
stored, and wait for its CLI socket before resolving:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Invite the bot to a shared server

The bot can only DM you once it shares a server with you. If you didn't already
invite it via the OAuth2 URL Generator while setting up the app, do it now: add
the bot to a server you're also in (a personal server is fine). Tell the user:

```nc:operator
Open the invite link — https://discord.com/oauth2/authorize?client_id={{application_id}}&scope=bot&permissions=2147584064 — and add the bot to a server you're also in (a personal server works fine); the bot can only DM you once you share a server. If you already invited it while setting up the app, you can skip this.
```

## Resolve your DM channel

The agent talks to you in your direct-message channel with the bot. Your Discord
user ID was already derived as the application's owner (`owner_handle`), so all
that's left is to open the DM and read back its channel id.

Open the DM with `POST /users/@me/channels` and take the channel id it returns as
the conversation address `discord:@me:<channelId>` (if Discord refuses, the bot
doesn't share a server with you yet — invite it, then retry):

```nc:run capture:platform_id effect:fetch
curl -s -X POST https://discord.com/api/v10/users/@me/channels -H "Authorization: Bot {{bot_token}}" -H "Content-Type: application/json" -d '{"recipient_id":"{{owner_handle}}"}' | jq -er '"discord:@me:" + .id'
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
greeting goes out over the DM channel, which works as soon as the bot shares a
server with you.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `discord`
- **terminology**: Discord has "servers" (also called "guilds") containing "channels." Text channels start with #. The bot can also receive direct messages.
- **platform-id-format**: `discord:@me:{dmChannelId}` for the owner DM (e.g. `discord:@me:1399...`), `discord:{guildId}:{channelId}` for server channels — both IDs required for channels.
- **how-to-find-id**: Enable Developer Mode in Discord (Settings > App Settings > Advanced > Developer Mode). Then right-click a server and select "Copy Server ID" for the guild ID, and right-click the text channel and select "Copy Channel ID." The platform ID format used in registration is `discord:{guildId}:{channelId}` — both IDs are required.
- **supports-threads**: yes
- **typical-use**: Interactive chat — server channels or direct messages
- **default-isolation**: Same agent group for your personal server. Separate agent group for servers with different communities or where different members have different information boundaries.

## Troubleshooting

**The Bot Token paste is rejected.** The token must be at least 50 characters of letters, digits, dots, underscores, and hyphens — a real Bot Token has two `.` separators. It lives under **Bot → Reset Token** in the Developer Portal and is shown only once; reset to get a fresh one. The short numeric **Application ID** and the **OAuth2 Client Secret** are different values and won't pass.

**`applications/@me` returns 401.** The token was reset since you copied it, or a stray space/newline came along with the paste. Reset the token in the Bot tab and re-run the check — it fails here on purpose, before the restart, while the credential is still cheap to fix.

**The bot is online but never sees your messages.** Two usual causes: Message Content Intent is off (Bot tab → Privileged Gateway Intents), so message bodies arrive empty and nothing triggers; or the bot doesn't share a server with you — in which case `POST /users/@me/channels` also refuses. Open the invite URL and add the bot to a server you're in, then retry.

**Adapter looks installed but Discord never connects.** Run `pnpm exec vitest run src/channels/discord-registration.test.ts` — red means the barrel import or the `@chat-adapter/discord` install drifted, so re-run the Apply steps. If it's green, the service probably hasn't restarted since the credentials were stored: `bash setup/lib/restart.sh`, then check `logs/nanoclaw.error.log` for missing `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` complaints.
