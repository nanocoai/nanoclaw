---
name: add-mattermost
description: Add a self-hosted or cloud Mattermost bot channel through the Chat SDK bridge, reusing a local server when available and offering an evaluation server when none exists.
---

# Add Mattermost Channel

Adds Mattermost DMs, channels, threads, files, reactions, and interactive
approval cards. Messages arrive over Mattermost's WebSocket; card clicks return
to NanoClaw over an authenticated HTTP callback. Every step is safe to re-run.

## Discover the server first

Do this before installing the adapter or asking for a URL. The goal is to
reuse a healthy Mattermost the user already has and establish one canonical
base URL.

1. Check an existing `MATTERMOST_BASE_URL` in the current environment and
   NanoClaw env/config files. Do not print tokens or dump whole env files.
2. Probe likely local URLs, at least `http://localhost:8065` and
   `http://127.0.0.1:8065`, using `GET /api/v4/system/ping`. A listening port
   alone is not evidence that the service is Mattermost.
3. Inspect Docker/Compose for Mattermost containers. If a matching container
   exists but is stopped, offer to start it; do not start or recreate it
   without the user's approval.
4. If you find a healthy server, show its URL. Ask the user to use this server,
   enter a different URL, or create the local evaluation server. Do not select a
   server automatically. Treat the localhost and 127.0.0.1 endpoints for the
   same container as one server.
5. If nothing local is found, ask whether the user has a remote Mattermost.
   If not, offer the local evaluation installation in
   [LOCAL_SERVER.md](LOCAL_SERVER.md). Read that file only for local server
   discovery, repair, or installation.

Set `MATTERMOST_BASE_URL` to the chosen canonical URL (scheme included, no
trailing slash), then use that exact hostname in browser/Desktop setup. Do not
silently install Mattermost: it runs containers, binds a port, and persists
data, so show what will be created and get approval first.

## Apply

### 1. Detect the server

Test the configured URL and the standard local URLs. A detected server is only
a suggestion. The user must select the server.

```nc:run capture:discovery=.discovery,detected_url=.base_url,detected_config_access=.config_access,detected_container=.mattermost_container effect:fetch
node .claude/skills/add-mattermost/scripts/discover-server.mjs
```

```nc:operator when:discovery=found
NanoClaw found a healthy Mattermost server at {{detected_url}}. You can use this server, enter a different URL, or create a local evaluation server.
```

```nc:prompt server_choice when:discovery=found normalize:lower validate:^(use|enter|create)$
Enter `use` to use {{detected_url}}. Enter `enter` to specify a different Mattermost URL. Enter `create` to create a local evaluation server.
```

```nc:run capture:base_url=.base_url,config_access=.config_access,mattermost_container=.mattermost_container effect:fetch when:server_choice=use
node .claude/skills/add-mattermost/scripts/select-server.mjs use "{{detected_url}}" "{{detected_config_access}}" "{{detected_container}}"
```

