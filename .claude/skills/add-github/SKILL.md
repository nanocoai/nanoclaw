---
name: add-github
description: Add GitHub channel integration via Chat SDK. PR and issue comment threads as conversations.
---

# Add GitHub Channel

Adds GitHub support via the Chat SDK bridge. The agent participates in PR and issue comment threads.

## Prerequisites

You need a **dedicated GitHub bot account** (not your personal account). The adapter uses this account to post replies and filters out its own messages to avoid loops. Create a free GitHub account for your bot (e.g. `my-org-bot`), then invite it as a collaborator with write access to the repos you want monitored.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the GitHub adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/github.ts` exists
- `src/channels/index.ts` contains `import './github.js';`
- `@chat-adapter/github` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/github.ts > src/channels/github.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './github.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/github@4.27.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

### 1. Create a Personal Access Token for the bot account

Log in as your **bot account**, then:

1. Go to [Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Create a **Fine-grained token** with:
   - Repository access: select the repos you want the bot to monitor
   - Permissions: **Pull requests** (Read & Write), **Issues** (Read & Write)
3. Copy the token

### 2. Set up a webhook on each repo

On each repo (logged in as the repo owner/admin):

1. Go to **Settings** > **Webhooks** > **Add webhook**
2. Payload URL: `https://your-domain/webhook/github` (the shared webhook server, default port 3000)
3. Content type: `application/json`
4. Secret: generate a random string (e.g. `openssl rand -hex 20`)
5. Events: select **Issue comments** and **Pull request review comments**

### 3. Configure environment

Add to `.env`:

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_BOT_USERNAME=your-bot-username
```

`GITHUB_BOT_USERNAME` must match the bot account's GitHub username exactly. This is used for @-mention detection — the agent responds when someone writes `@your-bot-username` in a PR or issue comment.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Wiring

Ask the user: **Is this a private or public repo?**

- **Private repo** — use `unknown_sender_policy: 'public'`. Only collaborators can comment anyway, so it's safe to let all comments through.
- **Public repo** — use `unknown_sender_policy: 'strict'`. Only registered members can trigger the agent, preventing strangers from consuming agent resources. Add trusted collaborators as members (see below).

Run `/manage-channels` to wire the GitHub channel to an agent group, or insert manually:

```sql
-- Create messaging group (one per repo)
INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
VALUES ('mg-github-myrepo', 'github', 'github:owner/repo', 'owner/repo', 1, '<policy>', datetime('now'));

-- Wire to agent group
INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)
VALUES ('mga-github-myrepo', 'mg-github-myrepo', '<your-agent-group-id>', '', 'all', 'per-thread', 10, datetime('now'));
```

Replace `<policy>` with `public` or `strict` based on the user's choice above.

### Adding members (for strict mode)

When using `strict`, add each GitHub user who should be able to trigger the agent:

```sql
-- Add user (kind = 'github', id = 'github:<numeric-user-id>')
INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
VALUES ('github:<user-id>', 'github', '<username>', datetime('now'));

-- Grant membership to the agent group
INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id)
VALUES ('github:<user-id>', '<agent-group-id>');
```

To find a GitHub user's numeric ID: `gh api users/<username> --jq .id`

Use `per-thread` session mode so each PR/issue gets its own agent session.

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

- **type**: `github`
- **terminology**: GitHub has "repositories" containing "pull requests" and "issues." Each PR or issue comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is `github:owner/repo` (e.g. `github:acme/backend`). Each PR/issue becomes its own thread automatically.
- **supports-threads**: yes (PR and issue comment threads are native conversations)
- **typical-use**: Webhook-driven — the agent receives PR and issue comment events and responds in comment threads when @-mentioned. After the first mention, the thread is subscribed and the agent responds to all follow-up comments.
- **default-isolation**: Use `per-thread` session mode. Each PR or issue gets its own isolated agent session. Typically wire to a dedicated agent group if the repo contains sensitive code.
