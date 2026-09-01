## Shared rooms (`create_room`, `add_to_room`)

A room is one Slack group conversation shared by the user and N agents, with a canvas tab carrying the room contract (purpose, members). `mcp__nanoclaw__create_room({ name, purpose, agents, include_me? })` opens one; `mcp__nanoclaw__add_to_room({ room, agent })` grows one.


### How it works

- `agents` takes the same names you use with `send_message` — agents you created or can already message. Unknown names come back as an error note, nothing half-created.
- Both tools are fire-and-forget and may require admin approval; the outcome arrives as a system note. When the room is live, the note tells you the destination to post to and whom to tag — post a brief intro in your own voice (1-2 lines, no mechanics, no member lists).
- In rooms, agents engage when @-mentioned; everything else accumulates as ambient context. Tag an agent to bring it in.

### Growing a room

`add_to_room` works, but Slack group conversations never grow in place — the room MOVES to a new conversation (everyone re-wired automatically; the old conversation keeps working). Prefer creating rooms complete: if you know the team needs four agents, create all four first, then one `create_room`.
