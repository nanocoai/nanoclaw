---
name: add-teams
description: Add Microsoft Teams channel integration via Chat SDK.
---

# Add Microsoft Teams Channel

Adds Microsoft Teams support via the Chat SDK bridge — interactive chat in team
channels, group chats, and direct messages. NanoClaw doesn't ship channels in
trunk — this skill copies the Teams adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

Teams has no "paste a token" shortcut — a bot has to exist in Microsoft's cloud
before it can receive a message. The Microsoft Teams CLI collapses that into
one sign-in and one create command: it registers the Entra app, generates the
client secret, registers a Teams-managed bot (through the Teams Developer
Portal — **no Azure subscription needed**), uploads the app package, and hands
back an install link. The old ~7-step Azure portal walk survives only as a
fallback in [Alternatives](#alternatives) for tenants where the Developer
Portal is blocked.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Teams adapter and its registration test
into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/teams.ts
src/channels/teams-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './teams.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/teams@4.29.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/teams-registration.test.ts
```

`teams-registration.test.ts` imports the real channel barrel and asserts the
registry contains `teams`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/teams` isn't installed (the
import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real Teams workspace is verified manually once the service
runs.

## Credentials

The adapter is installed and registered, but it can't receive a message until a
bot exists, points at this machine, and is installed into Teams. The Teams CLI
does all of that below.

### Check for existing credentials

Re-running `teams app create` provisions a brand-new app registration and bot
each time — it never reuses the first one. So the flow starts with a probe:
when `.env` already carries a Teams credential — either key; a partial pair
means a half-finished setup that creating ANOTHER app would only corrupt —
every step below (prompts included) is skipped and the flow drops straight
through to [Restart](#restart). To rotate credentials or finish a partial
configuration, see [Troubleshooting](#troubleshooting); if your tunnel URL
changed, the fix is `teams app update`, not a re-run (also in Troubleshooting).

```nc:run capture:have_creds
( grep -q '^TEAMS_APP_ID=.' .env 2>/dev/null || grep -q '^TEAMS_APP_PASSWORD=.' .env 2>/dev/null ) && echo yes || echo no
```

Before creating anything, tell the user:

```nc:operator when:have_creds=no
Confirm you have everything Teams setup needs:
1. A Microsoft 365 account that can create Entra app registrations and upload custom apps (sideloading) — free personal Teams does NOT qualify; you need a Microsoft 365 Business / EDU / developer tenant.
2. A way to expose an HTTPS endpoint that forwards to this machine's webhook port 3000 (e.g. a Cloudflare Tunnel, or a reverse-proxied VPS). Start it now if it isn't running — e.g. `cloudflared tunnel --url http://localhost:3000` — the create step needs the URL up front. The next prompt asks for its public base URL: just the https:// origin, no trailing path.
Note: the bot is created single-tenant (only your own Microsoft 365 tenant can install it) — the right default for a self-hosted assistant. If you need a bot other tenants can install, set it up manually via the Alternatives section of this skill instead.
```

### Public URL

Microsoft delivers bot messages to an HTTPS endpoint you control; it has to
reach this machine's webhook server (port 3000, configurable via
`WEBHOOK_PORT`) at `/webhook/teams`.

```nc:prompt public_url when:have_creds=no validate:^https:// normalize:rstrip-slash
Paste your tunnel's public https:// URL — e.g. https://your-tunnel.trycloudflare.com
```

### App name

One more choice belongs to the human before anything is created. The name is
used everywhere at once: the Entra app registration, the bot, and the Teams
app are all created under it. There is no client-secret name to pick on this
path — the CLI generates the secret itself (Entra displayName `default`,
2-year expiry); rotating it later is in [Troubleshooting](#troubleshooting).

```nc:prompt app_name when:have_creds=no validate:^[\sA-Za-z0-9._-]{1,30}$ normalize:trim
What should the bot be called? One name covers the Entra app registration, the bot, and the Teams app (letters, digits, spaces, . _ -; max 30 characters) — e.g. NanoClaw.
```

### Install the Teams CLI

Installed globally with npm — not as a workspace dependency — deliberately:
the CLI's credential store (keytar) is a native module whose install script
must run to fetch its prebuilt binary, and pnpm's supply-chain policy blocks
dependency build scripts — a workspace install leaves the sign-in unable to
persist. The global install matches Microsoft's own instruction and keeps the
workspace policy intact. Pinned; re-running is a no-op. (If npm reports
EACCES here, your global prefix needs root — prefer a user-level Node like
nvm, or `npm config set prefix ~/.npm-global`.) `--loglevel=error` because
npm runs inside a pnpm script here and warns about every pnpm config var it
inherits — pure noise; real errors still print.

```nc:run effect:external when:have_creds=no
npm install -g @microsoft/teams.cli@3.0.2 --loglevel=error
```

npm's global bin directory is not reliably on PATH (custom prefixes rarely
are), so every step below calls the CLI by its absolute path,
`$(npm prefix -g)/bin/teams` (stderr of the prefix lookup silenced — same
pnpm-config noise as above). Where this document says to run `teams …` by
hand, use that path too if plain `teams` isn't found.

### Sign in to Microsoft 365

Every `teams` command is a separate process, so the sign-in must survive into
the next one via the CLI's on-disk token cache. A "libsecret not found —
token cache will be stored unencrypted" warning here is safe to ignore: the
CLI falls back to a plaintext cache file that persists fine, and setup signs
the session out at the end anyway. The login output may
also report "Azure CLI: not installed" — informational only; this flow
creates a Teams-managed bot precisely so the Azure CLI is never needed (it
only matters for `--azure` bots and the manual portal path). The
step below verifies persistence by re-reading the session from a fresh
process after login. In an interactive terminal the login opens a browser;
on a headless box (SSH) it prints a device code — open
microsoft.com/devicelogin on any machine and enter it. If this step fails,
run `teams login` then `teams status` by hand: status must say logged in, or
the cache is not persisting (see Troubleshooting).

```nc:run effect:step when:have_creds=no
"$(npm prefix -g 2>/dev/null)/bin/teams" login && "$(npm prefix -g 2>/dev/null)/bin/teams" status --json 2>/dev/null | grep -q '"loggedIn": true' && printf '=== NANOCLAW SETUP: TEAMS-LOGIN ===\nSTATUS: success\n=== END ===\n'
```

### Create the bot

One command registers the Entra app, generates a client secret (Graph can take
~30s to see the new app — the CLI retries), registers a Teams-managed bot, and
uploads the app package to the Teams Developer Portal. It needs the sign-in
from the previous step (`AUTH_REQUIRED` means run that first). The bot is
always created single-tenant (`--sign-in-audience myOrg`) — the right default
for a self-hosted assistant, applied without asking; for a bot other
Microsoft 365 tenants can install, set it up manually per
[Alternatives](#alternatives).

```nc:run effect:external when:have_creds=no capture:app_id=.credentials.CLIENT_ID,app_password=.credentials.CLIENT_SECRET,app_tenant_id=.credentials.TENANT_ID,teams_app_id=.teamsAppId,install_link=.installLink validate:^.+$
"$(npm prefix -g 2>/dev/null)/bin/teams" app create --name "{{app_name}}" --endpoint "{{public_url}}/webhook/teams" --sign-in-audience myOrg --json
```

### Store the credentials

The adapter reads these from `.env` (set-if-absent — a value you've already
filled in is never overwritten). The pairing matters: `SingleTenant` requires
`TEAMS_APP_TENANT_ID`, and a multi-tenant app must instead set
`TEAMS_APP_TYPE=MultiTenant` with **no** tenant ID — a mismatch makes the
adapter authenticate against the wrong authority and every message fails with
a 401 from Bot Framework.

```nc:env-set when:have_creds=no
TEAMS_APP_ID={{app_id}}
TEAMS_APP_PASSWORD={{app_password}}
TEAMS_APP_TENANT_ID={{app_tenant_id}}
TEAMS_APP_TYPE=SingleTenant
```

### Set the app icons

The CLI-created app ships with placeholder icons; this swaps in the NanoClaw
mascot (the same PNGs the manual-path package bakes into its zip), so the
install dialog below already shows it. Cosmetic — a failure is logged and
skipped, never blocking setup. Re-runnable any time while signed in to the
Teams CLI:

```nc:run effect:external when:have_creds=no
"$(npm prefix -g 2>/dev/null)/bin/teams" app update {{teams_app_id}} --color-icon setup/assets/teams/color.png --outline-icon setup/assets/teams/outline.png --json || echo "Icon update failed — cosmetic only, continuing."
```

### Who owns this bot

The account signed into the Teams CLI is the account that just created the
bot — that human is the wiring target this flow suggests. Its identity comes
from the CLI session, so this runs before the sign-out step below:

```nc:run effect:fetch when:have_creds=no capture:owner_upn=.username,owner_aad_id=.userObjectId validate:^.+$
"$(npm prefix -g 2>/dev/null)/bin/teams" status --json 2>/dev/null
```

### Confirm the wiring target

Nothing is wired without a confirmed target, and someone is always wired —
there is no skip. The account signed into the Teams CLI is often NOT the
person setting up NanoClaw, so a no leads to a clarifying choice: wire the
logged-in Teams user after all, or a different Teams user by Microsoft Entra
object ID. Identities are shown by sign-in name, never a raw ID:

```nc:operator when:have_creds=no
Detected the account that created the bot: {{owner_upn}}. Wiring the assistant to it means its first message arrives in that account's Teams DMs.
```

```nc:prompt wire_owner when:have_creds=no validate:^(yes|no)$ normalize:lower
Wire the assistant to this account?
```

```nc:operator when:wire_owner=no
You're currently logged in to Teams as {{owner_upn}}.
- To wire the assistant to this logged-in Teams user, choose "logged-in-account".
- To wire a different Teams user, get their Microsoft Entra object ID — found at entra.microsoft.com > Users > (person) > Overview > Object ID, or Teams admin center > Manage users — and choose "other-account". Once wired, the assistant messages them first.
```

```nc:prompt wire_target when:wire_owner=no validate:^(logged-in-account|other-account)$ normalize:lower
Which Teams user should the assistant be wired to?
```

```nc:prompt target_aad_id when:wire_target=other-account validate:^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ normalize:trim
Paste the Microsoft Entra object ID of the Teams user to wire (a GUID like 00000000-0000-0000-0000-000000000000).
```

Either choice re-enters the exact same path as a yes above — rebind the
wiring target and flip the branch, so the link chain below needs no second
copy per branch:

```nc:run when:wire_target=other-account capture:owner_aad_id=.aad,wire_owner=.wire validate:^.+$
printf '{"aad":"%s","wire":"yes"}' "{{target_aad_id}}"
```

```nc:run when:wire_target=logged-in-account capture:wire_owner validate:^yes$
echo yes
```

### Install the app in Teams

The app package is already uploaded — no manifest zip, no manual sideload.
Tell the user:

```nc:operator when:have_creds=no
Install the bot into Teams:
1. Open {{install_link}} — Teams opens with the app's install dialog. Click Add.
2. If you need the link again later, run: teams app get {{teams_app_id}} --install-link
3. If Teams refuses with a custom-app-upload error, a tenant admin must enable sideloading: Teams Admin Center > Teams apps > Setup policies > Global > "Upload custom apps" = On.
Once the app shows up in your Teams sidebar (or app list), continue.
```

### Link the bot to your account

Nothing to do in Teams yet — these are background API calls, and the whole
chain runs only for a confirmed target from
[Confirm the wiring target](#confirm-the-wiring-target) (the detected owner
on a yes, or the provided Entra object ID). Same move as
Slack's `conversations.open` and Discord's `users/@me/channels`:
create the bot↔owner 1:1 conversation proactively with the bot's own
credentials, so the assistant messages the human first — nobody has to DM the
bot to bootstrap it. This only works now that the app is installed (the step
above); if Microsoft hasn't finished propagating the install yet, the create
below can fail once — re-running the skill is safe.

First a Bot Framework token from the app credentials:

```nc:run effect:fetch when:wire_owner=yes capture:bot_token validate:^eyJ
curl -sf -X POST "https://login.microsoftonline.com/{{app_tenant_id}}/oauth2/v2.0/token" --data-urlencode "grant_type=client_credentials" --data-urlencode "client_id={{app_id}}" --data-urlencode "client_secret={{app_password}}" --data-urlencode "scope=https://api.botframework.com/.default" | jq -er '.access_token'
```

Create the 1:1 conversation (the AAD object id from the CLI session is a
valid member id; `smba.trafficmanager.net/teams` is the global service URL —
the same default the adapter itself uses):

```nc:run effect:fetch when:wire_owner=yes capture:conversation_id validate:^.+$
curl -sf -X POST "https://smba.trafficmanager.net/teams/v3/conversations" -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '{"bot":{"id":"28:{{app_id}}"},"members":[{"id":"{{owner_aad_id}}","name":"","role":"user"}],"tenantId":"{{app_tenant_id}}","channelData":{"tenant":{"id":"{{app_tenant_id}}"}},"isGroup":false}' | jq -er '.id'
```

The adapter identifies inbound senders by their Bot Framework `29:` id, not
the AAD id — the owner must be wired under that handle or their replies
would not be recognized. The conversation was created with exactly one
member (the owner), so its member list is the owner by construction; the
filter only guards against channels that list the bot itself (`28:` ids).
(Don't select by `.aadObjectId` here — the field is not reliably present in
this response and its GUID casing varies.)

```nc:run effect:fetch when:wire_owner=yes capture:owner_handle=.id,owner_name=.name validate:^.+$
curl -sf "https://smba.trafficmanager.net/teams/v3/conversations/{{conversation_id}}/members" -H "Authorization: Bearer {{bot_token}}" | jq -er '[.[] | select((.id // "") | startswith("28:") | not)][0] | {id, name: (.name // .givenName // "Teams user")}'
```

Compose the platform id exactly as the adapter encodes thread ids
(`teams:{b64url conversation}:{b64url service url}`):

```nc:run when:wire_owner=yes capture:platform_id validate:^teams:
node -e 'const c=process.argv[1];const s="https://smba.trafficmanager.net/teams/";console.log("teams:"+Buffer.from(c).toString("base64url")+":"+Buffer.from(s).toString("base64url"))' "{{conversation_id}}"
```

### Sign out of the Teams CLI

The Microsoft 365 session was only needed to create the bot and identify its
owner — the running adapter authenticates with the app credentials in
`.env`, never with your account. On a headless box that session is a
plaintext token file, which is worth removing unless you plan more `teams …`
commands (rotate secret, endpoint update, RSC — each just needs a fresh
`teams login`, a ~30-second device code):

```nc:prompt signout when:have_creds=no validate:^(yes|no)$ normalize:lower
Sign out of the Teams CLI now? The bot doesn't need this login to run — signing out is recommended on shared or headless boxes, and `teams login` gets you back any time.
```

```nc:run effect:external when:signout=yes
"$(npm prefix -g 2>/dev/null)/bin/teams" logout
```

## Restart

Restart the service so it loads the Teams adapter and the credentials you just
stored:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Finish wiring

On a fresh create, [Link the bot to your account](#link-the-bot-to-your-account) already resolved
everything the wire needs — `owner_handle` (the owner's `29:` id) and
`platform_id` (the bot↔owner DM). The setup wizard wires automatically from
those and the welcome message lands in the owner's Teams DMs. Applying this
skill outside the wizard? Run the same wire yourself:

```bash
pnpm exec tsx scripts/init-first-agent.ts --channel teams --user-id "teams:<owner_handle>" --platform-id "<platform_id>" --display-name "<the human's name>" --agent-name "<assistant name>" --role owner
```

**Fallback (re-runs, or the link step failed):** with credentials already in
`.env` the resolve steps are skipped, so there is nothing new to wire — the
first run's wiring still stands. If the install was never wired at all, the
DM-first path always works: DM the bot once ("hi" is fine) — the router
auto-creates the messaging group row in `data/v2.db` from that first inbound
— then run `/init-first-agent` (or `/manage-channels`) with your coding
agent.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now — it wires
the owner automatically from the resolved values. Otherwise wire per
[Finish wiring](#finish-wiring).

## Channel Info

- **type**: `teams`
- **terminology**: Teams has "teams" containing "channels." The bot can also receive DMs (personal scope) and group chat messages. Channels support threaded replies.
- **platform-id-format**: `teams:{base64url-conversation-id}:{base64url-service-url}` — auto-generated by the adapter from the first inbound activity, not human-readable. Use the auto-created messaging group for wiring.
- **how-to-find-id**: Send a message to the bot in the channel or a DM. NanoClaw auto-creates a messaging group and logs the platform ID. Use that messaging group for wiring.
- **supports-threads**: yes (channels only; DMs and group chats are flat)
- **typical-use**: Team collaboration with the bot in channels; personal assistant via DMs
- **default-isolation**: Separate agent group per team. DMs can share an agent group with your main channel for unified personal memory.

## Alternatives

### Multi-tenant bot

The Credentials flow above always creates a single-tenant bot (only your
Microsoft 365 tenant can install it) — the right default for a self-hosted
assistant, so the skill doesn't ask. For a bot any tenant can install, run
the create by hand with `multipleOrgs` and store the matching env pairing —
`MultiTenant` with **no** tenant ID (the same 401 pairing rule from the
credentials step):

```bash
"$(npm prefix -g)/bin/teams" app create --name "YourBot" --endpoint "https://your-domain/webhook/teams" --sign-in-audience multipleOrgs --json
```

```bash
TEAMS_APP_ID=<CLIENT_ID from the output>
TEAMS_APP_PASSWORD=<CLIENT_SECRET from the output>
TEAMS_APP_TYPE=MultiTenant
```

Install via the `installLink` in the output, then continue from
[Restart](#restart). If this skill already created a single-tenant app,
start over first — see Rotate or recreate credentials in
[Troubleshooting](#troubleshooting).

### Manual Azure portal path

For tenants where the Teams Developer Portal is blocked. Unlike the CLI path,
the Azure Bot resource in step 3 requires an active **Azure subscription**.
This is the classic walk; every value it produces maps onto the same `.env`
keys. Ask the human before creating anything: the app registration name,
single vs multi tenant, a client secret description, and (this path only) a
separate Azure Bot handle.

1. **App registration**: in https://portal.azure.com, search "App registrations"
   → "New registration". Name it (e.g. "NanoClaw"); Supported account types:
   Single tenant (most common for self-host) or Multi tenant. From the Overview
   page copy the **Application (client) ID** and — single tenant only — the
   **Directory (tenant) ID**.
2. **Client secret**: in the app registration, "Certificates & secrets" → "New
   client secret" (expires 180 days or longer). **Copy the Value now** — Azure
   shows it once (the Value column, not the Secret ID).
3. **Azure Bot resource**: search "Azure Bot" → Create. Bot handle: any unique
   name; Type of App: must match step 1; Creation type: "Use existing app
   registration" with the App ID from step 1. After creating, open the bot →
   Configuration and set **Messaging endpoint** to
   `https://your-domain/webhook/teams`, then Apply.
4. **Enable the Teams channel**: Azure Bot resource → Channels → Microsoft
   Teams → Accept terms → Apply.
5. **Store the credentials** in `.env` (the same 401 pairing rule applies —
   `SingleTenant` needs the tenant ID, `MultiTenant` must omit it):

   ```bash
   TEAMS_APP_ID=<Application (client) ID>
   TEAMS_APP_PASSWORD=<client secret Value>
   TEAMS_APP_TYPE=SingleTenant
   TEAMS_APP_TENANT_ID=<Directory (tenant) ID>
   ```
6. **Build the app package** (manifest + icons, written in-process to
   `data/teams/teams-app-package.zip` — no `zip` binary needed):

   ```bash
   pnpm exec tsx setup/channels/teams-manifest-build.ts --app-id YOUR_APP_ID --url https://your-domain
   ```
7. **Sideload**: Microsoft Teams → Apps → Manage your apps → Upload an app →
   "Upload a custom app" → select the zip → Add.
8. Continue from [Restart](#restart).

Or create the bot resource with the Azure CLI instead of the portal:

```bash
az group create --name nanoclaw-rg --location eastus
az bot create --resource-group nanoclaw-rg --name nanoclaw-bot --app-type SingleTenant --appid YOUR_APP_ID --tenant-id YOUR_TENANT_ID --endpoint "https://your-domain/webhook/teams"
az bot msteams create --resource-group nanoclaw-rg --name nanoclaw-bot
```

## Optional configuration

### Receive all channel messages (without @-mention)

By default the bot only receives messages when @-mentioned. With a CLI-created
bot, grant the resource-specific-consent (RSC) permissions directly — no
manifest edit, no re-upload; the app version is bumped automatically:

```bash
teams app rsc add <teams-app-id> ChannelMessage.Read.Group --type Application
teams app rsc add <teams-app-id> ChatMessage.Read.Chat --type Application
```

Then update/reinstall the app in the team so the new permissions get consented.
(`<teams-app-id>` is the Teams App ID shown in the install step — recover it
any time with `teams app list`, or find the app at
https://dev.teams.microsoft.com/apps.)

On the manual path, regenerate the package with RSC baked in and sideload it
again (the manifest version is bumped so the upload supersedes the original):

```bash
pnpm exec tsx setup/channels/teams-manifest-build.ts --app-id YOUR_APP_ID --url https://your-domain --rsc
```

## Troubleshooting

### "Upload a custom app" is missing / sideloading blocked

`teams status` shows whether sideloading is enabled at both tenant
and user level; the login output prints the same check.

- **Tenant level off**: Teams Admin Center → **Teams apps** → **Setup
  policies** → **Global** → **Upload custom apps** = On.
- **"Enabled for the tenant, but your user policy blocks it"**: the per-user
  policy is the blocker — Teams Admin Center → **Users** → find the user →
  **Policies** → **App setup policy** → assign one with **Upload custom
  apps** = On. Policy changes can take a while to propagate.

Free personal Teams does not support sideloading at all — use a Microsoft 365
Business / EDU / developer tenant.

The login step's sideloading probe is **advisory** — policy edits can take
hours to propagate and the probe has been seen flapping between runs on the
same account. The authoritative test is whether the install link's Add
actually works; only act on the probe if the install itself refuses.

### `teams: command not found`

The CLI installed fine but npm's global bin directory isn't on your PATH — a
common state with custom npm prefixes. Find it with `npm prefix -g` (the
binary is at `<prefix>/bin/teams`), then either add that directory to PATH or
symlink the binary somewhere already on it. The skill's own steps are immune —
they invoke the absolute path.

### Create fails immediately with `AUTH_REQUIRED` after a successful sign-in

The sign-in didn't persist: each `teams` command is a separate process, and
when the CLI's credential store can't load it silently falls back to an
in-memory cache that dies with the login process. Symptom check:
`teams status` says logged out right after a login succeeded. The known
cause: the **CLI was installed as a pnpm workspace dependency** — pnpm's
supply-chain policy skips dependency build scripts, so keytar (the CLI's
native credential store) never gets its binary and the whole store fails to
load. Use the global npm install this skill performs — and `pnpm uninstall
@microsoft/teams.cli` if a workspace copy lingers, so `teams` resolves to
the global one. (The "libsecret not found → stored unencrypted" warning is
NOT this failure — that fallback persists fine and is safe to ignore.)

After fixing, sign in again and confirm `teams status` shows logged in, then
re-run this skill.

### Bot never receives messages

1. The app is actually installed in Teams — if setup was interrupted before
   the install step, nothing got installed. Recover the install link:
   `teams app list` shows the Teams App ID, then
   `teams app get <teams-app-id> --install-link`.
2. The tunnel is up and the messaging endpoint matches it — the endpoint must
   be `https://<your-domain>/webhook/teams`, and your tunnel (e.g.
   `cloudflared tunnel --url http://localhost:3000`) must be forwarding to
   this machine's port 3000. Check
   with `teams app doctor <teams-app-id>` (CLI-created bots) or Azure
   Bot → **Configuration** (manual path).
3. The adapter started: `grep -i teams logs/nanoclaw.log | tail`.
4. The credentials are in `.env` (`TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`,
   `TEAMS_APP_TYPE`).

### Tunnel URL changed

Point the bot at the new endpoint:
`teams app update <teams-app-id> --endpoint "https://new-domain/webhook/teams"`
(manual path: Azure Bot → Configuration → Messaging endpoint).

### `Unauthorized` / 401 from Azure Bot Service

Either the credential pairing is wrong, or the secret is dead:

- **Pairing**: `TEAMS_APP_TYPE=SingleTenant` requires `TEAMS_APP_TENANT_ID`;
  `MultiTenant` must have **no** tenant ID set. A mismatch authenticates
  against the wrong authority and every send/receive 401s.
- **Secret**: expired or mispasted. Rotate with
  `teams app auth secret create <teams-app-id>` (or Azure portal →
  Certificates & secrets), update `TEAMS_APP_PASSWORD` in `.env`, and restart.

### Rotate or recreate credentials

The credentials flow skips creation while `.env` has `TEAMS_APP_ID` **or**
`TEAMS_APP_PASSWORD` — deleting just one line does not make the skill
regenerate it (that would pair a new app with stale keys). To rotate only the
secret, use the 401 section above. To start over completely: delete **all**
`TEAMS_*` lines from `.env`, optionally delete the old app at
https://dev.teams.microsoft.com/apps (CLI path) or in Azure Portal → App
registrations (manual path), then re-run this skill. Re-running
`teams app create` with old credentials still in `.env` would otherwise create
a second, orphaned app.

### Replies land in the wrong place

A Teams bot's platform ID is derived from the first inbound activity, so wire
the messaging group that the router auto-creates after you DM the bot — don't
guess the platform ID. See **Finish wiring** above.
