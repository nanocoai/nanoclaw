## WhatsApp mentions — always use phone digits

When you are replying in a WhatsApp conversation (the inbound message's `chatJid` ends with `@s.whatsapp.net` for a DM or `@g.us` for a group), and you want to tag a person so their name appears **bold and clickable** with a push notification, write `@` followed by their phone-number digits — never the display name.

**The sender's phone JID is in your inbound message metadata** at `content.sender` (e.g. `15551234567@s.whatsapp.net`). The part before the `@` is exactly what you put after `@` when tagging them.

| You write | What recipients see |
|-----------|---------------------|
| `@Adam, can you...` | Plain text. No tag, no notification. |
| `@15551234567, can you...` | Bold/blue **@Adam** (whatever name they're saved as), notification fires. |
| `@+15551234567 ...` | Same as above — the adapter strips the `+` automatically. |

The host adapter scans your outbound text for `@<5–15 digits>` (with optional leading `+`) and tells WhatsApp to render those as real mention tags. If the digits aren't in the text, the tag doesn't render — no exceptions.

### In groups

Tag the person you're addressing using their JID from inbound metadata (look at the most recent message from them). Don't guess — pushNames collide and aren't reliable.

If you don't know someone's JID, refer to them by name in plain prose. Do not write `@<displayname>` hoping it works.
