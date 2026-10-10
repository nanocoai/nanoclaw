---
name: telegram-multi-instance
description: Run N Telegram bots on one NanoClaw host via TELEGRAM_INSTANCES. Each name gets its own telegram-<name> adapter instance built from a per-instance bot token, with instance-bound pairing and its own messaging-group rows, sharing channelType, formatting, and wiring defaults with the default bot. Documentation only, the registration is native to the installed Telegram adapter.
---

# Telegram multi-instance (TELEGRAM_INSTANCES)

One NanoClaw host can run **several Telegram bots**, each wired to its own
agent. There is nothing to install: the Telegram adapter
(`src/channels/telegram.ts`, installed by `/add-telegram`) reads
`TELEGRAM_INSTANCES=<name>[,<name>...]` from `.env` at load and registers one
additional bridge per listed name under the `telegram-<name>` instance key,
built from that name's own bot token through the same factory as the default
bot. `channelType` stays `telegram`: instance is a routing key; user ids
(`telegram:<user id>`), formatting, container config, and the wiring-defaults
declaration are shared with the default bot. This document records the
conventions.

## Configuration

Create each extra bot with @BotFather (`/newbot`, exactly like the first bot;
turn Group Privacy off if it will sit in groups) and store its token under the
suffixed key. `<NAME>` is the name uppercased with dashes as underscores
(`gh-bot` becomes `GH_BOT`). Names must match `^[a-z0-9][a-z0-9-]*$`; any
other entry is logged and skipped at boot.

```
TELEGRAM_BOT_TOKEN=123456:ABC...          # the first bot, unchanged: instance "telegram"
TELEGRAM_INSTANCES=mega,gh-bot
TELEGRAM_BOT_TOKEN_MEGA=234567:DEF...     # instance "telegram-mega"
TELEGRAM_BOT_TOKEN_GH_BOT=345678:GHI...   # instance "telegram-gh-bot"
```

Registration is unconditional for every listed name, so a missing token
surfaces as the registry's "credentials missing, skipping" warning at boot
rather than a silently absent bot. Telegram allows one `getUpdates` poller per
bot, so a name whose token equals one already in use (the default bot's, or
an earlier name's) is skipped with a warning and the first claimant keeps it.

## Pairing and wiring

The `--instance` flags below require a `setup/pair-telegram.ts` and
`scripts/init-first-agent.ts` that accept `--instance` (trunk after the
setup-instance change); on an install without them, use the `ncl` commands at
the end of this section.

Pairing is instance-bound: a code created for `telegram-mega` is consumed only
by that bot, and a wrong guess sent to one bot invalidates only that bot's
pending codes. Pass the instance key to the pairing step, send the code to the
new bot (the default bot does not pair on it: it forwards the message as
ordinary input and, like any wrong guess, cancels any pairing the default bot
itself had pending), then wire the exact row:

```bash
pnpm exec tsx setup/index.ts --step pair-telegram -- --intent new-agent:mega-analyst --instance telegram-mega
# the interceptor creates the (telegram, telegram:<chat>, telegram-mega) messaging group
pnpm exec tsx scripts/init-first-agent.ts --channel telegram --instance telegram-mega \
  --platform-id telegram:<chat> --user-id telegram:<uid> ...
```

Why re-pair instead of reusing the chat id you already know from the first
bot: a Telegram private chat id equals the user id across bots, but a bot
cannot message a user who never opened it. The pairing message is that first
contact, and it creates the instance-exact messaging group in the same step.

Manual equivalent with `ncl`: `ncl messaging-groups create --channel-type
telegram --platform-id telegram:<chat> --instance telegram-mega ...`, then
`ncl wirings create ... --instance telegram-mega`, and `ncl messaging-groups
send ... --instance telegram-mega` to say hello.

The same Telegram user can talk to every bot: one row, one session, one
container, one memory per bot. Delivery leaves through the instance that owns
the row; a named bot whose token is removed fails closed (delivery retry
path), never through a sibling bot.

## Restart

`TELEGRAM_INSTANCES` is read once, at adapter load. After editing `.env`,
restart the service (`bash setup/lib/restart.sh`) so the new bot registers and
starts polling. There is no hot start for Telegram instances.

## Validation

The channel payload ships the guards for all of this, installed by
`/add-telegram` alongside the adapter. They drive the registration loop
against a crafted `.env` (shared wiring defaults, env-key mapping, token
dedupe), the instance-bound pairing store, and the interceptor's exact-row
lookup against a real central DB:

```bash
pnpm exec vitest run src/channels/telegram-instances-registration.test.ts \
  src/channels/telegram-pairing.test.ts src/channels/telegram-pairing-interceptor.test.ts
```

## Remove

Remove the name from `TELEGRAM_INSTANCES` and delete its
`TELEGRAM_BOT_TOKEN_<NAME>` line, then restart the service. Messaging groups
wired to a removed `telegram-<name>` instance stop resolving an adapter until
rewired or deleted. The default bot and its rows are untouched. (Adapter code
is unchanged: the registration loop simply finds no names.)
