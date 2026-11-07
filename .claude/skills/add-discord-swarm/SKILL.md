---
name: add-discord-swarm
description: Add Agent Swarm (Teams) support to Discord. Each subagent appears as a differently-named sender via Discord webhooks. Requires Discord channel to be set up first (use /add-discord). Triggers on "discord swarm", "agent teams discord", "discord webhook swarm".
---

# Add Agent Swarm to Discord

This skill adds Agent Teams (Swarm) support to an existing Discord channel. Each subagent in a team sends messages through a Discord webhook with a custom `username`, so users can visually distinguish which agent is speaking.

**Prerequisite**: Discord must already be set up via the `/add-discord` skill. If `src/channels/discord.ts` does not exist or `DISCORD_BOT_TOKEN` is not configured, tell the user to run `/add-discord` first.

## How It Works

- The **main bot** receives messages and sends lead agent responses (already set up by `/add-discord`)
- **Webhooks** are used for subagent messages — one webhook per registered Discord channel
- When a subagent calls `send_message` with a `sender` parameter, the host POSTs to the webhook with `username` set to the sender's role name
- Messages appear in Discord with the subagent's name and the webhook's avatar

```
Subagent calls send_message(text: "Found 3 results", sender: "Researcher")
  → MCP writes IPC file with sender field
  → Host IPC watcher picks it up
  → Checks DISCORD_WEBHOOK_URLS for the target channel ID
  → POSTs to webhook with { content: "Found 3 results", username: "Researcher" }
  → Appears in Discord from "Researcher" (webhook)
```

Unlike Telegram (which requires a dedicated bot per identity), Discord webhooks accept a
dynamic `username` on every POST — so a single webhook per channel supports unlimited agent identities with no setup per-agent.

## Prerequisites

### 1. Create a Webhook for Each Discord Channel

Tell the user:

> For each Discord channel where you want agent swarm messages:
>
> 1. Open Discord and go to the channel
> 2. Click the gear icon (**Edit Channel**) next to the channel name
> 3. Go to **Integrations** → **Webhooks** → **New Webhook**
> 4. Give it a name (e.g. "NanoClaw Swarm") and click **Copy Webhook URL**
> 5. Repeat for each channel you want swarm support in

Wait for the user to provide the webhook URL(s).

## Implementation

### Step 1: Update Configuration

Read `src/config.ts`. Add `'DISCORD_WEBHOOK_URLS'` to the existing `readEnvFile` call, then export the parsed map:

```typescript
// In the readEnvFile call, add 'DISCORD_WEBHOOK_URLS' to the array.
// Then add this export after the other exports:

export const DISCORD_WEBHOOK_URLS: Record<string, string> = Object.fromEntries(
  (process.env.DISCORD_WEBHOOK_URLS || envConfig.DISCORD_WEBHOOK_URLS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      const id = entry.slice(0, eq).trim().replace(/^dc:/, '');
      const url = entry.slice(eq + 1).trim();
      return [id, url];
    }),
);
```

This parses `DISCORD_WEBHOOK_URLS=1234567890=https://discord.com/api/webhooks/...` into a
`{ "1234567890": "https://..." }` lookup used at send time.

### Step 2: Add Webhook Send Function to Discord Module

Read `src/channels/discord.ts` and add the following after the existing imports:

1. **Add import** for `DISCORD_WEBHOOK_URLS` from config:

```typescript
import { ASSISTANT_NAME, TRIGGER_PATTERN, DISCORD_WEBHOOK_URLS } from '../config.js';
```

2. **Add the webhook send function** before the `DiscordChannel` class definition:

