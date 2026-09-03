---
name: add-whatsapp-cloud
description: Add WhatsApp Business Cloud API channel via Chat SDK. Official Meta API.
---

# Add WhatsApp Cloud API Channel

Connect NanoClaw to WhatsApp via the official Meta WhatsApp Business Cloud API.
NanoClaw doesn't ship channels in trunk — this skill copies the WhatsApp Cloud
adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the WhatsApp Cloud adapter into
`src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/whatsapp-cloud.ts
src/channels/whatsapp-cloud-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './whatsapp-cloud.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/whatsapp@4.29.0
```

### 4. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed — the import throws at evaluation if `@chat-adapter/whatsapp`
is missing or the barrel drifts:

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/whatsapp-cloud-registration.test.ts
```

`whatsapp-cloud-registration.test.ts` imports the real channel barrel and asserts
the registry contains `whatsapp-cloud` — it goes red if the import line is deleted
or drifts, if the barrel fails to evaluate, or if `@chat-adapter/whatsapp` isn't
installed (the import throws), so it also covers the dependency from step 3.

End-to-end message delivery against a real WhatsApp Business number is verified
manually once the service is running — see Next Steps and the webhook setup
below.

## Upgrading an existing install

Older copies of the adapter registered this bridge under the bare `whatsapp` key,
which collided with the native Baileys adapter. It now registers under a distinct
`whatsapp-cloud` instance (channelType stays `whatsapp`). Two consequences for an
install that ran the previous version:

- **Webhook route moves** from `/webhook/whatsapp` to `/webhook/whatsapp-cloud`.
  Update the callback URL in your Meta App dashboard (WhatsApp > Configuration)
  accordingly.
- **Chat SDK state namespace moves.** Subscriptions in the `chat_sdk_*` tables
  re-key under the new instance, so previously-subscribed threads may need to
  re-engage the bot.

Fresh installs need none of this.

## Credentials

Meta app setup is human and interactive — these steps are prose, not directives
(no parser can click through the Meta dashboard). A recipe rebuild produces a
compiling, registered adapter that cannot receive a message until they're done.

1. Go to [Meta for Developers](https://developers.facebook.com/apps/) and create an app (type: Business).
2. Add the **WhatsApp** product.
3. Go to **WhatsApp** > **API Setup**:
   - Note the **Phone Number ID** (not the phone number itself).
   - Generate a **permanent System User access token** with `whatsapp_business_messaging` permission.
4. Go to **WhatsApp** > **Configuration**:
   - Set webhook URL: `https://your-domain/webhook/whatsapp-cloud`.
   - Set a **Verify Token** (any random string you choose).
   - Subscribe to webhook fields: `messages`.
5. Copy the **App Secret** from **Settings** > **Basic**.

### Store the credentials

Capture the four values, then write them. `prompt` only *asks* and binds the
answer to a name; a separate directive consumes it — so the same prompts could
feed `ncl` or the OneCLI vault instead of `.env` by swapping only the consumer.
Here they go to `.env` (set-if-absent — a value you've already filled in is
never overwritten):

```nc:prompt access_token secret
Paste the System User access token — WhatsApp > API Setup, with `whatsapp_business_messaging` permission.
```
```nc:prompt phone_number_id
Paste the Phone Number ID — WhatsApp > API Setup (not the phone number itself).
```
```nc:prompt app_secret secret
Paste the App Secret — Settings > Basic.
```
```nc:prompt verify_token secret
Paste the Verify Token — the random string you set under WhatsApp > Configuration.
```
```nc:env-set
WHATSAPP_ACCESS_TOKEN={{access_token}}
WHATSAPP_PHONE_NUMBER_ID={{phone_number_id}}
WHATSAPP_APP_SECRET={{app_secret}}
WHATSAPP_VERIFY_TOKEN={{verify_token}}
```
### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000
(`WEBHOOK_PORT` to change it), handling `/webhook/whatsapp-cloud`. This port must be
publicly reachable for Meta to deliver events. Running locally, expose it with
ngrok (`ngrok http 3000`), a Cloudflare Tunnel, or a reverse proxy on a VPS —
the resulting public URL is the base for the webhook URL set under WhatsApp >
Configuration above.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `whatsapp-cloud`
- **terminology**: WhatsApp Cloud API supports 1:1 conversations only (no group chats). Each conversation is with a phone number.
- **how-to-find-id**: The platform ID is the Phone Number ID from the Meta Business dashboard (not the phone number itself). Find it under WhatsApp > API Setup.
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat -- direct messages only
- **default-isolation**: Same agent group if you're the only person messaging the bot. Each additional person who messages gets their own conversation automatically, but they share the agent's workspace and memory -- use a separate agent group if you need information isolation between different contacts.

## Troubleshooting

**Meta's "Verify and save" fails on the webhook.** Meta hits your URL with a challenge the moment you click, so the endpoint must already be publicly reachable at `/webhook/whatsapp-cloud` (shared webhook server, port 3000) *and* the service must be running with `WHATSAPP_VERIFY_TOKEN` set to exactly the string you typed under WhatsApp > Configuration. Start or restart the service first, then click verify.

**Everything works for a day, then all calls 401.** You stored the temporary token from WhatsApp > API Setup, which expires in ~24 hours. Create a **System User** under Business Settings → Users, grant it the app with `whatsapp_business_messaging`, generate a permanent token, and replace `WHATSAPP_ACCESS_TOKEN`.

**Outbound messages are accepted but never delivered.** Two Meta-side gates: while the app is in development mode you can only message numbers added to the recipient allowlist in API Setup; and free-form replies are only allowed within 24 hours of the user's last inbound message — outside that window you need an approved template. Also confirm `WHATSAPP_PHONE_NUMBER_ID` is the Phone Number *ID*, not the phone number itself.

**Adapter installed but nothing flows.** Run `pnpm exec vitest run src/channels/whatsapp-cloud-registration.test.ts` — red means the barrel import or the `@chat-adapter/whatsapp` install drifted, so re-run the Apply steps. If green, restart the service (see Next Steps) so the adapter and `.env` values are live.
