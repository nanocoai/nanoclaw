---
name: add-webex
description: Add Webex channel integration via Chat SDK.
---

# Add Webex Channel

Adds Cisco Webex support via the Chat SDK bridge. NanoClaw doesn't ship channels
in trunk — this skill copies the Webex adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Webex adapter and its registration test
into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/webex.ts
src/channels/webex-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './webex.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`.
The Webex adapter ships under the third-party `@bitbasti/*` namespace, not
`@chat-adapter/*`, so it carries its own version line (`0.1.0`) rather than
tracking the chat core version:

```nc:dep
@bitbasti/chat-adapter-webex@0.1.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/webex-registration.test.ts
```

`webex-registration.test.ts` imports the real channel barrel and asserts the
registry contains `webex`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@bitbasti/chat-adapter-webex` isn't
installed (the import throws) — so it also covers the dependency from step 3.
End-to-end delivery against a real Webex space is verified manually once the
service runs — see the webhook setup below.

## Credentials

Webex bot setup is human and interactive — these steps are prose, not directives
(no parser can click through the Webex Developer Portal). A recipe rebuild
produces a compiling, registered adapter that cannot receive a message until
they're done.

### Create the Webex bot

1. Go to [developer.webex.com](https://developer.webex.com/my-apps/new/bot) and create a new bot.
2. Copy the **Bot Access Token**.
3. Set up a webhook:
   - Use the Webex API or Developer Portal to create a webhook pointing to `https://your-domain/webhook/webex`.
   - Set a webhook secret for signature verification.

### Store the credentials

Capture the two values, then write them. `prompt` only *asks* and binds the
answer to a name; a separate directive consumes it — so the same prompts could
feed `ncl` or the OneCLI vault instead of `.env` by swapping only the consumer.
Here they go to `.env` (set-if-absent — a value you've already filled in is
never overwritten):

```nc:prompt bot_token secret
Paste the Bot Access Token — from the Webex bot you created.
```
```nc:prompt webhook_secret secret
Paste the webhook secret you set for signature verification.
```
```nc:env-set
WEBEX_BOT_TOKEN={{bot_token}}
WEBEX_WEBHOOK_SECRET={{webhook_secret}}
```
### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000
(`WEBHOOK_PORT` to change it), handling `/webhook/webex`. This port must be
publicly reachable for Webex to deliver events. Running locally, expose it with
ngrok (`ngrok http 3000`), a Cloudflare Tunnel, or a reverse proxy on a VPS —
the resulting public URL is the base for the webhook URL above.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise run
`/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `webex`
- **terminology**: Webex has "spaces." A space can be a group conversation or a 1:1 direct message with the bot.
- **how-to-find-id**: Open the space in Webex, click the space name > Settings — the Space ID is listed there. Or use the Webex API (`GET /rooms`) to list spaces and their IDs.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team spaces or direct messages
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive information.

## Troubleshooting

**Sends fail with 401.** The Bot Access Token is shown once, on the bot's page under developer.webex.com → My Apps — it is *not* the 12-hour personal access token from the API docs pages, which is the classic mix-up (that one works briefly, then everything 401s). Regenerate the token on the bot page if needed; regenerating invalidates the old value, so update `WEBEX_BOT_TOKEN` right away.

**Messages in the space never reach the agent.** Webex delivers only to the webhook you created: it must target your public host at `/webhook/webex` (shared webhook server, port 3000) with resource `messages`. List your webhooks with `GET https://webexapis.com/v1/webhooks` using the bot token — Webex flips a webhook to `inactive` after repeated delivery failures, and it stays off until you re-enable or recreate it.

**Events arrive but are rejected.** Signature mismatch: the secret set at webhook creation must equal `WEBEX_WEBHOOK_SECRET` exactly. Recreate the webhook with a known secret and update `.env` to match.

**Adapter installed but silent.** Run `pnpm exec vitest run src/channels/webex-registration.test.ts` — red means the barrel import or the `@bitbasti/chat-adapter-webex` install drifted, so re-run the Apply steps. If green, restart the service so it loads the adapter and the tokens, then watch `logs/nanoclaw.log` for the webhook hit.
