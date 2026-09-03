---
name: slack-a2a-rooms
description: Agent-to-agent Slack rooms — a group DM (MPIM) holding a human plus two or more NanoClaw sibling bots, where each bot hears the room over its own Socket Mode connection. Registers the admission policy on the Slack channel's bot-inbound guard so bot-authored inbound is admitted only for rooms allowlisted in SLACK_A2A_ROOMS (re-attributed as slack:bot:<bot_id>, hop-limited via SLACK_A2A_MAX_HOPS), plus scripts/open-a2a-room.ts to open a room and register it.
---

# Slack agent-to-agent rooms (SLACK_A2A_ROOMS)

Lets two or more NanoClaw Slack bots talk to each other — and to a human — in
a shared group DM (MPIM). Empirically established against live Slack:
`conversations.open` with `users=[<human>, <other bot user id>…]` works from a
bot token holding `mpim:write` and returns an `is_mpim` channel, and bots
receive each other's messages over their own Socket Mode connections as plain
`message` events with `channel_type: "mpim"`, `bot_id` set, and `subtype`
null.

**Canonical home.** This directory on `main` is the skill's canonical source —
the setup wizard and any direct apply read it from the checkout. The copy on
the `channels` branch is a compatibility mirror for older checkouts whose
setup fetches companions from there; edits land here, never there.

**Where sibling-bot messages die today.** The adapter/Chat-SDK stack's only
bot filter is self-protection (`isMe`); a sibling bot's message arrives with
`isMe: false`, `isBot: true` and flows into the Slack channel's bot-inbound
guard (`src/channels/slack-a2a-guard.ts`, installed with `/add-slack`), which
drops all bot-authored inbound at the bridge boundary by default — before the
router, before any sender-approval flow. The guard exposes a single admission
seam, `setBotInboundPolicy`; this skill registers the policy that opens it up
selectively:

- Rooms listed in `SLACK_A2A_ROOMS`: bot-authored inbound passes, attributed
  to the user id `slack:bot:<bot_id>`, under a consecutive-hop limit.
- Everywhere else: bot-authored inbound stays dropped at the bridge, exactly
  as the guard's default already does.

**Loop safety.** After N consecutive bot-authored inbound messages in an A2A
room without a human message (N = `SLACK_A2A_MAX_HOPS`, default 6), further
bot messages are dropped with a log line until a human speaks. The counter is
per bot identity and per room; any human message resets it.

**Requires:**

- The Slack channel installed (`/add-slack`), current enough to ship the
  bot-inbound guard (`src/channels/slack-a2a-guard.ts` with the
  `setBotInboundPolicy` seam). The default drop arrives with that payload;
  this skill only adds the allowlisted-room admission on top.
- At least two Slack bot identities on this host (or sibling bots on other
  hosts sharing the workspace). Named identities are registered natively by
  the adapter from `SLACK_INSTANCES` — see the `slack-multi-instance` skill
  for the env-key format. `scripts/open-a2a-room.ts` reads tokens by that
  convention (`SLACK_BOT_TOKEN_<NAME>`; `default` → `SLACK_BOT_TOKEN`).
- Every participating app's manifest must carry the MPIM scopes and event:
  `mpim:write` (open the room), `mpim:history` + `mpim:read` (see it), and
  the `message.mpim` bot event (hear it). Apps provisioned through the
  managed flow (`apps.manifest.create` + `apps.managedInstall`) already
  include all of these.

## Apply

### 1. Verify the installed Slack channel ships the bot-inbound guard

The policy module copied next imports `setBotInboundPolicy` from the installed
`src/channels/slack-a2a-guard.ts`. On a Slack payload that predates the guard,
that import takes down the channel barrel — and with it **every** adapter — so
verify the seam first. If the check fails, **stop**: re-run `/add-slack` from a
channels branch that ships the guard, then re-apply this skill.

```nc:run effect:check
grep -sq 'export function setBotInboundPolicy' src/channels/slack-a2a-guard.ts || { echo 'slack-a2a-rooms: src/channels/slack-a2a-guard.ts is missing or does not export setBotInboundPolicy. Installing anyway would break the channel barrel and take down every channel adapter. Update the installed Slack channel first (re-run /add-slack from a channels branch that ships the bot-inbound guard), then re-apply this skill.' >&2; exit 1; }
```

### 2. Copy the policy module, its guard test, and the room-opener script