```typescript
/**
 * Send a message via a Discord webhook with a custom username (sender identity).
 * One webhook per channel supports unlimited agent identities — the username
 * field is set dynamically per POST, so no bot pool is needed.
 */
export async function sendWebhookMessage(
  channelJid: string,
  text: string,
  senderName: string,
): Promise<void> {
  const channelId = channelJid.replace(/^dc:/, '');
  const webhookUrl = DISCORD_WEBHOOK_URLS[channelId];

  if (!webhookUrl) {
    logger.warn(
      { channelJid },
      'No webhook URL configured for channel — skipping swarm message',
    );
    return;
  }

  // Discord webhook message limit is 2000 characters
  const MAX_LENGTH = 2000;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    chunks.push(text.slice(i, i + MAX_LENGTH));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk, username: senderName }),
      });
      if (!res.ok) {
        logger.error(
          { channelJid, senderName, status: res.status },
          'Webhook POST failed',
        );
      }
    } catch (err) {
      logger.error({ channelJid, senderName, err }, 'Failed to send webhook message');
    }
  }

  logger.info(
    { channelJid, senderName, chunks: chunks.length },
    'Discord webhook message sent',
  );
}
```

### Step 3: Update Host IPC Routing

Read `src/ipc.ts` and make these changes:

1. **Add import** for `sendWebhookMessage`:

```typescript
import { sendWebhookMessage } from './channels/discord.js';
```

2. **Extend the IPC message routing** — find the block that currently reads:

```typescript
if (data.sender && data.chatJid.startsWith('tg:')) {
  await sendPoolMessage(
    data.chatJid,
    data.text,
    data.sender,
    sourceGroup,
  );
} else {
  await deps.sendMessage(data.chatJid, data.text);
}
```

Add a Discord branch:

```typescript
if (data.sender && data.chatJid.startsWith('tg:')) {
  await sendPoolMessage(
    data.chatJid,
    data.text,
    data.sender,
    sourceGroup,
  );
} else if (data.sender && data.chatJid.startsWith('dc:')) {
  await sendWebhookMessage(
    data.chatJid,
    data.text,
    data.sender,
  );
} else {
  await deps.sendMessage(data.chatJid, data.text);
}
```

If `src/ipc.ts` does not already have the `tg:` pool routing (i.e. `/add-telegram-swarm` was not applied), use a simpler two-branch version:

```typescript
if (data.sender && data.chatJid.startsWith('dc:')) {
  await sendWebhookMessage(data.chatJid, data.text, data.sender);
} else {
  await deps.sendMessage(data.chatJid, data.text);
}
```

### Step 4: Update CLAUDE.md Files

#### 4a. Add Agent Teams instructions to Discord group folders

For each Discord group folder that will use agent teams, read the existing
`groups/{folder}/CLAUDE.md` (or `groups/global/CLAUDE.md` as a base) and add:

```markdown
## Agent Teams

When creating a team to tackle a complex task, follow these rules:

### CRITICAL: Follow the user's prompt exactly

Create *exactly* the team the user asked for — same number of agents, same roles,
same names. Do NOT add extra agents, rename roles, or use generic names like
"Researcher 1". If the user says "a marine biologist, a physicist, and Alexander
Hamilton", create exactly those three agents with those exact names.

### Team member instructions

Each team member MUST be instructed to:

1. Share progress in the channel via `mcp__nanoclaw__send_message` with a `sender`
   parameter matching their exact role/character name (e.g., `sender: "Marine Biologist"`
   or `sender: "Alexander Hamilton"`). This makes their messages appear under a custom
   username in Discord.
2. Also communicate with teammates via `SendMessage` as normal for coordination.
3. Keep channel messages short — 2-4 sentences max per message. Break longer content
   into multiple `send_message` calls.
4. Use the `sender` parameter consistently — always the same name.
5. Discord renders markdown natively. Use **double asterisks** for bold, *single* for
   italic, `backticks` for code, and standard markdown headings if needed.

### Example team creation prompt

When creating a teammate, include instructions like:

```
You are the Marine Biologist. When you have findings or updates for the user, send
them to the channel using mcp__nanoclaw__send_message with sender set to
"Marine Biologist". Keep each message short (2-4 sentences max). Discord renders
markdown, so you can use **bold**, *italic*, and `code` normally. Also communicate
with teammates via SendMessage.
```

### Lead agent behavior

As the lead agent who created the team:

- You do NOT need to react to or relay every teammate message. The user sees those
  directly from the webhook.
- Send your own messages only to comment, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing
  response, wrap your *entire* output in `<internal>` tags.
```

