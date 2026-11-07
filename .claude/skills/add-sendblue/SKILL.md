---
name: add-sendblue
description: Add direct Sendblue iMessage/SMS text messaging and guide free-account onboarding.
---

# Add Sendblue

Install a native text channel for one assigned Sendblue line. Incoming phone
numbers remain subject to NanoClaw's normal identity, membership, and approval
rules. Apply after `/setup` has configured a model, credential gateway, sandbox,
and running host. Sendblue supplies messaging; model access is separate.

## Apply

Run these steps from the NanoClaw project root. Reapplying updates the same files
and preserves credentials and conversation data. If the fork already has a recipe skill (a fork-owned `SKILL.md` listing
installed skills), add `add-sendblue` after `setup` there. If no recipe exists,
leave this as the recipe entry for a future fork recipe: `setup → add-sendblue`.
It composes with other channels.

### 1. Copy the payload

Fetch the upstream `channels` branch and copy these four files individually using
`git show origin/channels:<path> > <path>` (create parent directories as needed):

```text
src/channels/sendblue.ts
src/channels/sendblue-delivery.ts
src/channels/sendblue.test.ts
src/channels/sendblue-registration.test.ts
```

Run `git fetch origin channels` first. For an unmerged PR, fetch its head into a
local review ref and use that exact ref instead of `origin/channels` for all four
copies. The payload must land on `channels` before the released skill uses it.

### 2. Register the channel

Append this line to `src/channels/index.ts` only if absent:

```typescript
import './sendblue.js';
```

### 3. Prevent ambiguous sends from being replayed

In the delivery-error catch in `src/delivery.ts`, replace the existing condition
`if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS)` with:

```typescript
if (
  (await import('./channels/sendblue-delivery.js')).isTerminalSendblueDeliveryError(err) ||
  (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS)
)
```

Keep the condition's existing body and all other code. If this exact helper call
is present, skip the edit. If the original condition moved or changed, inspect
that catch before adapting it: Sendblue failures must call `markDeliveryFailed`
on the first attempt; other adapters retain the existing retry behavior. The
provider has no idempotency key, so a timeout after acceptance must not produce
a second text on the next host delivery poll.

### 4. Build and test

```bash
pnpm run build
pnpm exec vitest run src/channels/sendblue.test.ts src/channels/sendblue-registration.test.ts src/delivery.test.ts
```

The tests exercise the real barrel, webhook server, permissions/router, SQLite
mailboxes, and host delivery poll with a local HTTP provider. The container/model
edge is a deterministic outbox writer. They prove local wiring and rejected or
ambiguous sends, not real carrier delivery. No dependencies are added.

## Credentials and free-plan onboarding

1. Run `npx --yes @sendblue/cli@0.10.0 setup --phone +YOUR_PERSONAL_NUMBER`.
   Follow the challenge: **the human sends the verification text from their own
   phone**. Poll with `npx --yes @sendblue/cli@0.10.0 setup --check` (exit 3 means
   pending). Read the completed credentials locally from
   `~/.sendblue/credentials.json`: `apiKey`, `apiSecret`, and `assignedNumber`.
   Keep secret values out of chat, logs, Git, and container environments.
2. For each extra free-plan recipient, run
   `npx --yes @sendblue/cli@0.10.0 add-contact +RECIPIENT`. Have that recipient
   text the assigned line once to complete provider verification. Adding a local
   allowlist entry does not verify a provider contact.
3. Set the following keys in the host's `.env`, preserving existing values on
   reapply. Generate a fresh webhook secret with `openssl rand -hex 32` when
   none exists. Restrict `.env` permissions with `chmod 600 .env`.

```dotenv
SENDBLUE_API_KEY=<apiKey>
SENDBLUE_API_SECRET=<apiSecret>
SENDBLUE_FROM_NUMBER=<assignedNumber, not your personal phone>
SENDBLUE_SIGNING_SECRET=<random webhook shared secret>
SENDBLUE_ALLOW_FROM=+YOUR_PERSONAL_NUMBER
```

