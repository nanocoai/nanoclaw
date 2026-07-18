---
name: add-github
description: Add GitHub channel integration via Chat SDK. PR and issue comment threads as conversations.
---

# Add GitHub Channel

Adds GitHub support via the Chat SDK bridge. The agent participates in PR and
issue comment threads. NanoClaw doesn't ship channels in trunk — this skill
copies the GitHub adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Prerequisites

You need a **dedicated GitHub bot account** (not your personal account). The adapter uses this account to post replies and filters out its own messages to avoid loops. Create a free GitHub account for your bot (e.g. `my-org-bot`), then invite it as a collaborator with write access to the repos you want monitored.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the GitHub adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/github.ts
src/channels/github-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './github.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/github@4.29.0
```

### 4. Build and validate

The build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter import throws if `@chat-adapter/github`
isn't present):

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/github-registration.test.ts
```

`github-registration.test.ts` imports the real channel barrel and asserts the
registry contains `github`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/github` isn't installed
(the import throws) — so it also covers the dependency from step 3.

End-to-end message delivery against a real GitHub repo is verified manually once
the service is running — see Next Steps and the webhook setup below.

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

Capture the three values, then write them. `prompt` only *asks* and binds the
answer to a name; a separate directive consumes it — so the same prompts could
feed `ncl` or the OneCLI vault instead of `.env` by swapping only the consumer.
Here they go to `.env` (set-if-absent — a value you've already filled in is
never overwritten):

```nc:prompt github_token secret
Paste the Fine-grained Personal Access Token for the bot account — starts with `github_pat_`.
```
```nc:prompt webhook_secret secret
Paste the webhook secret you generated for the repo webhook(s).
```
```nc:prompt bot_username
Enter the bot account's GitHub username exactly (used for @-mention detection).
```
```nc:env-set
GITHUB_TOKEN={{github_token}}
GITHUB_WEBHOOK_SECRET={{webhook_secret}}
GITHUB_BOT_USERNAME={{bot_username}}
```
`GITHUB_BOT_USERNAME` must match the bot account's GitHub username exactly. This is used for @-mention detection — the agent responds when someone writes `@your-bot-username` in a PR or issue comment.

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

## Troubleshooting

**API calls return 401/403 with the token.** The token must be a **fine-grained** PAT starting `github_pat_`, created while logged in as the *bot* account (Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens), with the monitored repos selected under Repository access and both **Pull requests** and **Issues** set to Read & Write. A classic `ghp_` token, or one minted on your personal account, is the usual miss.

**Webhook deliveries show red in the repo settings.** Open **Settings → Webhooks → Recent Deliveries** on the repo: a 401 response means the secret in the webhook form doesn't match `GITHUB_WEBHOOK_SECRET`; a timeout means `https://your-domain/webhook/github` isn't publicly reachable on the shared webhook port (3000). Fix, then use **Redeliver** to retest without writing a new comment.

**Comments never trigger the agent.** The @-mention must match `GITHUB_BOT_USERNAME` exactly, and the webhook must subscribe to **Issue comments** and **Pull request review comments** (not just pushes). Comments authored by the bot account itself are filtered by design — test from a different account than the bot.

**Adapter installed but the channel is dead.** Run `pnpm exec vitest run src/channels/github-registration.test.ts` — red means the barrel import or the `@chat-adapter/github` install drifted, so re-run the Apply steps. If green, restart the service (see Next Steps) so it loads the adapter and the new `.env` values.