### Step 5: Update Environment

Add webhook URL(s) to `.env`. Use the format `channelId=webhookUrl` for each channel,
comma-separated for multiple channels. The `dc:` prefix on the channel ID is optional:

```bash
DISCORD_WEBHOOK_URLS=1234567890123456789=https://discord.com/api/webhooks/xxx/yyy
```

For multiple channels:

```bash
DISCORD_WEBHOOK_URLS=1234567890123456789=https://discord.com/api/webhooks/xxx/yyy,9876543210987654321=https://discord.com/api/webhooks/aaa/bbb
```

Sync to container environment:

```bash
cp .env data/env/env
```

### Step 6: Rebuild and Restart

```bash
npm run build
# Linux:
systemctl --user restart nanoclaw
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

A container rebuild (`./container/build.sh`) is **not** required — the MCP tool
(`send_message` with `sender`) is unchanged; only the host-side routing is new.

### Step 7: Test

Tell the user:

> Send a message in your registered Discord channel asking for a multi-agent task, e.g.:
> "Assemble a team of a researcher and a writer to give me 3 fun facts about octopuses"
>
> You should see:
> - The lead agent (main bot) acknowledging and creating the team
> - Each subagent's messages appearing under a custom username (the webhook)
> - Short, scannable messages from each agent
>
> Check logs: `tail -f logs/nanoclaw.log | grep -i webhook`

## Architecture Notes

- Webhook messages appear with a custom `username` but share the webhook's **avatar**.
  For distinct avatars per agent, pass an `avatar_url` field in the POST body — this is
  optional and the skill does not require it.
- Unlike the Telegram bot pool, there is **no state to track** between sessions — each
  webhook POST is fully self-contained.
- If `DISCORD_WEBHOOK_URLS` does not contain an entry for the target channel, the message
  is silently dropped (a warning is logged). This is intentional — fall-through to
  `deps.sendMessage` is not done because the regular bot would double-post the message.
- The `dc:` prefix on channel IDs is stripped before the lookup, so both
  `dc:1234567890` and `1234567890` are valid key formats in `DISCORD_WEBHOOK_URLS`.

## Troubleshooting

### Webhook messages not appearing

1. Verify the webhook URL is correct: `curl -s <webhookUrl>` should return a JSON object
   with `type: 1`
2. Check `DISCORD_WEBHOOK_URLS` is set in `.env` AND synced to `data/env/env`
3. Confirm the channel ID in `DISCORD_WEBHOOK_URLS` matches the registered JID:
   `sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE jid LIKE 'dc:%'"`
4. Check logs: `grep -i webhook logs/nanoclaw.log`

### Webhook posts with wrong channel ID

The lookup strips the `dc:` prefix before matching. If your `DISCORD_WEBHOOK_URLS` uses
the full `dc:1234567890` format as the key, ensure the `replace(/^dc:/, '')` in the
config parsing handles it. The config code above already does this.

### Subagents not using send_message

Check the group's `CLAUDE.md` has the Agent Teams instructions. The lead agent reads this
when creating teammates and must include the `send_message` + `sender` instructions in
each teammate's prompt.

### "No webhook URL configured" warning in logs

The channel JID does not have a matching entry in `DISCORD_WEBHOOK_URLS`. Add the
channel's numeric ID (without `dc:` prefix) as the key.

## Removal

To remove Discord Swarm support while keeping basic Discord:

1. Remove `sendWebhookMessage` from `src/channels/discord.ts`
2. Remove `DISCORD_WEBHOOK_URLS` from `src/config.ts` (both the `readEnvFile` entry and
   the export)
3. Remove the `dc:` swarm branch from IPC routing in `src/ipc.ts` (revert to plain
   `sendMessage`)
4. Remove `DISCORD_WEBHOOK_URLS` from `.env` and `data/env/env`
5. Remove Agent Teams section from Discord group CLAUDE.md files
6. Rebuild: `npm run build && systemctl --user restart nanoclaw` (Linux) or
   `npm run build && launchctl unload ... && launchctl load ...` (macOS)
