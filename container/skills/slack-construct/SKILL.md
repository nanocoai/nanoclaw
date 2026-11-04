---
name: slack-construct
description: Standing context for Slack rooms — mention-driven engagement, room canvases, owner-presence access, and DM history. Ships as instructions.md composed into the group's CLAUDE.md at spawn; there is no workflow to invoke.
---

# Slack construct — standing context

A carrier for standing context, not an on-demand workflow. The payload is
`instructions.md` in this directory: the Slack room, canvas, access, and
DM-history rules an agent needs the moment it wakes in a Slack conversation.
The host composes every container skill's `instructions.md` into each group's
CLAUDE.md at spawn (`src/claude-md-compose.ts`), so from inside a session
those rules are already standing instructions — nothing to load or run here.

Two scope notes for maintainers:

- Skill fragments compose into **every** group, regardless of the group's
  `cli_scope`. The content therefore never names host-CLI (`ncl`) commands —
  groups with CLI access get that guidance from the CLI module's own
  instructions fragment, which the host includes only where `ncl` is enabled.
- Detailed canvas *editing* discipline lives in the `canvas-work` skill; the
  fragment here only carries the always-on rules (read-before-edit, section
  ops, comment behavior) at summary level.
