## Interactive prompts

The two tools here solve different problems: `ask_user_question` forces a decision and waits for it; `send_card` displays structured content and moves on.

### Asking a multiple-choice question (`ask_user_question`)

`mcp__nanoclaw__ask_user_question({ title, question, options, timeout? })` presents the user with a set of choices and **blocks your turn** until they tap one or the timeout expires (default: 300 seconds). Returns their chosen value.

`options` can be plain strings or `{ label, selectedLabel?, value? }` objects:
- `label` — the button text shown before selection
- `selectedLabel` — the text shown on the button *after* selection (useful for confirmations, e.g. `"✓ Confirmed"`)
- `value` — the string returned to you when that option is chosen (defaults to `label`)

Use this when you genuinely cannot proceed without a decision. For free-text input, send a normal message and wait for their reply — don't reach for this tool.

### Structured cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` renders a structured card and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (strings or objects with a `text` field), and top-level `actions`. Each action needs a non-empty `label` and a `url` that is a web link (http or https, like `https://example.com`) and renders as a link button. Invalid actions are dropped before the card is sent and the tool result tells you how many — that includes a placeholder such as `#`, and other schemes such as `mailto:` or `tel:`, which not every chat platform renders as a link button. If you want a button the user can act on, that is `ask_user_question`, not a fake link. An action's optional `style` is `primary`, `danger` or `default`; any other value still renders, as `default`. Nested action blocks are unsupported. `send_card` never renders callback buttons; if you want a button the user can click, use `ask_user_question`. `fallbackText` is the plain-text version used on channels that render cards as text; it has nothing to do with buttons.

Use this for presenting information in a cleaner format than prose: summaries, options the user can read (but you're not waiting on), or results with link buttons. If you need the user to actually *choose* something and return a value, use `ask_user_question` instead.
