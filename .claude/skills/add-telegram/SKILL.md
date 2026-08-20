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

Bot creation in Telegram is human and interactive — no parser can click through
BotFather. The adapter is installed and registered, but it can't receive a
message until the bot exists. Tell the user:

```nc:operator
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

## Restart

Restart the service so it loads the Telegram adapter and the token you just
stored, and wait for its CLI socket. The adapter must be live and polling before
pairing — it's the thing that observes the code you send:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Pair your chat

Telegram tokens carry no user binding, so the agent proves you own the chat with
a one-time pairing handshake: it issues a 4-digit code, you send those exact 4
digits to the bot from the chat you want to register, and the live adapter
matches them. Open the bot first so you're on the right screen when the code
appears. Tell the user:

```nc:operator
Open @{{bot_username}} (https://telegram.me/{{bot_username}}) in Telegram now and keep it on screen — a 4-digit pairing code is about to appear in this terminal. When it does, send just those 4 digits to the bot as a message (in a group chat with Group Privacy on, prefix them with @{{bot_username}}). A wrong guess is rejected and a fresh code is issued automatically.
```

Run the pairing handshake. It prints the code, streams "waiting…" and wrong-code
feedback while it watches for your message, and resolves your chat address
`telegram:<chatId>` plus your Telegram user id once the code matches:

```nc:run effect:step capture:platform_id=PLATFORM_ID,owner_handle=ADMIN_USER_ID
pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main
```

`owner_handle` (your Telegram user id) and `platform_id` (`telegram:<chatId>`)
are what the owner-wiring step needs. The greeting goes out over the same chat as
soon as pairing completes.

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
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.

## Troubleshooting

**The bot token paste is rejected.** A BotFather token is `<numeric bot id>:<35+ character secret>` — e.g. `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11a`. Pasting only the part after the colon, or the bot's @username, won't pass. Recover the full token any time by sending `/token` to @BotFather.

**`getMe` fails.** The token was revoked (a `/revoke` or a fresh `/token` invalidates the old value) or picked up whitespace in the paste. Get the current token from BotFather and re-paste it.

**Pairing never completes.** The live adapter is what observes the code, so the service must be running — the restart step comes before pairing for exactly this reason. Send *just* the 4 digits from the exact chat you want registered; in a group with Group Privacy on, prefix them with `@<botname>`. Wrong guesses are fine (a fresh code is issued, up to 5 times), but a dead adapter waits forever.

**The bot ignores group messages.** Group Privacy is on, so the bot only sees addressed commands and replies, not ordinary `@bot` text. BotFather → `/mybots` → your bot → Bot Settings → Group Privacy → Turn off — then remove and re-add the bot to the group so the change takes effect.

**`/connect_group` is denied.** The Telegram sender is not a NanoClaw owner or global admin. The command never grants privileges; inspect them with `ncl roles list` and grant the intended role explicitly if appropriate.

**The group was chosen but no approval card arrived.** Confirm the service is running and post `/start@{{bot_username}} connect` in the group. The card is delivered to an eligible owner/admin DM, not to the group.

**Everything green but no replies.** Run `pnpm exec vitest run src/channels/telegram-registration.test.ts` — red means the barrel import or the `@chat-adapter/telegram` install drifted, so re-run the Apply steps. If green, restart again (`bash setup/lib/restart.sh`) and check `logs/nanoclaw.error.log` for token errors.
