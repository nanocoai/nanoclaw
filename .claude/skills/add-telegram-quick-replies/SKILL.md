---
name: add-telegram-quick-replies
description: Add Telegram quick replies — tappable answer buttons the user hits instead of typing, non-blocking, including contact and location requests.
---

# Add Telegram Quick Replies

Gives agents two MCP tools on Telegram:

- `send_quick_replies` — send a message with tappable answer buttons.
- `clear_quick_replies` — take a persistent set of buttons away.

## Why

NanoClaw can already put buttons on a card through `ask_user_question`, but
that path is inline-keyboard only and **blocking**: the container stays open
polling `messages_in` until the user clicks or the timeout expires. For "which
of these three shifts?" that is an expensive way to ask a cheap question.

A Telegram *reply* keyboard is the other half of the platform's button model,
and NanoClaw has no way to reach it today. Tapping one sends the button's label
as an ordinary text message, so the answer arrives through the normal inbound
path — no `callback_data`, no 64-byte cap, no card to update, and nothing to
wait on. The agent offers the options, ends its turn, and is woken by the reply
like any other message.

It is also the only way to ask Telegram for a **contact** or a **location**;
inline keyboards cannot request either.

## Requirements

The Telegram channel (`/add-telegram`). The tools refuse any other channel with
a message telling the agent to use `ask_user_question` there.

The bot token is read from the same env key the channel uses —
`TELEGRAM_BOT_TOKEN`, or `TELEGRAM_BOT_TOKEN_<SUFFIX>` for a named instance —
so a multi-instance install needs no extra configuration.

## Apply

### 1. Copy the skill's source and tests into both trees

The host builds the keyboard and calls the Bot API; the container ships the
tools that write the request. Files go into both trees, beside the integration
points they cover.

```nc:copy
keyboard.ts -> src/modules/telegram-keyboards/keyboard.ts
index.ts -> src/modules/telegram-keyboards/index.ts
index.test.ts -> src/modules/telegram-keyboards/index.test.ts
telegram-keyboard.ts -> container/agent-runner/src/mcp-tools/telegram-keyboard.ts
telegram-keyboard.test.ts -> container/agent-runner/src/mcp-tools/telegram-keyboard.test.ts
telegram-keyboard.instructions.md -> container/agent-runner/src/mcp-tools/telegram-keyboard.instructions.md
```

`telegram-keyboard.instructions.md` needs no registration: the project-doc
composer globs `<name>.instructions.md` beside each tool module.

### 2. Register the host module

```nc:append to:src/modules/index.ts
import './telegram-keyboards/index.js';
```

### 3. Register the container tools

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './telegram-keyboard.js';
```

Those two lines are the skill's entire reach-in into core. Each is guarded by a
test that reads the barrel and fails if the line is gone.

## Verify

```bash
pnpm vitest run src/modules/telegram-keyboards/index.test.ts
cd container/agent-runner && bun test src/mcp-tools/telegram-keyboard.test.ts
```

Then, from a Telegram chat the agent is wired to, ask it to offer you a choice.
Buttons appear above your keyboard; tapping one sends its label as a message.

## Notes

- **Groups show the keyboard to everyone.** The module sets Telegram's
  `selective` flag so it targets the users the message replies to or mentions,
  which is the closest Telegram gets to a per-user prompt in a group.
- **A tap is just text.** Anyone in the chat can type a button's label by hand;
  treat an answer as a message from that user, not as proof they tapped.
  Anything needing authorization belongs in an approval card, not here.
- **Contact and location requests are refused in groups** rather than sent.
  Telegram ignores them outside private chats, so the button would silently
  degrade into one that sends its own label — and the agent would wait for a
  phone number that can never arrive.
- The host re-checks that the session's agent is wired to the target group.
  The container can only name destinations the host gave it, but this row
  reaches the Bot API around the delivery path's own destination handling, so
  the wiring is verified rather than assumed.
