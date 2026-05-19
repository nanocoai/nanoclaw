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

NanoClaw doesn't ship channels in trunk. This skill copies the Linear adapter in from the `channels` branch and patches the Chat SDK bridge to support catch-all message forwarding (Linear OAuth apps can't be @-mentioned).

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/linear.ts` exists
- `src/channels/index.ts` contains `import './linear.js';`
- `@chat-adapter/linear` is listed in `package.json` dependencies
- `src/channels/chat-sdk-bridge.ts` contains `catchAll`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/linear.ts > src/channels/linear.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './linear.js';
```

### 4. Patch the Chat SDK bridge for catch-all message forwarding

Linear OAuth apps can't be @-mentioned, so the bridge's `onNewMention` handler never fires. Add `catchAll` support to `src/channels/chat-sdk-bridge.ts`:

**4a.** Add `catchAll?: boolean` to the `ChatSdkBridgeConfig` interface:

```typescript
  /**
   * Forward ALL messages in unsubscribed threads, not just @-mentions.
   * Use for platforms where the bot identity can't be @-mentioned (e.g.
   * Linear OAuth apps). The thread is auto-subscribed on first message.
   */
  catchAll?: boolean;
```

**4b.** Add this handler block right after the `chat.onNewMention(...)` block (before the DMs block):

```typescript
      // Catch-all for platforms where @-mention isn't possible (e.g. Linear
      // OAuth apps). Forward every unsubscribed message and auto-subscribe.
      if (config.catchAll) {
        chat.onNewMessage(/.*/, async (thread, message) => {
          const channelId = adapter.channelIdFromThreadId(thread.id);
          await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message));
          await thread.subscribe();
        });
      }
```

### 5. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/linear@4.27.0
```

### 6. Build

```bash
pnpm run build
```

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

Run `/manage-channels` to wire the Linear channel to an agent group, or insert manually:

```sql
-- Create messaging group (one per team)
INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
VALUES ('mg-linear-eng', 'linear', 'linear:ENG', 'Engineering', 1, 'public', datetime('now'));

-- Wire to agent group
INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)
VALUES ('mga-linear-eng', 'mg-linear-eng', '<your-agent-group-id>', '', 'all', 'per-thread', 10, datetime('now'));
```

The `platform_id` must be `linear:<TEAM_KEY>` matching the `LINEAR_TEAM_KEY` env var. Use `per-thread` session mode so each issue comment thread gets its own agent session.

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
