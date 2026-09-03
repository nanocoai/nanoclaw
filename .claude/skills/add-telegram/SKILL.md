---
name: add-telegram
description: Add Telegram channel integration via Chat SDK.
---

# Add Telegram Channel

Adds Telegram bot support via the Chat SDK bridge. NanoClaw doesn't ship
channels in trunk — this skill copies the Telegram adapter, its pairing helper,
and their tests in from the `channels` branch. The
`pair-telegram` setup step is maintained in trunk, so it is not copied here.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

Re-running with a bot already configured can add a second one instead of
re-pairing the first; see **Add another bot** under Credentials.

## Apply

### 1. Copy the adapter, helpers, and tests

Fetch the `channels` branch and copy the Telegram adapter, its pairing helper
(with its test), and the focused adapter tests into place (overwrite — the
branch is canonical):

```nc:copy from-branch:channels
src/channels/telegram.ts
src/channels/telegram-pairing.ts
src/channels/telegram-pairing.test.ts
src/channels/telegram-registration.test.ts
src/channels/telegram-connect-group.test.ts
src/channels/telegram-instances-registration.test.ts
src/channels/telegram-pairing-interceptor.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './telegram.js';
```

### 3. Register the pairing setup step

Add the `pair-telegram` loader to the `STEPS` map in `setup/index.ts`, inside the
dormant marker region (skipped if already present — `pair-telegram` ships in core,
so this idempotent-skips on a normal install, but is expressed for a
clean-upstream rebuild). The pairing handshake below spawns this step:

```nc:append to:setup/index.ts at:nanoclaw:setup-steps
'pair-telegram': () => import('./pair-telegram.js'),
```

### 4. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/telegram@4.29.0
```

### 5. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the focused tests.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/telegram-registration.test.ts src/channels/telegram-connect-group.test.ts
```