```nc:prompt entered_url when:server_choice=enter normalize:rstrip-slash validate:^https?://(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~%+-]+)*$
Enter the Mattermost base URL. Include the scheme, for example `https://mattermost.example.com`.
```

```nc:run capture:base_url=.base_url,config_access=.config_access,mattermost_container=.mattermost_container effect:fetch when:server_choice=enter
node .claude/skills/add-mattermost/scripts/select-server.mjs enter "{{entered_url}}"
```

```nc:run capture:create_requested when:server_choice=create
printf 'yes\n'
```

```nc:operator when:discovery=none
NanoClaw did not find a healthy Mattermost server. You can enter a server URL or create a local evaluation server.
```

```nc:prompt no_server_choice when:discovery=none normalize:lower validate:^(enter|create)$
Enter `enter` to specify a Mattermost URL. Enter `create` to create a local evaluation server.
```

```nc:prompt entered_url_new when:no_server_choice=enter normalize:rstrip-slash validate:^https?://(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~%+-]+)*$
Enter the Mattermost base URL. Include the scheme, for example `https://mattermost.example.com`.
```

```nc:run capture:base_url=.base_url,config_access=.config_access,mattermost_container=.mattermost_container effect:fetch when:no_server_choice=enter
node .claude/skills/add-mattermost/scripts/select-server.mjs enter "{{entered_url_new}}"
```

```nc:run capture:create_requested when:no_server_choice=create
printf 'yes\n'
```

Explain what the installation creates. Give the user time to review the details. Then get approval.

```nc:operator when:create_requested=yes
The local evaluation server runs Mattermost Team Edition and PostgreSQL in containers. The installation creates a Docker network and named volumes. It saves configuration files in .nanoclaw/mattermost. It binds the server to 127.0.0.1:8065. You need Docker and Docker Compose. Port 8065 must be free. If the port is in use, the installation stops and makes no changes.
```

```nc:prompt local_install_approval when:create_requested=yes normalize:lower validate:^install$
Enter `install` to create and start these local resources.
```

After approval, verify the requirements and create the stack. Wait for a
maximum of 60 seconds for Mattermost. If the operation fails, show the last
100 service log lines and stop.

```nc:run effect:external when:local_install_approval=install
docker info >/dev/null && docker compose version >/dev/null
node -e 'const net=require("node:net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(8065,"127.0.0.1",()=>s.close())'
mkdir -p .nanoclaw/mattermost
cp .claude/skills/add-mattermost/assets/compose.yml .nanoclaw/mattermost/compose.yml
test -f .nanoclaw/mattermost/.env || { umask 077; printf 'MATTERMOST_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .nanoclaw/mattermost/.env; }
docker compose -f .nanoclaw/mattermost/compose.yml up -d
for attempt in $(seq 1 30); do curl -fsS --connect-timeout 1 --max-time 1 http://localhost:8065/api/v4/system/ping >/dev/null && exit 0; sleep 1; done; docker compose -f .nanoclaw/mattermost/compose.yml logs --tail 100 mattermost; exit 1
```

```nc:run capture:base_url=.base_url,config_access=.config_access,mattermost_container=.mattermost_container effect:fetch when:local_install_approval=install
node .claude/skills/add-mattermost/scripts/select-server.mjs create
```

### 2. Set the server SiteURL

Mattermost Desktop sends its configured server URL as the WebSocket Origin.
Before you install the adapter, set `ServiceSettings.SiteURL` to the same URL:
`{{base_url}}`. Keep
`ServiceSettings.WebsocketURL` blank. Do not change
`ServiceSettings.AllowCorsFrom` to correct an Origin error.

For the evaluation server, the Compose configuration manages SiteURL:

```nc:operator when:config_access=managed
The evaluation server already sets SiteURL to {{base_url}} and keeps WebsocketURL blank. NanoClaw will verify these values before it continues.
```

When discovery found host-local `mmctl`, ask before changing the server:

```nc:prompt site_url_action normalize:lower validate:^(set|already)$ when:config_access=host
Enter `set` to set SiteURL to {{base_url}} and clear WebsocketURL. Enter `already` if these values are already correct.
```

```nc:run effect:external when:site_url_action=set
mmctl config set ServiceSettings.SiteURL "{{base_url}}" --local
mmctl config set ServiceSettings.WebsocketURL "" --local
```

When discovery found `mmctl` inside a local Mattermost container, ask before
changing it there:

```nc:prompt site_url_action_docker normalize:lower validate:^(set|already)$ when:config_access=docker
Enter `set` to set SiteURL to {{base_url}} in {{mattermost_container}} and clear WebsocketURL. Enter `already` if these values are already correct.
```

```nc:run effect:external when:site_url_action_docker=set
docker exec "{{mattermost_container}}" mmctl config set ServiceSettings.SiteURL "{{base_url}}" --local
docker exec "{{mattermost_container}}" mmctl config set ServiceSettings.WebsocketURL "" --local
```

If local configuration access is unavailable, tell the operator:

```nc:operator when:config_access=unavailable
Set Mattermost ServiceSettings.SiteURL to {{base_url}}. Leave ServiceSettings.WebsocketURL blank. As a System Admin, run `mmctl config set ServiceSettings.SiteURL "{{base_url}}"`. Run `mmctl config set ServiceSettings.WebsocketURL ""`. You can also use System Console → Environment → Web Server. Do not change ServiceSettings.AllowCorsFrom to correct an Origin error.
```

```nc:prompt site_url_ready normalize:lower validate:^ready$ when:config_access=unavailable
Enter `ready` after you save these Mattermost settings.
```

Use the public client configuration endpoint to verify the settings. The
command must print `{{base_url}}` and then a blank line.

```nc:run effect:fetch
curl -fsS "{{base_url}}/api/v4/config/client?format=old" | jq -er --arg url "{{base_url}}" '(.SiteURL == $url and (.WebsocketURL // "") == "") as $ok | if $ok then .SiteURL, (.WebsocketURL // "") else error("Mattermost SiteURL/WebsocketURL mismatch") end'
```

### 3. Copy and register the channel

Copy the canonical adapter and registration test from the `channels` branch.

```nc:copy from-branch:channels
src/channels/mattermost.ts
src/channels/mattermost-registration.test.ts
src/channels/mattermost-adapter/adapter.ts
src/channels/mattermost-adapter/adapter.test.ts
src/channels/mattermost-adapter/format.ts
src/channels/mattermost-adapter/index.ts
src/channels/mattermost-adapter/rest.ts
src/channels/mattermost-adapter/thread-id.ts
src/channels/mattermost-adapter/types.ts
src/channels/mattermost-adapter/websocket.ts
src/channels/mattermost-adapter/websocket.test.ts
```

Append the channel's single reach-in to the barrel, skipping it if present.

```nc:append to:src/channels/index.ts
import './mattermost.js';
```

Remove the unscoped `chat-adapter-mattermost` package when it is installed.
Nothing in this repository imports it: it is typosquat-shaped against the
scoped `@chat-adapter` family, so any copy in `package.json` is stale or
mistaken and would sit beside the audited implementation copied from the
`channels` branch.

```nc:run
if node -e "const p=require('./package.json'); process.exit(p.dependencies?.['chat-adapter-mattermost'] ? 0 : 1)"; then pnpm remove chat-adapter-mattermost; fi
```

Install the vendored adapter's direct WebSocket dependencies at the exact
supported versions.

```nc:dep
ws@8.21.3
@types/ws@8.18.1
```

### 4. Create and authenticate the bot

Tell the operator:

```nc:operator
Now create a Mattermost bot for NanoClaw:
1. As a System Admin, open System Console → Integrations → Bot Accounts. Turn on Enable Bot Account Creation. This setting permits bot creation. You do not create the bot on this page.
2. Return to the Mattermost workspace. Open Product menu → Integrations → Bot Accounts. Select Add Bot Account. Create a bot, for example `nanoclaw`.
3. Copy the access token.
4. Add the bot to each required team and channel. Mattermost does not add bots to teams or channels automatically.
5. Keep the token secret. If you lose the token, create a replacement. Deactivate the old token after the replacement works.
```

```nc:prompt bot_token secret normalize:trim validate:^[A-Za-z0-9_-]{20,}$
Mattermost bot access token (20 or more letters, digits, underscores, or hyphens).
```

Confirm the credential and capture the bot identity. A failure means the URL,
token, or bot-account status is wrong.

```nc:run capture:bot_user_id=.id,bot_username=.username effect:fetch
curl -sf "{{base_url}}/api/v4/users/me" -H "Authorization: Bearer {{bot_token}}"
```

### 5. Configure authenticated card callbacks

Approvals require Mattermost itself—not the browser—to reach NanoClaw. Ask for
a URL routable from the Mattermost server. It may be NanoClaw's base URL or the
full `/webhook/mattermost` route; the adapter normalizes either form.

```nc:prompt callback_url normalize:rstrip-slash validate:^https?://.+
Callback URL reachable from Mattermost, such as `https://nanoclaw.example.com` or `http://host.docker.internal:3000/webhook/mattermost`.
```

Mattermost does not sign action callbacks. Generate a random shared secret for
the server-only callback context.

```nc:run capture:callback_secret effect:external validate:^[a-f0-9]{64}$
openssl rand -hex 32
```

Update `MATTERMOST_BASE_URL` on each run. This update lets the user select a
different server. Do not change existing credentials.

```nc:run effect:external remove:.claude/skills/add-mattermost/scripts/remove-base-url.mjs
pnpm exec tsx setup/index.ts --step set-env -- --key MATTERMOST_BASE_URL --value "{{base_url}}"
```

Store the other channel settings. Do not replace existing credentials.

```nc:env-set
MATTERMOST_BOT_TOKEN={{bot_token}}
MATTERMOST_CALLBACK_URL={{callback_url}}
MATTERMOST_CALLBACK_SECRET={{callback_secret}}
```

Tell the operator:

```nc:operator
Make sure that the Mattermost server can reach the callback host. For a private host or Docker bridge name, add the host name or IP address in System Console → Environment → Developer → Allow untrusted internal connections. Use a publicly trusted HTTPS certificate in production.
```

### 6. Resolve the owner's DM

Ask for the Mattermost username that will own this NanoClaw installation.

```nc:prompt owner_username normalize:lower validate:^[a-z0-9][a-z0-9._-]{0,63}$
Your Mattermost username, without `@`.
```

Resolve that user and open the DM shared with the bot.

```nc:run capture:owner_user_id=.id,owner_handle=.id effect:fetch
curl -sf "{{base_url}}/api/v4/users/username/{{owner_username}}" -H "Authorization: Bearer {{bot_token}}"
```

```nc:run capture:platform_id effect:fetch validate:^mattermost:[a-z0-9]{26}$
curl -sf -X POST "{{base_url}}/api/v4/channels/direct" -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '["{{owner_user_id}}","{{bot_user_id}}"]' | jq -er '"mattermost:" + .id'
```

The resolved `platform_id`, `owner_handle`, and `owner_username` are used by
`/init-first-agent`. If an owner exists, use `/manage-channels` instead.

### 7. Build, test, and restart

Build the composed host to guard the typed Chat SDK bridge call and dependency.

```nc:run effect:build
pnpm run build
```

Run the registration test through the channel barrel. Also run the installed
adapter regression tests.

```nc:run effect:test
pnpm exec vitest run src/channels/mattermost-registration.test.ts src/channels/mattermost-adapter/adapter.test.ts src/channels/mattermost-adapter/websocket.test.ts
```

Restart NanoClaw so the channel and credentials load.

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Next steps

For a first channel, continue with `/init-first-agent` using `mattermost`,
`{{platform_id}}`, and `{{owner_username}}`. Otherwise run `/manage-channels`.

Send the bot a DM and mention it in a joined channel. The first mention in an
unwired channel sends an approval card to the owner's bot DM. Approve it there;
NanoClaw replays the held message after creating the wiring.

Click a real approval card to verify callbacks. Success replaces the buttons
with the chosen result. An unsigned probe must return `401`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://<nanoclaw-host>:3000/webhook/mattermost
```

## Channel information

- **type:** `mattermost`
- **platform ID:** `mattermost:<channel-id>` for channels and DMs
- **threads:** channel posts use optional Mattermost reply roots
- **group trigger:** mention-sticky, scoped per thread
- **DM trigger:** every message
- **unknown channels:** request owner approval
- **transport:** WebSocket inbound, REST outbound, HTTP action callbacks

## Troubleshooting

**The token check returns 401.** The token is stale, belongs to a deactivated
bot, or was pasted incorrectly. Create a replacement token and deactivate the
old token after the replacement works.

**The bot ignores a channel.** Add it to that team and channel. Membership
changes are observed, but restarting NanoClaw forces a fresh subscription.

**A new channel gets no immediate reply.** Check the owner's DM with the bot.
NanoClaw holds the first message behind a channel-approval card and deduplicates
later mentions until that card is resolved.

**Desktop messages appear only after a manual refresh.** The server can reject
the WebSocket Origin. Use the same host name in the Desktop server URL,
`MATTERMOST_BASE_URL`, and `ServiceSettings.SiteURL`. Keep
`ServiceSettings.WebsocketURL` blank. Verify the values through
`/api/v4/config/client?format=old`. Check the server logs for `request origin
not allowed`. Do not change `ServiceSettings.AllowCorsFrom` to correct this
error. For a Compose installation, set SiteURL in the Compose configuration.

**Cards render but clicks do nothing.** From the Mattermost server, POST to the
callback URL. A `401` proves the path reaches NanoClaw; timeout or refusal means
routing or firewall failure. Mattermost logs report blocked hosts and TLS errors.

**The adapter repeatedly reconnects.** Confirm `/api/v4/websocket` supports
WebSocket upgrades through every reverse proxy and that idle connections live
longer than the adapter heartbeat.

**Messages arrive but no agent runs.** Inspect `ncl dropped-messages list` and
`ncl wirings list`. `no_agent_wired` means approval is pending or no wiring was
created; it is not an adapter failure.