The allowlist is comma-separated E.164 numbers. An empty allowlist fails startup;
`*` is an explicit operator opt-in and still does not bypass NanoClaw permissions.
Host credentials are read from `.env` and stay outside agent containers.

## Start, connect, and use

1. Build and restart the host using `pnpm run build` and
   `bash setup/lib/restart.sh`. Expose only `/webhook/sendblue` through a public
   HTTPS reverse proxy/tunnel to the host's `WEBHOOK_PORT` (default 3000).
   The shared listener is owned by NanoClaw; keep its other routes private.
2. Add a receive webhook in Sendblue with that exact URL, the
   `SENDBLUE_SIGNING_SECRET`, and the assigned line. The API equivalent is an
   authenticated **POST** to `https://api.sendblue.com/api/account/webhooks`
   with headers `sb-api-key-id` and `sb-api-secret-key` and this JSON:

```json
{"webhooks":{"receive":[{"url":"https://YOUR_HOST/webhook/sendblue","secret":"YOUR_WEBHOOK_SECRET","sendblue_numbers":["+ASSIGNED_LINE"]}]}}
```

POST appends registrations. Inspect existing registrations before adding one,
so rerunning setup does not register duplicates. Keep the secret in a private
request file or the dashboard, not literal shell history. Authentication uses
Sendblue's `sb-signing-secret` shared-secret header; it is not an HMAC signature.

3. Bootstrap the operator's first DM through the normal host helper:

```bash
pnpm exec tsx scripts/init-first-agent.ts --channel sendblue \
  --user-id sendblue:+YOUR_PERSONAL_NUMBER --platform-id +YOUR_PERSONAL_NUMBER \
  --display-name "Your name" --agent-name "Your assistant"
```

Use the verified **operator's** phone here: this helper can create the initial
owner. Add other contacts through normal `/manage-channels` membership flows;
never grant owner merely because a number passed provider verification.
4. Text the assigned line: `Remember the word cobalt`. Wait for its reply, then
   ask `What word did I ask you to remember?` to exercise conversation continuity.
   Confirm both texts arrive on the handset. Also test an unallowed phone: it
   must not start an agent turn. Acceptance by Sendblue alone is not delivery.
5. Approval/question messages contain numbered choices and a reply command such
   as `/sendblue QUESTION_ID 1`. Reply from the same phone within ten minutes.
   Only one pending question per recipient is retained; the host still checks
   the action's authority. Restarting expires pending choices.

## Supported behavior

Direct iMessage/SMS text uses Sendblue's routing. Replies split at 2,000 Unicode
characters. Delivery receipts, echoes, and groups do not start turns. Attachments
produce a text-only notice without downloading external URLs. Outbound files and
media operations fail explicitly. Replay suppression retains 4,096 completed
handles in memory; the host owns durable mailbox state. Failed or ambiguous
outbound requests become failed host deliveries without automatic resend; inspect
provider history before manually retrying, especially after a partial long reply.

## Troubleshooting

- **401 webhook:** match the registered secret and host `.env`, then restart.
- **No turns:** check assigned `to_number`, sender allowlist, provider contact
  verification, DM wiring, and NanoClaw identity/membership. The platform ID is
  the raw `+E164` phone; the user ID is `sendblue:+E164`.
- **No replies:** inspect the host delivery status and provider status. An HTTP
  200 response containing `ERROR` is a failed delivery. Never blindly resend a
  timed-out request; it may already have been accepted.
- **Question expired:** request a fresh action through the web/other channel.
- **Fresh install missing payload:** use the reviewed PR head until maintainers
  publish the four files on the `channels` branch.

References: [Sendblue credentials](https://docs.sendblue.com/getting-started/credentials),
[send-message API](https://docs.sendblue.com/api/resources/messages/methods/send),
[webhooks](https://docs.sendblue.com/api/resources/webhooks).