This skill ships three files alongside this document; copy them into the tree
at the same relative paths (overwrite; the skill's copies are canonical):

```nc:copy
src/channels/slack-a2a.ts
src/channels/slack-a2a.test.ts
scripts/open-a2a-room.ts
```

- `slack-a2a.ts` — the admission policy: `SLACK_A2A_ROOMS` /
  `SLACK_A2A_MAX_HOPS` parsing (re-read with a ~30s cache so a freshly opened
  room needs no restart), the per-room, per-identity consecutive-hop counter
  with human reset, and the `slack:bot:<bot_id>` re-attribution. The module
  registers itself onto the guard's admission seam on import.
- `slack-a2a.test.ts` — the guard: drives the real channel barrel and the
  real bot-inbound guard end-to-end (see step 4 for what it pins).
- `open-a2a-room.ts` — operator CLI to open a room (see Configuration).

### 3. Register the policy module

Append the self-registration import to the channel barrel (skipped if the
line is already present). Appending at the end keeps it after the Slack
channel's own imports:

```nc:append to:src/channels/index.ts
import './slack-a2a.js';
```

### 4. Build and validate

Build first — it guards the typed `setBotInboundPolicy` call against guard
drift. The test imports the real channel barrel (a deleted or broken barrel
line goes red) and asserts the policy end-to-end: allowlisted-room admission
with `slack:bot:<bot_id>` re-attribution, non-listed-room drop, the hop limit
with human reset, per-room/per-identity budgets, and that a downstream throw
consumes no hop budget:

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/slack-a2a.test.ts
```

## Configuration

`.env` keys (both re-read with a ~30s cache — no restart needed after edits):

- `SLACK_A2A_ROOMS` — comma-separated raw Slack channel ids (the MPIM ids the
  opener script prints, e.g. `G0AAAAAAA` — note MPIM ids may start with `G`
  or `C` depending on workspace vintage). Only these rooms admit bot-authored
  inbound.
- `SLACK_A2A_MAX_HOPS` — consecutive bot-authored inbound messages allowed in
  an A2A room without a human message before further bot messages are dropped.
  Default `6`.

### Opening a room

```bash
pnpm exec tsx scripts/open-a2a-room.ts --instances dana,eli --user U0AAAAAAA
```

The first listed instance opens the conversation (via `conversations.open`
with the human + the other bots' user ids, resolved through `auth.test` per
token) and posts an intro message. The script prints the channel id and
appends it to `SLACK_A2A_ROOMS` in `.env`. Without `--user` you get a
bots-only room, which needs at least three instances (Slack collapses a
two-party open into a 1:1 IM).

### Letting bot senders through the access gate

The room allowlist gets bot messages *to* the router; the permissions module
still gates them like any sender. Bot senders arrive as user id
`slack:bot:<bot_id>`, which starts unknown. After the first human mention in
the room auto-creates its messaging group, either set the room public:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE messaging_groups SET unknown_sender_policy='public' WHERE platform_id='slack:<channel id>'"
```

or keep `request_approval` and approve each `slack:bot:<bot_id>` sender once
(or add them as members of the agent group). A private A2A room with known
humans is a reasonable place for `public`.

## Engagement: A2A conversation is mention-driven

An MPIM is a *group* context in NanoClaw's channel-defaults model (Slack DMs
are only `D…` channels), so the Slack group defaults apply:
`engage_mode: mention-sticky`, per-thread stickiness. That means a bot
replies when it is @-mentioned (then stays engaged in that thread) — it does
not answer every room message. Bot-to-bot conversation is therefore
**mention-driven by design**: bot A's reply reaches bot B's agent when it
@-mentions bot B, and the chain continues only as long as each reply
mentions the next speaker. Slack does not emit `app_mention` for
bot-authored messages, but mention detection still works: the Chat SDK's
text-level detector matches the bot's own `<@U…>` token, which the adapter
deliberately leaves unresolved in the text. This is the intended loop
governor alongside the hop limit — prompt the agents (group CLAUDE.md /
personality) to @-mention the sibling they want an answer from, and to stop
mentioning anyone when the exchange has converged.

## Remove

1. Delete the three copied files: `src/channels/slack-a2a.ts`,
   `src/channels/slack-a2a.test.ts`, `scripts/open-a2a-room.ts`.
2. Delete the `import './slack-a2a.js';` line from `src/channels/index.ts`.
3. Remove `SLACK_A2A_ROOMS` and `SLACK_A2A_MAX_HOPS` from `.env`.
4. Optionally re-tighten any messaging groups you set to
   `unknown_sender_policy='public'`, and archive/leave the MPIMs from Slack
   (the rooms themselves are ordinary Slack conversations; NanoClaw holds no
   other state for them beyond the usual messaging-group/session rows).
5. Rebuild (`pnpm run build`).

With the skill removed, the channel guard's default applies everywhere again:
bot-authored inbound is dropped in every room.

## Notes

- **Bot senders outside A2A rooms**: the Slack channel's bot-inbound guard
  drops bot-authored messages in rooms not listed in `SLACK_A2A_ROOMS` at the
  bridge — before the router and before any sender-approval flow — with or
  without this skill applied. If an install relies on a bot sender (another
  workspace app posting into a channel the agent watches), add that room to
  `SLACK_A2A_ROOMS`. Human messages are never affected.
- **Access-gate story is manual.** The recipe deliberately leaves letting
  `slack:bot:<bot_id>` senders through the gate as an operator step (public
  policy or per-bot approval). Should `open-a2a-room.ts` instead pre-create
  the messaging group + wirings + members via `ncl` so a room works with zero
  extra steps? That needs the host running and a choice of agent group per
  bot — deferred.
- **Hop-counter scope.** The counter counts bot-authored *inbound* per bot
  identity (bridge instance). A bot's own outbound is invisible to it (`isMe`
  dropped upstream), so with two bots the effective conversation length is
  roughly `2×maxHops` messages; with k bots each message increments k−1
  counters. If per-room total (not per-identity) semantics are wanted, the
  counter needs to live host-side (router/session), not in the channel layer.
- **Cross-host rooms.** For sibling bots on *different* NanoClaw hosts, each
  host needs this skill (its own allowlist entry). The opener script only
  handles co-hosted tokens; opening a cross-host room means running it where
  the first bot's token lives and adding the room id to the other host's
  `.env` manually.
- **`message_changed` / edited bot messages** are not admitted (the adapter
  only forwards unfurl data for edits) — fine for v1.
- **Attribution name.** The `users` row for `slack:bot:<bot_id>` takes
  whatever display name the bridge serialized (often `unknown` for bot
  events, since `event.username` is frequently absent and `event.user` is
  unset). A nicety would be resolving the bot's profile name via
  `bots.info` — deferred.
- **MPIM id prefix.** Older workspaces mint MPIM ids starting with `G`,
  newer ones with `C`. The allowlist matches exact ids so both work, but the
  adapter's `getChannelVisibility` calls `C…` ids "workspace"-visible —
  cosmetic only, nothing here branches on it.
