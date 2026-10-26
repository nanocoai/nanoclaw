---
name: add-b2b-peer
description: Wire another Telegram bot as a sanctioned peer for a NanoClaw agent — BotFather B2B mode, the TELEGRAM_BOT_INBOUND admission allowlist, and peer registration. Use when the user wants their NanoClaw agent to talk to another bot they control.
---

# Add a bot-to-bot peer

Walk the operator through admitting one other Telegram bot (their own, on
another install or harness) into a NanoClaw agent's group, so the two agents
can talk under the bot-to-bot admission gate. Requires the admission policy
from #4111 (present in releases after that PR lands).

## What you need from the operator

Use AskUserQuestion to collect:

1. **The group** the two bots share (or will share). Ask for the chat id
   (`-100…`) and, if the group is a forum, the topic id to scope traffic to.
2. **The agent group** to register the peer on (`ncl groups list` if unsure).

Do not proceed without both.

## Step 1 — Telegram side (operator does this in their Telegram client)

Ask the operator to:

1. Open BotFather for **their** bot and enable Bot-to-Bot Communication Mode.
   The peer bot's operator does the same for the peer bot.
2. Add both bots to the group. For a forum group, create (or pick) the topic
   the bots will talk in.

Bots cannot see each other's messages until this toggle is on for both.

## Step 2 — Allowlist the channel

Ask for the chat id (and topic id if scoping). Then:

1. Add the entry to `TELEGRAM_BOT_INBOUND` in `.env`:
   - Whole group: `TELEGRAM_BOT_INBOUND="-1001234567"`
   - One forum topic: `TELEGRAM_BOT_INBOUND="-1001234567:42"`
   - More channels/peers later: comma-separate entries.
2. Restart the host service (`systemctl --user restart nanoclaw`).

Rollback at any time: remove the entry and restart. The policy is a no-op
when the variable is absent.

## Step 3 — Discover the peer's bot id

The peer's numeric user id is required for membership. Get it one of two ways:

- **From the peer side (preferred):** the numeric prefix of the peer bot's
  token (the part before `:`) — its operator can print just that prefix.
- **From a blocked ping:** have the peer send one message in the allowed
  channel. It will be dropped (unregistered senders are denied), and the
  sender id appears in `ncl dropped-messages list`.

## Step 4 — Register the peer

```bash
ncl members add --user telegram:<peerBotId> --group <agentGroupId>
```

Unregistered peers in an allowed channel are dropped at the sender gate, so
this step is what turns admission on for the peer.

## Step 5 — Validate

1. **Negative leg:** the peer sends one plain (non-addressed) message in the
   allowed channel. Expect a `Telegram bot inbound dropped …
   reason=not_addressed` line in the host log and no agent reply.
2. **Positive leg:** the peer sends `/ping@<botusername>` as the whole message,
   or replies to the agent's last message. Expect the agent to reply once.
3. Confirm the protocol on both sides ends human-addressed (the peer does not
   answer the agent's reply).

## Troubleshooting

- **`reason=wrong_chat` in the log** — the chat id in `TELEGRAM_BOT_INBOUND`
  does not match the message's chat. Copy the id from the log line.
- **`reason=wrong_topic`** — a scoped entry does not match the message's
  topic. Use the bare `chatId` form to allow every topic in the group.
- **`reason=not_addressed` but the message starts with the command** — check
  for invisible characters or a leading byline; addressing must open the text.
- **No log line at all** — BotFather B2B is off on one side, or the entry is
  missing from `.env`. Verify the variable is set and the host was restarted.
- **Agent replies to everything the peer sends** — expected before the fix in
  #4111; update the install.
