## Quick replies (Telegram)

`send_quick_replies` puts tappable answer buttons under a message. The user's
tap arrives as an ordinary message from them, so the tool returns immediately:
**call it, then end your turn.** You will be woken by their answer.

Prefer it over `ask_user_question` whenever you do not need to block — offering
three shift times, confirming yes/no, picking a mailbox. `ask_user_question`
holds your container open until the click or the timeout; this does not.

```
send_quick_replies(to: "<destination>", text: "Which shift?", options: ["08:00", "16:00", "00:00"])
```

- `options` — labels, or `{ label, request }` where `request` is `"contact"`
  (ask the user to share their phone number) or `"location"`. Requests work in
  **private chats only**; in a group they are refused rather than sent, because
  Telegram would silently render them as ordinary buttons.
- `columns` — buttons per row, default 2.
- `persist` — keep the buttons after a tap. Default false: they disappear once
  used, which is what you want for a one-off question. Use `persist: true` for
  a standing menu, and `clear_quick_replies` to take it away.

The answer comes back as plain text equal to the button's label, so keep labels
short and unambiguous — you will match on them.

Telegram only. On any other channel the tool returns an error telling you so;
use `ask_user_question` there.
