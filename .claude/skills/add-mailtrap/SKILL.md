---
name: add-mailtrap
description: Add Mailtrap (email) channel integration via Chat SDK.
---

# Add Mailtrap Email Channel

Connect NanoClaw to email via Mailtrap for async email conversations. NanoClaw
doesn't ship channels in trunk — this skill copies the Mailtrap adapter in from the
`channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the Mailtrap adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/mailtrap.ts
src/channels/mailtrap-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './mailtrap.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@mailtrap/chat-sdk-adapter@0.1.0
```

### 4. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter imports `@mailtrap/chat-sdk-adapter`; if it
isn't installed the barrel throws). End-to-end email delivery against a real
domain is verified manually once the service runs.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/mailtrap-registration.test.ts
```

`mailtrap-registration.test.ts` imports the real channel barrel and asserts the
registry contains `mailtrap`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@mailtrap/chat-sdk-adapter` isn't installed
(the import throws) — so it also covers the dependency from step 3.

## Credentials

Mailtrap account and domain setup is human and interactive — these steps are
prose, not directives (no parser can verify a sending domain or click through the
Mailtrap UI). A recipe rebuild produces a compiling, registered adapter that cannot
receive a message until they're done.

1. Go to [mailtrap.io](https://mailtrap.io) and create an account.
2. Add and verify your **sending domain** (SPF/DKIM).
3. Create a Mailtrap **Inbound** inbox on that **same custom domain** (MX records
   for inbound). The bot's from-address must be an address on this domain —
   outbound replies use the Email API with that From, and people reply to it, so
   the next message only reaches the agent if that address lands in the inbound
   inbox. A Mailtrap-hosted inbox address cannot be the From, so follow-ups would
   never hit the webhook.
4. Go to **API Tokens** and create a token with Email Sending and Inbound access.
5. Set up an inbound webhook:
   - Point it at `https://your-domain/webhook/mailtrap`.
   - Event: **inbound.message_received**.
   - Copy the signing secret.

Sandbox does not deliver this path — use production Email API + Inbound.

### Store the credentials

Capture the secrets, then write them. `prompt` only *asks* and binds the answer
to a name; a separate directive consumes it — so the same prompts could feed
`ncl` or the OneCLI vault instead of `.env` by swapping only the consumer. Here
they go to `.env` (set-if-absent — a value you've already filled in is never
overwritten):

```nc:prompt api_key secret
Paste the Mailtrap API token — API Tokens in the dashboard.
```
```nc:prompt webhook_secret secret
Paste the inbound webhook signing secret — the value you copied above. NanoClaw's webhook server listens on 127.0.0.1 only; if the proxy or tunnel serving that URL runs on another machine or in Docker on Linux, add `WEBHOOK_HOST=0.0.0.0` to `.env` (it takes effect at the next restart).
```
```nc:prompt from_address
The bot's sending email address on your verified inbound custom domain (e.g. `bot@yourdomain.com`). People reply to this address; it must be received by the inbound inbox.
```
```nc:prompt from_name
The display name to send as (e.g. `NanoClaw`).
```
```nc:env-set
MAILTRAP_API_TOKEN={{api_key}}
MAILTRAP_FROM_ADDRESS={{from_address}}
MAILTRAP_FROM_NAME={{from_name}}
MAILTRAP_WEBHOOK_SECRET={{webhook_secret}}
```
## Connect yourself

Because email is direct-addressable, the bot can write to you first — so wire
your own address as the owner and have it email you a hello. Tell it your address
and which agent should answer your email (`ncl groups list` shows their folders):

```nc:prompt owner_email
Your email address — I'll wire you as owner and email you a hello.
```
```nc:prompt agent_folder
Which agent should answer your email? Enter its folder (run `ncl groups list`).
```

Register yourself as the owner, wire your address so the agent answers your email,
and send the hello:

```nc:run effect:wire
ncl users create --id mailtrap:{{owner_email}} --kind mailtrap --display-name Owner
ncl roles grant --user mailtrap:{{owner_email}} --role owner
ncl messaging-groups create --channel-type mailtrap --platform-id mailtrap:{{owner_email}} --is-group 0
ncl wirings create --channel-type mailtrap --platform-id mailtrap:{{owner_email}} --agent-group {{agent_folder}} --engage-mode pattern --engage-pattern .
ncl messaging-groups send --channel-type mailtrap --platform-id mailtrap:{{owner_email}} --sender-id mailtrap:{{owner_email}} --sender Owner --text "Hi — I'm your NanoClaw assistant, reachable by email now. Reply to this thread anytime."
```

The hello arrives as a fresh email thread; reply to keep the conversation going.
Your own address is the conversation key (`mailtrap:<email>`).

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. (Answering an
*open* inbox — anyone who emails in, not just you — is a separate, not-yet-wired
case: email is plain-message, so the router never auto-creates a group for an
unknown sender; each correspondent's `mailtrap:<email>` must be wired
explicitly.)

## Channel Info

- **type**: `mailtrap`
- **terminology**: Mailtrap handles email. The bot has one fixed sending identity (`MAILTRAP_FROM_ADDRESS`, e.g. `bot@yourdomain.com`); every *external correspondent* the bot emails with is a separate conversation, keyed by *their* address.
- **how-to-find-id**: The platform ID is the **correspondent's** email address, prefixed — `mailtrap:<email>` (e.g. `mailtrap:you@example.com`) — **not** the bot's from-address. The adapter derives it from the reply-to party (`channelIdFromThreadId` returns `mailtrap:<email>`); each distinct email thread from that person (by root `Message-ID`) is a sub-conversation under it.
- **supports-threads**: no (the adapter sets `supportsThreads: false`; replies still thread via email headers, but the router does not treat threads as the primary conversation unit)
- **typical-use**: Async communication -- email conversations with longer response expectations
- **default-isolation**: Same agent group if you want your agent to handle email alongside other channels. Separate agent group if email contains sensitive correspondence that shouldn't be accessible from other channels.

## Troubleshooting

**Sends fail with 401.** The API token comes from Mailtrap → **API Tokens**. Create a new token with Email Sending (and Inbound) access and update `MAILTRAP_API_TOKEN` in `.env`.

**The hello email never lands, or hits spam.** The sending domain must show as verified under Mailtrap → **Sending Domains** — until the SPF/DKIM DNS records propagate, sends are rejected or spam-foldered. `MAILTRAP_FROM_ADDRESS` must be an address on that verified domain; a free-mail from-address will not work.

**Replies never reach the agent.** Inbound only flows via the webhook: Mailtrap Inbound → **Webhooks** must point at your public host at `/webhook/mailtrap` (shared webhook server, port 3000) with **inbound.message_received**, and `MAILTRAP_WEBHOOK_SECRET` must match that webhook's signing secret (`mailtrap-signature` header). A run of delivery failures means the URL is unreachable or the secret mismatches.

**First reply works, then the conversation stops.** The from-address must be received by the inbound inbox. Use a custom-domain inbound inbox and set `MAILTRAP_FROM_ADDRESS` to an address on that domain. A hosted Mailtrap inbox address cannot be the From, so human replies to the bot never re-enter the webhook.

**Adapter installed but nothing flows.** Run `pnpm exec vitest run src/channels/mailtrap-registration.test.ts` — red means the barrel import or the `@mailtrap/chat-sdk-adapter` install drifted, so re-run the Apply steps. If green, restart the service so it loads the adapter and `.env`, then re-send the hello.

**A proxy or tunnel on another machine, or in Docker on Linux, gets connection refused or times out.** The webhook server listens on 127.0.0.1 only. Add `WEBHOOK_HOST=0.0.0.0` to `.env` and restart; `Webhook server started` in `logs/nanoclaw.log` shows the host it bound.
