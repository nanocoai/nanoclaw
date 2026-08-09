---
name: whatsapp-formatting
description: Format messages for WhatsApp, including mentions that render as real WhatsApp tags. Use when responding in a WhatsApp conversation (platform_id / chatJid ends with @s.whatsapp.net or @g.us).
---

# WhatsApp Message Formatting

WhatsApp uses its own lightweight markup and a phone-number-based mention syntax. The host's WhatsApp adapter (Baileys) handles markdown conversion automatically, but **mentions are only protocol-level mentions if you use the right syntax** — otherwise they render as plain text and don't notify the recipient.

## How to detect WhatsApp context

You're in a WhatsApp conversation when any of these are true:
- The chat JID / platform id ends with `@s.whatsapp.net` (1-on-1 DM)
- The chat JID / platform id ends with `@g.us` (group)
- Your inbound message metadata has `chatJid` matching the above

## Mentions — the important part

To tag a user so their name appears **bold and clickable** in WhatsApp and they get a push notification, write the `@` followed by their phone number digits (no `+`, no spaces, no display name):

```
@15551234567 can you confirm?
```

The adapter scans your outgoing text for `@<digits>` (5–15 digits, optional leading `+` is stripped) and tells WhatsApp to render them as real mention tags.

**The sender's phone JID is always in your inbound message metadata.** When a user writes to you, inbound `content.sender` looks like `15551234567@s.whatsapp.net`. The part before the `@` is exactly what you put after `@` when tagging them back.

### Wrong vs right

| You write | What recipients see |
|-----------|---------------------|
| `@Adam can you...` | Plain text `@Adam`. No tag, no notification. |
| `@15551234567 can you...` | Bold/blue **@Adam** (or whatever name they're saved as), notification fires. |
| `@+15551234567 ...` | Same as above — adapter strips the `+`. |

### Picking who to tag

- In a DM, there's no real need to tag the recipient (they already see every message), but tagging still works if you want emphasis.
- In a group, look at the `participants` / inbound `content.sender` to find the JID of the person you mean. Don't guess from display names — pushNames can collide and are not reliable.
- If you don't know the JID, just refer to the person by name in plain prose. Don't write `@<name>` — it won't tag and it will look like a tag that failed.

## Text styles

WhatsApp uses single-character delimiters, *not* doubled like standard Markdown.

| Style | Syntax | Renders as |
|-------|--------|------------|
| Bold | `*bold*` | **bold** |
| Italic | `_italic_` | *italic* |
| Strikethrough | `~strike~` | ~strike~ |
| Monospace | `` `code` `` | `code` |
| Block monospace | ```` ```block``` ```` | preformatted block |

The adapter converts standard Markdown (`**bold**`, `[link](url)`, `# heading`) to the WhatsApp-native form automatically, so you don't have to think about it — but be aware that single asterisks become italics, not bold.

## What not to do

- Don't write `<@U123>` (that's Slack), `<@!123>` (Discord), or any other channel's mention syntax.
- Don't paste a full JID like `@15551234567@s.whatsapp.net` in the text — only the digits before the JID's `@` go after your `@`.
- Don't try to tag display names. WhatsApp has no display-name-based mention API.
