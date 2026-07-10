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
- `src/channels/github-registration.test.ts` exists
- `src/channels/index.ts` contains `import './github.js';`
- `@chat-adapter/github` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its registration test

```bash
git show origin/channels:src/channels/github.ts                 > src/channels/github.ts
git show origin/channels:src/channels/github-registration.test.ts > src/channels/github-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './github.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/github@4.29.0
```

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/github-registration.test.ts
```

Both must be clean before proceeding. `github-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `github`. It goes red if the `import './github.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `@chat-adapter/github` isn't installed (the import throws) — so it also implicitly verifies the dependency from step 4. The adapter also calls core's `createChatSdkBridge(...)`; that typed core-API consumption is guarded by `pnpm run build`.

End-to-end message delivery against a real GitHub repo is verified manually once the service is running — see Next Steps and the webhook setup above.

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

Run `/manage-channels` to wire the GitHub channel to an agent group, or create the rows directly with `ncl`. **The host service must be running** — `ncl` connects to it over a Unix socket:

```bash
# Create messaging group (one per repo)
ncl messaging-groups create --channel-type github --platform-id "github:owner/repo" \
  --name "owner/repo" --is-group 1 --unknown-sender-policy <policy>

# Wire to agent group (engage mode/pattern default to the GitHub adapter's
# declared channel defaults; grab the mg id from the create output above)
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <your-agent-group-id> \
  --session-mode per-thread
```

Replace `<policy>` with `public` or `strict` based on the user's choice above.

### Adding members (for strict mode)

When using `strict`, add each GitHub user who should be able to trigger the agent:

```bash
# Add user (kind = 'github', id = 'github:<numeric-user-id>')
ncl users create --id "github:<user-id>" --kind github --display-name "<username>"

# Grant membership to the agent group
ncl members add --user "github:<user-id>" --group "<agent-group-id>"
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
