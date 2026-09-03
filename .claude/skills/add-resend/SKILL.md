---
name: add-resend
description: Add Resend (email) channel integration via Chat SDK.
---

# Add Resend Email Channel

Connect NanoClaw to email via Resend for async email conversations. NanoClaw
doesn't ship channels in trunk — this skill copies the Resend adapter in from the
`channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the Resend adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/resend.ts
src/channels/resend-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './resend.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@resend/chat-sdk-adapter@0.1.1
```

### 4. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter imports `@resend/chat-sdk-adapter`; if it
isn't installed the barrel throws). End-to-end email delivery against a real
domain is verified manually once the service runs.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/resend-registration.test.ts
```

`resend-registration.test.ts` imports the real channel barrel and asserts the
registry contains `resend`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@resend/chat-sdk-adapter` isn't installed
(the import throws) — so it also covers the dependency from step 3.

## Credentials

Resend account and domain setup is human and interactive — these steps are
prose, not directives (no parser can verify a sending domain or click through the
Resend UI). A recipe rebuild produces a compiling, registered adapter that cannot
receive a message until they're done.

1. Go to [resend.com](https://resend.com) and create an account.
2. Add and verify your sending domain.
3. Go to **API Keys** and create a new key.
4. Set up a webhook:
   - Go to **Webhooks** > **Add webhook**.
   - URL: `https://your-domain/webhook/resend`.
   - Events: select **email.received**.
   - Copy the signing secret.

### Store the credentials

Capture the secrets, then write them. `prompt` only *asks* and binds the answer
to a name; a separate directive consumes it — so the same prompts could feed
`ncl` or the OneCLI vault instead of `.env` by swapping only the consumer. Here
they go to `.env` (set-if-absent — a value you've already filled in is never
overwritten):

```nc:prompt api_key secret
Paste the Resend API key — API Keys, starts with `re_`.
```
```nc:prompt webhook_secret secret
Paste the webhook signing secret — Webhooks, the value you copied above.
```
```nc:prompt from_address
The bot's sending email address on your verified domain (e.g. `bot@yourdomain.com`).
```
```nc:prompt from_name
The display name to send as (e.g. `NanoClaw`).
```
```nc:env-set
RESEND_API_KEY={{api_key}}
RESEND_FROM_ADDRESS={{from_address}}
RESEND_FROM_NAME={{from_name}}
RESEND_WEBHOOK_SECRET={{webhook_secret}}
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
ncl users create --id resend:{{owner_email}} --kind resend --display-name Owner
ncl roles grant --user resend:{{owner_email}} --role owner
ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0
ncl wirings create --channel-type resend --platform-id resend:{{owner_email}} --agent-group {{agent_folder}} --engage-mode pattern --engage-pattern .
ncl messaging-groups send --channel-type resend --platform-id resend:{{owner_email}} --sender-id resend:{{owner_email}} --sender Owner --text "Hi — I'm your NanoClaw assistant, reachable by email now. Reply to this thread anytime."
```

The hello arrives as a fresh email thread; reply to keep the conversation going.
Your own address is the conversation key (`resend:<your-address>`).

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. (Answering an
*open* inbox — anyone who emails in, not just you — is a separate, not-yet-wired
case: email is plain-message, so the router never auto-creates a group for an
unknown sender; each correspondent's `resend:<their-address>` must be wired
explicitly.)

## Channel Info

- **type**: `resend`
- **terminology**: Resend handles email. The bot has one fixed sending identity (`RESEND_FROM_ADDRESS`, e.g. `bot@yourdomain.com`); every *external correspondent* the bot emails with is a separate conversation, keyed by *their* address.
- **how-to-find-id**: The platform ID is the **correspondent's** email address, prefixed — `resend:<their-address>` (e.g. `resend:you@example.com`) — **not** the bot's from-address. The adapter derives it from the reply-to party (`channelIdFromThreadId` returns `resend:<address>`); each distinct email thread from that person (by root `Message-ID`) is a sub-conversation under it.
- **supports-threads**: no (the adapter sets `supportsThreads: false`; replies still thread via email headers, but the router does not treat threads as the primary conversation unit)
- **typical-use**: Async communication -- email conversations with longer response expectations
- **default-isolation**: Same agent group if you want your agent to handle email alongside other channels. Separate agent group if email contains sensitive correspondence that shouldn't be accessible from other channels.

## Troubleshooting

**Sends fail with 401.** The API key comes from the Resend dashboard's **API Keys** page and starts with `re_`. Keys are shown once at creation — if in doubt, create a new one and update `RESEND_API_KEY` in `.env`.

**The hello email never lands, or hits spam.** The sending domain must show as verified under Resend → **Domains** — until the SPF/DKIM DNS records propagate, sends are rejected or spam-foldered. `RESEND_FROM_ADDRESS` must be an address on that verified domain; a free-mail from-address will not work.

**Replies never reach the agent.** Inbound only flows via the webhook: Resend → **Webhooks** must point at your public host at `/webhook/resend` (shared webhook server, port 3000) with the **email.received** event selected, and `RESEND_WEBHOOK_SECRET` must match that webhook's signing secret. Resend's webhook page lists delivery attempts — a run of failures means the URL is unreachable or the secret mismatches.

**Adapter installed but nothing flows.** Run `pnpm exec vitest run src/channels/resend-registration.test.ts` — red means the barrel import or the `@resend/chat-sdk-adapter` install drifted, so re-run the Apply steps. If green, restart the service so it loads the adapter and `.env`, then re-send the hello.
