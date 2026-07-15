---
name: add-gchat
description: Add Google Chat channel integration via Chat SDK.
---

# Add Google Chat Channel

Adds Google Chat support via the Chat SDK bridge. NanoClaw doesn't ship channels
in trunk — this skill copies the Google Chat adapter in from the `channels`
branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Google Chat adapter and its
registration test into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/gchat.ts
src/channels/gchat-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './gchat.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/gchat@4.29.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/gchat-registration.test.ts
```

`gchat-registration.test.ts` imports the real channel barrel and asserts the
registry contains `gchat`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/gchat` isn't installed (the
import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real Google Chat space is verified manually once the service
runs — see Credentials and Next Steps.

## Credentials

Google Cloud setup is human and interactive — these steps are prose, not
directives (no parser can click through the Google Cloud Console). A recipe
rebuild produces a compiling, registered adapter that cannot receive a message
until they're done.

> 1. Go to [Google Cloud Console](https://console.cloud.google.com)
> 2. Create or select a project
> 3. Enable the **Google Chat API**
> 4. Go to **Google Chat API** > **Configuration**:
>    - App name and description
>    - Connection settings: select **HTTP endpoint URL** and set to `https://your-domain/webhook/gchat`
> 5. Create a **Service Account**:
>    - Go to **IAM & Admin** > **Service Accounts** > **Create Service Account**
>    - Grant the Chat Bot role
>    - Create a JSON key and download it

### Store the credentials

Capture the service account JSON, then write it. `prompt` only *asks* and binds
the answer to a name; a separate directive consumes it — so the same prompt
could feed `ncl` or the OneCLI vault instead of `.env` by swapping only the
consumer. Here it goes to `.env` (set-if-absent — a value you've already filled
in is never overwritten) as a single-line string:

```nc:prompt gchat_credentials secret
Paste the service account JSON as a single line — the key file you downloaded, e.g. `{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}`.
```
```nc:env-set
GCHAT_CREDENTIALS={{gchat_credentials}}
```
### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000
(`WEBHOOK_PORT` to change it), handling `/webhook/gchat`. This port must be
publicly reachable for Google Chat to deliver events — it's the HTTP endpoint
URL you set in the Connection settings above. Running locally, expose it with
ngrok (`ngrok http 3000`), a Cloudflare Tunnel, or a reverse proxy on a VPS.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise run
`/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `gchat`
- **terminology**: Google Chat has "spaces." A space can be a group conversation or a direct message with the bot.
- **how-to-find-id**: Open the space in Google Chat, look at the URL — the space ID is the segment after `/space/` (e.g. `spaces/AAAA...`). Or use the Google Chat API to list spaces.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team spaces or direct messages
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive contexts.

## Troubleshooting

**The adapter starts, then errors about credentials.** `GCHAT_CREDENTIALS` must be the *entire* service account JSON collapsed to one line — inspect `.env` and confirm it still contains `"type":"service_account"`, `"private_key"`, and `"client_email"`. A truncated paste (shells often mangle the multi-line private key) is the usual cause; download a fresh JSON key under **IAM & Admin → Service Accounts → Keys** and re-paste it as a single line.

**Messages sent in the space never reach the agent.** Google Chat delivers only to the HTTP endpoint URL set under **Google Chat API → Configuration**, and that URL must be publicly reachable at `/webhook/gchat` (shared webhook server, port 3000). Tunnel hostnames (ngrok free tier) change on restart — make sure the Configuration URL matches the tunnel that's actually up.

**The app doesn't appear when adding it to a space.** Check the Chat API Configuration page: the app status must be live and its visibility must include your domain or user, and you must be adding it from the same Google Workspace the Cloud project belongs to.

**Everything configured but still silent.** Run `pnpm exec vitest run src/channels/gchat-registration.test.ts` — red means the barrel import or the `@chat-adapter/gchat` install drifted, so re-run the Apply steps. If green, restart the service so it picks up the adapter and `.env`, then watch `logs/nanoclaw.log` for the inbound webhook hit.
