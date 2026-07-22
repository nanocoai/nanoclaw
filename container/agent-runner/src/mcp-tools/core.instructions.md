## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename?, replyTo? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Replying to a specific request (`replyTo`)

Both `send_message` and `send_file` accept an optional `replyTo`: the numeric `id` shown on a `<message id="N">` you're responding to. If you have exactly one pending request this turn, you can omit it. **If you have more than one pending request in the same turn — especially from an agent peer that itself has multiple concurrent sessions (e.g. a human chat and a scheduled task both messaging you) — always pass `replyTo` on each reply**, set to the id of the specific inbound message that reply answers. Without it, every reply in the turn defaults to answering the *first* pending message, which silently misroutes replies meant for the others (they land with the wrong sender/session on the other end, not with you).

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
