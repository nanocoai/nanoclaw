---
name: add-linear
description: Add Linear channel integration via Chat SDK. Issue comment threads as conversations.
---

# Add Linear Channel

Adds Linear support via the Chat SDK bridge. The agent participates in issue comment threads. Every comment on a Linear issue triggers the agent — no @-mention needed.

## Prerequisites

**Recommended:** Create a Linear **OAuth application** so the agent posts as an app identity, not as you. This prevents the adapter from filtering your own comments as self-messages.

1. Go to [Linear Settings > API > OAuth Applications](https://linear.app/settings/api/applications/new)
2. Create an app (e.g. "NanoClaw Bot")
   - Developer URL: your repo URL (e.g. `https://github.com/your-org/nanoclaw`)
   - Callback URL: `http://localhost`
3. After creating, click the app and enable **Client credentials** under grant types
4. Copy the **Client ID** and **Client Secret**

**Alternative:** Use a Personal API Key (`LINEAR_API_KEY`) for simpler setup. The agent will post as you, and your own comments will be filtered (other team members' comments still work).

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Linear adapter in from the `channels` branch and wires it into the channel registry. Linear OAuth apps post and read comments under an app identity that can't be @-mentioned, so when you wire the channel in `/manage-channels`, pick an engage mode that responds to plain comments rather than mention-only.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/linear.ts` exists
- `src/channels/linear-registration.test.ts` exists
- `src/channels/index.ts` contains `import './linear.js';`
- `@chat-adapter/linear` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its registration test

```bash
git show origin/channels:src/channels/linear.ts                 > src/channels/linear.ts
git show origin/channels:src/channels/linear-registration.test.ts > src/channels/linear-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './linear.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/linear@4.29.0
```

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/linear-registration.test.ts
```

Both must be clean before proceeding. `linear-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `linear`. It goes red if the `import './linear.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `@chat-adapter/linear` isn't installed (the import throws) — so it also implicitly verifies the dependency from step 4. The adapter calls core's `createChatSdkBridge(...)`; that typed core-API consumption is guarded by `pnpm run build`.

End-to-end message delivery against a real Linear workspace is verified manually once the service is running — see Wiring and Next Steps.

## Credentials

### 1. Set up a webhook

1. Go to **Linear Settings** > **API** > **Webhooks** > **New webhook**
2. Label: `NanoClaw`
3. URL: `https://your-domain/webhook/linear` (the shared webhook server, default port 3000)
4. Team: select the team you want to monitor
5. Events: check **Comment**
6. Save — copy the **signing secret**

Note: Linear webhook delivery may be delayed 1-5 minutes for new webhooks. This is normal.

### 2. Configure environment

Add to `.env`:

```bash
# OAuth app (recommended)
LINEAR_CLIENT_ID=your-client-id
LINEAR_CLIENT_SECRET=your-client-secret

# OR Personal API key (simpler, but agent posts as you)
# LINEAR_API_KEY=lin_api_...

LINEAR_WEBHOOK_SECRET=your-webhook-signing-secret
LINEAR_BOT_USERNAME=NanoClaw Bot
LINEAR_TEAM_KEY=ENG
```

- `LINEAR_BOT_USERNAME`: display name for the bot (used for self-message detection when using a Personal API Key)
- `LINEAR_TEAM_KEY`: the Linear team key (e.g. `ENG`, `NAN`). Find it in Linear under Settings > Teams. All issues in this team route to one messaging group.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Wiring

Ask the user: **Is this a private or public Linear workspace?**

- **Private workspace** — use `unknown_sender_policy: 'public'`. Only workspace members can comment.
- **Public workspace** — use `unknown_sender_policy: 'strict'` and add trusted members (see GitHub skill for member registration example).

Run `/manage-channels` to wire the Linear channel to an agent group, or create the rows directly with `ncl`. **The host service must be running** — `ncl` connects to it over a Unix socket:

```bash
# Create messaging group (one per team)
ncl messaging-groups create --channel-type linear --platform-id "linear:ENG" \
  --name "Engineering" --is-group 1 --unknown-sender-policy <policy>

# Wire to agent group (engage mode/pattern default to the Linear adapter's
# declared channel defaults; grab the mg id from the create output above)
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <your-agent-group-id> \
  --session-mode per-thread
```

Replace `<policy>` with `public` or `strict` based on the user's choice above. The `platform_id` must be `linear:<TEAM_KEY>` matching the `LINEAR_TEAM_KEY` env var. Use `per-thread` session mode so each issue comment thread gets its own agent session.

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
