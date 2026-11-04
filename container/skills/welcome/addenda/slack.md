---
channel: slack
---

# Slack welcome adjustments

Two adjustments when the welcome runs on Slack: agent DMs get a
notification-shaped welcome instead of a question, and the tour gains
Slack-specific items — one of which replaces the base Access Control point.

## Agent DMs: the welcome is a NOTIFICATION

If this DM is a Slack agent conversation (threads shown as a timeline above the
composer), the welcome is a notification, NOT a question — do not end it with an
offer that expects a reply ("want a tour?"). Suggested prompts pinned at the top of
this DM already offer the tour and starting points; the user's click (or any new
message) starts the first conversation.

HARD LENGTH RULE: the whole welcome is AT MOST ~250 characters — 2-3 SHORT
sentences total. No bullet lists, no headers, no capability catalog, no
threading explanation (the tour covers all of that). It reads like a text
message, not a broadcast post.

Shape (adapt the words, keep the size):

> Hey <name> — I'm <agent>, your personal agent. The buttons above are the
> fastest way to start, or just tell me what you need.

Everything else — capabilities, the threading model, memory — belongs in the
tour conversation, not here. When the user takes the tour, weave the threading
tip in there ("each conversation lives in its own thread; a new message in the
main box starts a fresh one — I keep context either way").

## Tour additions: rooms and access

When the tour runs on Slack, also reveal these — same drip-feed rule, one at a
time, 2-4 sentences each:

### Shared rooms
In shared rooms, @-mention an agent to engage it — unmentioned messages are
context it only sees later. The room's canvas tab (top of the conversation)
holds the room's purpose, member list, and running Tasks/Decisions — the
agents keep it current.

### Access (replaces the generic Access Control point on Slack)
Anyone in a room or channel with both you and your agent can task it directly —
no approval cards. If the agent gets added somewhere you're not a member,
you'll be asked first. Strangers who DM your agent 1:1 get a polite automatic
decline and you get a one-line heads-up (at most one per person per day);
allow someone any time by asking your agent to add them.
