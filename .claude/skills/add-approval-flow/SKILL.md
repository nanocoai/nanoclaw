---
name: add-approval-flow
description: Add conversational approval flow to a group so the agent asks before destructive actions. The user defines which actions need approval. Works over any messaging channel.
---

# Add Approval Flow

Adds a conversational approval gate to a group's CLAUDE.md. The agent asks for permission via `send_message` before taking certain actions, waits for the user's reply via IPC, then proceeds or stops.

This is useful for remote agents accessed via messaging channels (Telegram, WhatsApp, Slack, Discord) where the SDK's built-in interactive permission system cannot work (no TTY in containers).

## Phase 1: Identify target group

Check which groups are registered:

```bash
sqlite3 /workspace/project/store/messages.db "SELECT folder, name FROM registered_groups;"
```

If only one group exists, use that. Otherwise, ask which group should have the approval flow.

## Phase 2: Configure actions

Use AskUserQuestion to ask: "Which actions should require your approval before the agent proceeds? Describe them in your own words (e.g., 'creating PRs', 'sending emails', 'modifying infrastructure', 'anything that writes to external systems')."

Convert the user's response into a clear bullet list for the CLAUDE.md section.

If the user isn't sure, suggest: "A good default is any action that creates, modifies, or deletes something outside the container — like creating PRs, sending messages to external services, or modifying shared resources."

## Phase 3: Add to CLAUDE.md

Read the target group's `CLAUDE.md` and add the approval flow section. Insert it before the `## Admin Context` section if one exists, otherwise append at the end.

Use the actions from Phase 2 to build the bullet list:

```markdown
## Approval Required Actions

Before taking any of these actions, you MUST ask for approval via
`mcp__nanoclaw__send_message` and wait for the user's reply:

- [User-defined actions as bullet points]

Ask clearly what you intend to do and wait. Do NOT proceed until the user
replies with approval. If the user says no or asks for changes, adjust
accordingly.

For read-only actions (listing, searching, analyzing, reading code) — no
approval needed.

*Autonomous mode:* If the user says something like "go ahead without asking",
"you have permission for the next N minutes", or "do whatever you need" — you
may skip approval for the remainder of that session or the stated duration.
Acknowledge when autonomous mode is active and when it expires. Default back
to asking for approval in the next session.
```

## Phase 4: Verify

Tell the user:

> Approval flow added. The agent will now ask before taking the listed actions and wait for your reply. You can temporarily bypass this by telling the agent "go ahead without asking" — it will revert to asking in the next session.
>
> To test: ask the agent to do something on the list and verify it asks for permission first.