`telegram-registration.test.ts` imports the real channel barrel and asserts the
registry contains `telegram`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/telegram` isn't installed
(the import throws) — so it also covers the dependency from step 4. End-to-end
delivery against a real bot is verified manually once the service runs.

## Credentials

An install that already holds `TELEGRAM_BOT_TOKEN` can add a second bot instead of
re-pairing the first. Check which case this is; the answer steers the rest of the
flow:

```nc:run capture:has_default_bot
grep -qsE '^TELEGRAM_BOT_TOKEN=.+' .env && echo yes || echo no
```
```nc:run capture:add_another
[ "{{has_default_bot}}" = yes ] && echo ask || echo no
```

On a first install there is no bot to add another to, so `add_another` is `no` and
the steps below create and configure the first bot. When a bot is already configured, ask the
user whether to keep using it (`no`: the stored token stays as it is and the flow
re-pairs that bot) or to add another one (`yes`: the first bot's steps are satisfied
by the stored token and change nothing; the new bot is handled under **Add another
bot**):

```nc:prompt add_another validate:^(yes|no)$ normalize:lower when:add_another=ask
A Telegram bot is already configured (TELEGRAM_BOT_TOKEN in .env). Add another bot (yes), or keep using the existing one (no)?
```

Bot creation in Telegram is human and interactive — no parser can click through
BotFather. The adapter is installed and registered, but it can't receive a
message until the bot exists. On a first install, tell the user (a bot that is
already configured keeps its stored token below; a second one is created under
**Add another bot**):

```nc:operator when:has_default_bot=no
Create the Telegram bot:
1. Open Telegram and message @BotFather — Telegram's official bot for creating bots.
2. Send /newbot and follow the prompts: a friendly name, then a username that must end in "bot".
3. Copy the bot token it gives you (looks like 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11a).
4. Planning to use the bot in group chats? Send /mybots → your bot → Bot Settings → Group Privacy → Turn off, so the bot can see all messages and not just @mentions.
```

Collect the bot token and store it — the bridge reads it from `.env` (set-if-absent,
so a value you've already filled in is never overwritten) and syncs it to the
container:

```nc:prompt bot_token secret validate:^[0-9]+:[A-Za-z0-9_-]{35,}$
Paste the bot token from BotFather (looks like `123456:ABC-DEF...`).
```
```nc:env-set
TELEGRAM_BOT_TOKEN={{bot_token}}
```
Confirm the token works and capture the bot's handle — `getMe` returns the bot
account and fails here if the token is bad. You'll use the handle to open the
right chat just before pairing:

```nc:run capture:bot_username effect:fetch
curl -sf https://api.telegram.org/bot{{bot_token}}/getMe | jq -er '.result.username'
```

### Add another bot

Only when `add_another` is `yes`. The second bot is a named adapter instance: its
short name becomes the registry key `telegram-<name>` and, uppercased with dashes as
underscores, the token key suffix (`gh-bot` stores `TELEGRAM_BOT_TOKEN_GH_BOT`). A
name whose `TELEGRAM_BOT_TOKEN_<NAME>` key is already set is taken (storing under it
would overwrite that bot's token), so it is refused:

```nc:prompt bot_name validate:^[a-z0-9][a-z0-9-]*$ when:add_another=yes
Short name for the new bot (lowercase letters, digits, dashes; e.g. `mega`). Pick one whose token key is not already set in .env.
```
```nc:run capture:bot_name_env when:add_another=yes
echo {{bot_name}} | tr 'a-z-' 'A-Z_'
```
```nc:run effect:check when:add_another=yes
! grep -qs '^TELEGRAM_BOT_TOKEN_{{bot_name_env}}=.' .env
```

To pair an already-configured named bot again instead (its token is stored and the
service restarted, but pairing failed or was cancelled), run
`pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main --instance telegram-<name>`,
then `/init-first-agent` with `--instance telegram-<name>` if it was never wired.

The second bot is created with @BotFather exactly like the first. Tell the user:

```nc:operator when:add_another=yes
Create the second Telegram bot: message @BotFather, send /newbot and follow the prompts (its own friendly name, then a username that must end in "bot"), and copy the token it gives you. It must be a different bot from the one already configured. Planning to use it in group chats? Send /mybots → that bot → Bot Settings → Group Privacy → Turn off.
```

Then confirm its token with `getMe` as above:

```nc:prompt bot_token_2 secret validate:^[0-9]+:[A-Za-z0-9_-]{35,}$ when:add_another=yes
Paste the second bot's token from BotFather (looks like `123456:ABC-DEF...`). It must belong to a different bot than the one already configured.
```
```nc:run capture:bot_username_2 effect:fetch when:add_another=yes
curl -sf https://api.telegram.org/bot{{bot_token_2}}/getMe | jq -er '.result.username'
```

A second token that resolves to the same bot as the first (its handle matches) is
refused here, before anything is written: it would only start a second poller on
that bot, which the adapter refuses at startup anyway.

```nc:run effect:check when:add_another=yes
[ "{{bot_username_2}}" != "{{bot_username}}" ]
```

Store the token under its suffixed key and list the name in `TELEGRAM_INSTANCES`,
merged with the names already there. Both writes go through the `set-env` step,
which updates an existing key and logs the key, never the value:

```nc:run effect:step when:add_another=yes
pnpm exec tsx setup/index.ts --step set-env -- --key TELEGRAM_BOT_TOKEN_{{bot_name_env}} --value {{bot_token_2}}
```
```nc:run effect:step when:add_another=yes
pnpm exec tsx setup/index.ts --step set-env -- --key TELEGRAM_INSTANCES --value "$({ sed -n 's/^TELEGRAM_INSTANCES=//p' .env; echo {{bot_name}}; } | tr ',' '\n' | grep . | sort -u | paste -sd, -)"
```

The registry key is how pairing and wiring address the new bot:

```nc:run capture:instance when:add_another=yes
echo telegram-{{bot_name}}
```

## Restart

Restart the service so it loads the Telegram adapter and the token you just
stored, and wait for its CLI socket. The adapter must be live and polling before
pairing — it's the thing that observes the code you send:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Pair your chat

Telegram tokens carry no user binding, so the agent proves you own the chat with
a one-time pairing handshake: it issues a 6-digit code, you send those exact 6
digits to the bot from the chat you want to register, and the live adapter
matches them. Open the bot first so you're on the right screen when the code
appears. Tell the user:

```nc:operator when:add_another=no
Open @{{bot_username}} (https://telegram.me/{{bot_username}}) in Telegram now and keep it on screen — a 6-digit pairing code is about to appear in this terminal. When it does, send just those 6 digits to the bot as a message (in a group chat with Group Privacy on, prefix them with @{{bot_username}}). A wrong guess is rejected and a fresh code is issued automatically.
```

Run the pairing handshake. It prints the code, streams "waiting…" and wrong-code
feedback while it watches for your message, and resolves your chat address
`telegram:<chatId>` plus your Telegram user id once the code matches:

```nc:run effect:step capture:platform_id=PLATFORM_ID,owner_handle=ADMIN_USER_ID when:add_another=no
pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main
```

A second bot pairs through its own instance key: the code is bound to
`telegram-<name>`, the first bot ignores it, and the paired chat gets its own
messaging-group row for that instance (a bot cannot message a user who never opened
it, so the chat id known from the first bot is not reused). Tell the user:

```nc:operator when:add_another=yes
Open @{{bot_username_2}} (https://telegram.me/{{bot_username_2}}) in Telegram now and keep it on screen: a pairing code is about to appear in this terminal. Send just those digits to this new bot, not to the first one. A wrong guess is rejected and a fresh code is issued automatically.
```
```nc:run effect:step capture:platform_id=PLATFORM_ID,owner_handle=ADMIN_USER_ID when:add_another=yes
pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main --instance {{instance}}
```

`owner_handle` (your Telegram user id) and `platform_id` (`telegram:<chatId>`)
are what the owner-wiring step needs. The greeting goes out over the same chat as
soon as pairing completes. For a second bot, `instance` (`telegram-<name>`) comes
along too: pass it as `--instance` to `scripts/init-first-agent.ts` so the DM row,
the wiring and the welcome all target that bot (see `/init-first-agent`).

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Connect a group

After the first DM is paired, an owner or global admin can send `/connect_group` in
their bot DM. The bot replies with Telegram's native group picker. Choosing a
group adds the bot and posts an addressed start command there; NanoClaw then
sends its existing channel-registration approval card to an eligible
owner/admin DM. Nothing is wired until that card is approved.

The picker link is navigation, not authorization: it carries no secret and
creates no role, member, messaging-group, or wiring row. The existing approval
flow remains the authority. If the picker is unavailable, add the bot to the
group manually and post `/start@{{bot_username}} connect` there to reach the
same approval card.

If the negative Telegram chat ID is already known, the fully manual `ncl`
equivalent is:

```bash
ncl messaging-groups create --channel-type telegram --platform-id "telegram:<chat-id>" --name "<group-name>" --is-group 1
ncl wirings create --channel-type telegram --platform-id "telegram:<chat-id>" --agent-group "<folder>" --session-mode shared
```

`wirings create` applies Telegram's group defaults and creates the companion
destination row. Prefer `/connect_group` when the ID is unknown; it discovers
the group and keeps the approval card in the loop.

## Channel Info

- **type**: `telegram`
- **terminology**: Telegram calls them "groups" and "chats." A "group" has multiple members; a "chat" is a 1:1 conversation with the bot.
- **platform-id-format**: `telegram:{chatId}` (e.g. `telegram:123456789` for a DM, `telegram:-1001234567890` for a group — negative chat IDs are groups/channels).
- **how-to-find-id**: Do NOT ask the user for a chat ID. Pair the first DM with `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main`. For another group, have an owner/global admin send `/connect_group` in that paired DM, choose the group, and approve the resulting channel-registration card. The service must be running — the polling adapter observes both flows.
- **instances**: `TELEGRAM_BOT_TOKEN` is the default instance `telegram`; `TELEGRAM_INSTANCES=<name>,...` plus `TELEGRAM_BOT_TOKEN_<NAME>` adds `telegram-<name>` (reference: `.claude/skills/telegram-multi-instance/SKILL.md` on the `channels` branch).
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.

## Troubleshooting

**The bot token paste is rejected.** A BotFather token is `<numeric bot id>:<35+ character secret>` — e.g. `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11a`. Pasting only the part after the colon, or the bot's @username, won't pass. Recover the full token any time by sending `/token` to @BotFather.

**`getMe` fails.** The token was revoked (a `/revoke` or a fresh `/token` invalidates the old value) or picked up whitespace in the paste. Get the current token from BotFather and re-paste it.

**Pairing never completes.** The live adapter is what observes the code, so the service must be running — the restart step comes before pairing for exactly this reason. Send *just* the 6 digits from the exact chat you want registered; in a group with Group Privacy on, prefix them with `@<botname>`. Wrong guesses are fine (a fresh code is issued, up to 5 times), but a dead adapter waits forever.

**The bot ignores group messages.** Group Privacy is on, so the bot only sees addressed commands and replies, not ordinary `@bot` text. BotFather → `/mybots` → your bot → Bot Settings → Group Privacy → Turn off — then remove and re-add the bot to the group so the change takes effect.

**`/connect_group` is denied.** The Telegram sender is not a NanoClaw owner or global admin. The command never grants privileges; inspect them with `ncl roles list` and grant the intended role explicitly if appropriate.

**The group was chosen but no approval card arrived.** Confirm the service is running and post `/start@{{bot_username}} connect` in the group. The card is delivered to an eligible owner/admin DM, not to the group.

**The second bot never comes online.** `TELEGRAM_INSTANCES` and `TELEGRAM_BOT_TOKEN_<NAME>` are read once at start, so restart after adding a bot. A name whose token equals one already in use is skipped with a warning in `logs/nanoclaw.error.log` (Telegram allows one poller per token): give each bot its own BotFather token. A pairing code issued for `telegram-<name>` is ignored by the first bot; send it to the new one.

**Everything green but no replies.** Run `pnpm exec vitest run src/channels/telegram-registration.test.ts` — red means the barrel import or the `@chat-adapter/telegram` install drifted, so re-run the Apply steps. If green, restart again (`bash setup/lib/restart.sh`) and check `logs/nanoclaw.error.log` for token errors.
