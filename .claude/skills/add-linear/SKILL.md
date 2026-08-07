---
name: add-linear
description: Add Linear channel integration via Chat SDK. Issue comment threads as conversations.
---

# Add Linear Channel

Adds Linear support via the Chat SDK bridge. The agent participates in issue
comment threads. Every comment on a Linear issue triggers the agent — no
@-mention needed. NanoClaw doesn't ship channels in trunk — this skill copies the
Linear adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Prerequisites

**Recommended:** Create a Linear **OAuth application** so the agent posts as an app identity, not as you. This prevents the adapter from filtering your own comments as self-messages.

1. Go to [Linear Settings > API > OAuth Applications](https://linear.app/settings/api/applications/new)
2. Create an app (e.g. "NanoClaw Bot")
   - Developer URL: your repo URL (e.g. `https://github.com/your-org/nanoclaw`)
   - Callback URL: `http://localhost`
3. After creating, click the app and enable **Client credentials** under grant types
4. Copy the **Client ID** and **Client Secret**

**Alternative:** Use a Personal API Key (`LINEAR_API_KEY`) for simpler setup. The agent will post as you, and your own comments will be filtered (other team members' comments still work).

## Apply

Linear OAuth apps post and read comments under an app identity that can't be
@-mentioned; the adapter's declared channel defaults therefore respond to plain
comments rather than mention-only, and the wiring below sets that same pattern
mode explicitly.

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Linear adapter and its registration
test into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/linear.ts
src/channels/linear-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into the channel
registry:

```nc:append to:src/channels/index.ts
import './linear.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/linear@4.29.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/linear-registration.test.ts
```

Both must be clean before proceeding. `linear-registration.test.ts` imports the
real channel barrel and asserts the registry contains `linear`. It goes red if
the `import './linear.js';` line is deleted or drifts, if the barrel fails to
evaluate, or if `@chat-adapter/linear` isn't installed (the import throws) — so
it also covers the dependency from step 3. End-to-end message delivery against a
real Linear workspace is verified manually once the service is running — see
Wiring and Next Steps.

## Credentials

Linear app and webhook setup is human and interactive — these steps are prose
(no parser can click through the Linear UI), except the final env write.

### 1. Set up a webhook

1. Go to **Linear Settings** > **API** > **Webhooks** > **New webhook**
2. Label: `NanoClaw`
3. URL: `https://your-domain/webhook/linear` (the shared webhook server, default port 3000)
4. Team: select the team you want to monitor
5. Events: check **Comment**
6. Save — copy the **signing secret**

Note: Linear webhook delivery may be delayed 1-5 minutes for new webhooks. This is normal.

### 2. Store the credentials

Capture the values, then write them. `prompt` only *asks* and binds the answer
to a name; a separate directive consumes it. Here they go to `.env`
(set-if-absent — a value you've already filled in is never overwritten) and sync
to the container.

Use **either** the OAuth app credentials (recommended) **or** a Personal API key.
For the API-key path, paste `none` at the OAuth prompts and set `LINEAR_API_KEY`
in `.env` by hand (commented in the template below). `LINEAR_BOT_USERNAME` is the
display name for the bot, used for self-message detection when using a Personal
API Key. `LINEAR_TEAM_KEY` is the Linear team key (e.g. `ENG`, `NAN`) — find it
in Linear under Settings > Teams; all issues in this team route to one messaging
group.

```nc:prompt linear_client_id secret
Paste the OAuth Client ID — Linear Settings > API > OAuth Applications. Paste `none` if using a Personal API key instead.
```
```nc:prompt linear_client_secret secret
Paste the OAuth Client Secret. Paste `none` if using a Personal API key instead.
```
```nc:prompt linear_webhook_secret secret
Paste the webhook signing secret from the webhook you just created.
```
```nc:prompt linear_team_key
Enter the Linear team key (e.g. `ENG`, `NAN`) — Settings > Teams.
```
```nc:prompt linear_bot_username
Enter the bot display name (e.g. `NanoClaw Bot`).
```
```nc:env-set
LINEAR_CLIENT_ID={{linear_client_id}}
LINEAR_CLIENT_SECRET={{linear_client_secret}}
LINEAR_WEBHOOK_SECRET={{linear_webhook_secret}}
LINEAR_TEAM_KEY={{linear_team_key}}
LINEAR_BOT_USERNAME={{linear_bot_username}}
```
If you went the Personal API key route, add this line to `.env` instead of the
OAuth pair (agent posts as you, your own comments are filtered):

```bash
LINEAR_API_KEY=lin_api_...
```

## Wiring

Linear is team-routed: the assistant watches one team and answers *every* comment
on its issues (it can't be @-mentioned). Wire the team you set up to an agent —
pick which one should answer (`ncl groups list` shows their folders). The host
service must be running — `ncl` connects to it over a Unix socket.

The sender policy depends on the workspace: a private workspace can use `public`
(only workspace members can comment anyway); a public workspace should use
`strict` so only registered members may talk to the agent.

```nc:prompt agent_folder
Which agent should answer Linear comments? Enter its folder (run `ncl groups list`).
```
```nc:prompt linear_sender_policy normalize:lower validate:^(public|strict)$
Is this a private or public Linear workspace? Enter `public` for a private workspace (only members can comment) or `strict` for a public workspace (only registered members may talk to the agent).
```
```nc:run effect:wire
ncl messaging-groups create --channel-type linear --platform-id linear:{{linear_team_key}} --is-group 1 --unknown-sender-policy {{linear_sender_policy}} --name {{linear_team_key}}
ncl wirings create --channel-type linear --platform-id linear:{{linear_team_key}} --agent-group {{agent_folder}} --engage-mode pattern --engage-pattern . --session-mode per-thread
```

The explicit `pattern` engage mode with pattern `.` matches the Linear adapter's
declared channel defaults — Linear can't be @-mentioned, so the agent answers
every comment. Each issue thread becomes its own conversation. There's no
welcome — Linear has no direct message, so the assistant greets people when it
first answers a comment. If you chose `strict`, register the people who may talk
to the agent (see the GitHub skill for adding members).

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, restart the service to pick up the new channel.

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Channel Info

- **type**: `linear`
- **terminology**: Linear has "teams" containing "issues." Each issue's comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is `linear:<TEAM_KEY>` (e.g. `linear:ENG`). Find your team key in Linear under Settings > Teams. Each issue becomes its own thread automatically.
- **supports-threads**: yes (issue comment threads are native conversations)
- **typical-use**: Webhook-driven — the agent receives all issue comment events and responds automatically. No @-mention needed (Linear OAuth apps can't be @-mentioned).
- **default-isolation**: Use `per-thread` session mode. Each issue comment thread gets its own isolated agent session.

## Troubleshooting

**Comments never reach the agent.** New Linear webhooks can lag 1–5 minutes, so wait before digging. Then check the webhook in Linear Settings → API → Webhooks: the URL must be your public host at `/webhook/linear` (shared webhook server, port 3000), the right team selected, and the **Comment** event checked. A mismatch between the webhook's signing secret and `LINEAR_WEBHOOK_SECRET` makes deliveries fail signature verification silently — re-copy the secret from the webhook page.

**OAuth credentials rejected.** The Client ID and Secret come from Linear Settings → API → OAuth Applications, and the app must have **Client credentials** enabled under grant types after creation — without that toggle the token exchange 401s. If you meant to use a Personal API key instead, answer `none` at both OAuth prompts and set `LINEAR_API_KEY` in `.env` by hand.

**The agent ignores your own comments.** That's Personal-API-key mode working as designed: comments from the key's account are filtered as self-messages so the bot doesn't answer itself. Other members' comments still trigger it; if it must answer you too, switch to the OAuth app identity.

**Sender-policy answer rejected, or issues route nowhere.** The policy must be exactly `public` or `strict` (lowercase), and `LINEAR_TEAM_KEY` must be the short team key (e.g. `ENG`) from Settings → Teams — all issues in that one team route to the messaging group.

**Wired but dead.** Run `pnpm exec vitest run src/channels/linear-registration.test.ts` — red means the barrel import or the `@chat-adapter/linear` install drifted, so re-run the Apply steps. If green, restart the service (see Next Steps) so the adapter and `.env` values are live.
