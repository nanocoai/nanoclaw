---
name: slack-construct-agents
description: Standing context for Slack sibling agents — one room per team, creator-posted introductions, bot-to-bot hop discipline. Ships as instructions.md composed into the group's CLAUDE.md at spawn; there is no workflow to invoke.
---

# Slack construct — sibling agents

This skill is a carrier for standing context, not an on-demand workflow. Its
payload is `instructions.md` in this directory: the rules an agent needs when
it shares Slack with sibling agents it can create (`create_agent`) and room
with (`create_room` / `add_to_room`) — team-room shape, who posts the
introduction, and the bot-to-bot self-limit.

The host composes every container skill's `instructions.md` into each group's
CLAUDE.md at spawn (`src/project-doc-compose.ts`), so if you are reading this
from inside a session, those rules are already part of your standing
instructions. There is nothing further to load or run here.

The room-and-canvas half of the Slack standing context (mention engagement,
canvas discipline, access rules) ships separately with the Slack channel
payload as the `slack-construct` skill; this fragment layers the
sibling-agent rules on top and arrives with the slack-agent-flow skill.
