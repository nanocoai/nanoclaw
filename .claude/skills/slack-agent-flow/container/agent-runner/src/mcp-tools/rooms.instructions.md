## Shared rooms (`create_room`, `add_to_room`, `handoff`)

A room is one Slack group conversation shared by the user and N agents, with a canvas tab carrying the room contract (purpose, members). `mcp__nanoclaw__create_room({ name, purpose, agents, include_me? })` opens one; `mcp__nanoclaw__add_to_room({ room, agent })` grows one; `mcp__nanoclaw__handoff({ to, text, room? })` reliably engages exactly the named sibling agent or agents.

### The team pattern — one room, not N

When the user asks for a TEAM (several agents for one project), never let each `create_agent` open its own room — that yields N separate three-way rooms nobody wants:

1. Create each agent with `room: 'none'` (they still get their operator DM).
2. When all are live, call `create_room` ONCE with all their names and a short public `purpose`.

For a SINGLE new agent, plain `create_agent` (default `room: 'own'`) is right — don't follow up with `create_room`.

### How it works

- `agents` takes the same names you use with `send_message` — agents you created or can already message. Unknown names come back as an error note, nothing half-created.
- Room creation and membership changes are fire-and-forget and may require admin approval; the outcome arrives as a system note. Creating a room never chooses responders or wakes everyone automatically.
- In rooms, agents engage when @-mentioned; everything else accumulates as ambient context. Never place raw Slack mention markup in `handoff.text`.

### Choose by where the response belongs

- **Visible on the current shared surface:** when the user asks room members to reply, speak, answer, or work in the current Slack channel, group DM, or canvas-comment thread, use `handoff` even if they only say “ask.” Omit `room` so the current thread is preserved.
- **Visible in a named room:** from a DM or another session, use `handoff({ room, ... })` only when the user wants the response posted in that shared room.
- **Private or cross-surface:** use `send_message` to the agent destination for an ordinary request from a DM, explicitly private coordination, or an agent outside the shared surface. Relay the result without implying the agent replied publicly.
- **Not a member, but must reply here:** do not silently substitute private A2A. Add or invite the agent first, then hand off. `add_to_room` grows a NanoClaw group DM; a regular Slack channel requires the bot to be invited and wired there.

The host is the authority on membership. If `handoff` reports that a target is not wired to the surface, use private A2A only when a relayed answer satisfies the request; otherwise explain that the agent must be added. “Canvas” here means its comment thread—the canvas body is edited with canvas tools, not used as a message destination.

### Growing a room

`add_to_room` works, but Slack group conversations never grow in place — the room MOVES to a new conversation (everyone re-wired automatically; the old conversation keeps working). Prefer creating rooms complete: if you know the team needs four agents, create all four first, then one `create_room`.
