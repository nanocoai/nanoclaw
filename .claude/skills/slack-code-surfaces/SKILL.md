---
name: slack-code-surfaces
description: Coding-session surfaces in Slack — each sandbox on a host with a managed Slack app gets a channel that mirrors the session (status, the diff after each turn, messages both ways, Stop). Registers Slack's half on code mode's surface module and, on the Slack channel's bot-inbound guard, the admission policy for those channels (members from the service, the manager excluded, hop cap, routing header) and the filter for the manager's system notices.
---

# Slack coding-session surfaces

Gives every coding session (`ncl sandboxes new …`) a Slack channel of its own
on a host that is signed in and has a managed Slack app. Code mode's
session-surface core decides when a sandbox gets a surface, and the
community-portal module offers one over the service that manages the host's
app for any chat platform that registered its half; this skill is Slack's
half, plus the two things a shared Slack channel needs on the inbound side:

- **The platform half** (`src/channels/slack-code-surfaces.ts`): how the
  Slack adapter spells a channel id as a messaging-groups row (`slack:C…` on
  the adapter's instance, asked of the live adapter when it runs), and which
  bot user this host is on the workspace — one `auth.test` on the managed
  app's bot token, cached under `data/slack-bot-identity.json`
  (`src/channels/slack-bot-identity.ts`). A row the adapter auto-created for
  the channel before the binding ran is adopted by core.
- **Admission for surface channels**
  (`src/channels/slack-code-surfaces-policy.ts`): the guard installed with
  `/add-slack` drops every bot-authored message by default. On a channel that
  is a coding-session surface this host is on, this policy admits the bots
  the service lists as members (`GET /v1/code-channels/{id}` → `members[]`),
  re-attributed as `slack:bot:<bot user id>`, under a consecutive-hop cap
  (`SLACK_A2A_MAX_HOPS`, default 6, reset by any human message) and the
  `nanoclaw_agent` routing header when a post carries one (`hops` also bounds
  the cap; `addressed_to`, when present, must name this host's bot or one of
  its sandboxes). The manager app's bot is never admitted: its status, diff
  and system posts are the channel's furniture, not mail for the agent.
- **The notice filter** (same file): the manager's system lines ("added
  view …") arrive without a bot id, so the guard would pass them as human
  and they would be typed into the session as mail. In a surface channel, a
  message from a user the record knows as a bot (the manager, a member, this
  host's own) or from Slack's own user is dropped before it becomes mail.

For a channel this host knows as a surface the answer is final (admit or
deny), whatever else is on the guard's chain. Every other Slack channel is
untouched: bot posts there go to the next policy (the `/slack-a2a-rooms`
allowlist, when installed) or the guard's default drop; human messages pass
everywhere, as always.
Formatting in the channel uses the `slack-formatting` container skill that
`/add-slack` installs; nothing new is mounted into the container.

**Requires:**

- The Slack channel installed (`/add-slack`) from a channels branch whose
  bot-inbound guard carries the policy chain (`addBotInboundPolicy`, seam
  version 2). `/slack-a2a-rooms` is optional and composes: both policies sit
  on the chain, each answering for its own rooms.
- A NanoClaw trunk with code mode's session-surface core and the
  community-portal surface module (`registerSurfacePlatform`,
  `clientForRow`): a trunk version requirement, not something to patch in.
- A host signed in to the account service with a managed Slack app (the
  setup wizard's Slack path, signed in to the community portal). Without one the module
  offers no surface and sandboxes stay plain; the skill is inert.

## Apply

### 1. Verify the installed Slack channel ships the policy chain

The policy module copied below registers on the guard's chain. On a Slack
payload whose guard predates the chain (the single `setBotInboundPolicy`
slot only), that import takes down the channel barrel — and with it every
adapter — so verify the seam first. If the check fails, **stop**: re-run
`/add-slack` from a channels branch that ships the chain, then re-apply this
skill.

```nc:run effect:check
grep -sq 'export function addBotInboundPolicy' src/channels/slack-a2a-guard.ts && grep -sq 'export const BOT_INBOUND_POLICY_SEAM = 2' src/channels/slack-a2a-guard.ts || { echo 'slack-code-surfaces: src/channels/slack-a2a-guard.ts is missing or does not carry the policy chain (addBotInboundPolicy, seam 2). Installing anyway would break the channel barrel and take down every channel adapter. Update the installed Slack channel first (re-run /add-slack from a channels branch that ships the chain), then re-apply this skill.' >&2; exit 1; }
```

### 2. Verify the trunk carries the session-surface seams

The platform half registers on the community-portal surface module's
platform registry, and the policy reads a channel's record through that
module's client. This is a trunk **version requirement, not an edit**: if
the check fails, the NanoClaw trunk is too old for this skill — bring the
install up to date (`/update-nanoclaw`) instead of patching any of these
files by hand.

```nc:run effect:check
grep -sq 'registerSurfacePlatform' src/modules/community-portal/surface/index.ts && grep -sq 'export async function clientForRow' src/modules/community-portal/surface/index.ts && grep -sq 'export interface SurfaceSpelling' src/code-mode/surface/types.ts || { echo 'slack-code-surfaces: this trunk has no session-surface module (src/modules/community-portal/surface with registerSurfacePlatform and clientForRow, src/code-mode/surface/types.ts). Update NanoClaw (/update-nanoclaw) and re-apply this skill.' >&2; exit 1; }
```

### 3. Copy the payload

This skill ships four files alongside this document; copy them into the tree
at the same relative paths (overwrite; the skill's copies are canonical):

```nc:copy
src/channels/slack-bot-identity.ts
src/channels/slack-code-surfaces.ts
src/channels/slack-code-surfaces-policy.ts
src/channels/slack-code-surfaces.test.ts
```

- `slack-bot-identity.ts` — the `auth.test` lookup and its cache.
- `slack-code-surfaces.ts` — the platform half; registers itself on the
  surface module's platform registry on import.
- `slack-code-surfaces-policy.ts` — admission and the notice filter;
  registers itself on the guard's chain on import.
- `slack-code-surfaces.test.ts` — the guard: drives the real channel barrel
  and the real bot-inbound guard (see step 5 for what it pins).

### 4. Register the payload

Append the two self-registration imports to the channel barrel (each append
is skipped if its line is already present). Order matters only in that both
must follow the `/add-slack` lines, which they do by appending:

```nc:append to:src/channels/index.ts
import './slack-code-surfaces.js';
```
```nc:append to:src/channels/index.ts
import './slack-code-surfaces-policy.js';
```

### 5. Build and validate

Build first — it guards the typed calls against the guard's chain and the
surface module's registry — then run the skill's test, which imports the real
channel barrel and asserts: the Slack platform half is registered and spells
`slack:C…`; the policy is on the chain by name; through the real guard, a
listed member is admitted as `slack:bot:<id>`, a stranger and the manager
are dropped, the hop cap holds and a human resets it, the routing header is
honoured, a channel that is not a surface is left alone, a record the
service cannot answer fails closed for bots and open for humans; the
manager's notices are dropped in a surface channel and nowhere else; and
the bot identity is cached without its token. If either barrel line is
deleted the registration tests go red.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/slack-code-surfaces.test.ts src/channels/slack-a2a-guard.test.ts
```

## Restart

Restart so the running host registers the platform half and the policy:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Using it

Nothing to configure. On a host with a managed Slack app and a sign-in,
`ncl sandboxes new <name>` opens a channel for the session and invites the
host's bot; `ncl sandboxes surface status <name>` shows the binding and
`ncl sandboxes surface archive <name>` is the explicit wrap-up (both from the
surface module). The optional hop cap shares its knob with the rooms skill:

```
SLACK_A2A_MAX_HOPS=6
```

Bots the service lists as members of the channel arrive in the session as
`slack:bot:<bot user id>` senders. A surface channel is created with the
`public` unknown-sender policy by core (everyone in it was invited for the
session), so no approval card is raised for them.

## Remove

1. Delete the four copied files: `src/channels/slack-bot-identity.ts`,
   `src/channels/slack-code-surfaces.ts`,
   `src/channels/slack-code-surfaces-policy.ts`,
   `src/channels/slack-code-surfaces.test.ts`.
2. Delete the lines `import './slack-code-surfaces.js';` and
   `import './slack-code-surfaces-policy.js';` from `src/channels/index.ts`.
3. Optionally delete `data/slack-bot-identity.json` (the cached identity).
4. Rebuild (`pnpm run build`) and restart.

With the skill removed the surface module has no Slack half, so new
sandboxes get no channel; bindings that exist are mirrored through the
no-op provider until archived. The guard's default applies again in surface
channels: bot-authored inbound is dropped there, and the manager's notices
reach the session as mail once more.

## Notes

- **Order on the chain does not matter for surfaces.** For a channel this
  host knows as a coding-session surface, this policy's answer is final —
  admit or deny — and no later policy can re-admit what it denied; a channel
  it does not know is passed on to the next policy (the `/slack-a2a-rooms`
  allowlist, when installed) or the guard's default drop. A surface channel
  also listed in `SLACK_A2A_ROOMS` is still governed here: the manager stays
  out whichever skill was applied first. (A rooms policy registered earlier
  can admit a message this policy would also admit; it cannot undo a
  denial.)
- **A human message never waits on the service.** The notice filter answers
  from the cache; a channel it has not seen yet passes the message and is
  read in the background for the next one. Only DMs and group DMs are
  skipped outright (a surface is always a channel).
- **Where the member list comes from.** The service's channel record, read
  through the surface module's client with a short cache (a hit for a
  minute, a miss for five; concurrent reads share one request). A host that
  serves no Slack surface never asks.
  A record the service will not answer (down, or a channel this host is not
  a member of) drops bot posts and passes humans.
- **Who counts as a bot.** The adapter reports a bot post's author as its
  bot user (`U…`), which is what the record's `members[].botUserId` holds;
  a member's `botId` (`B…`) is matched too when the service records one.
- **The routing header is read when the bridge forwards it.** The Chat SDK
  bridge does not carry Slack message metadata through to the guard today;
  the policy reads `metadata.event_type = "nanoclaw_agent"` from the content
  (or its raw event) when present and otherwise relies on the hop counter.
- **The notice shape is a live fact, not a contract.** The manager's system
  lines were observed to arrive without a bot id; the filter names by
  author, so a line from a user the record does not know still passes as
  human.
- **Only the manager app manages the channel.** Create, invite, views and
  archive run in the service on the manager's token; this host's bot is an
  invited member that reads and posts over its own connection.

## Troubleshooting

- **Sandboxes get no channel.** The surface module offers one only with a
  managed Slack app and a sign-in on this host: check
  `data/slack-install.json` (or the journal's `slackSetup`) names an app and
  `~/.config/nanoclaw/account.json` exists. `logs/nanoclaw.log` says
  "no managed install or sign-in for this platform" when either is missing.
- **A sibling sandbox's posts never reach the session.** Run
  `pnpm exec vitest run src/channels/slack-code-surfaces.test.ts` — red
  means a barrel line or the guard drifted, so re-run the Apply steps. If
  green, the bot is not in the channel's member list at the service (it must
  have joined through the service, not a plain Slack invite), or the hop
  cap was reached: a human message in the channel resets it.
- **The agent receives "added view" lines as messages.** The notice filter
  names notices by author; a line from a user the channel record does not
  know as a bot passes as human. Check the record's members and manager at
  the service, and the debug log for "notice dropped by policy".
- **"bot inbound policy refused — seam version mismatch" in the log.** The
  installed guard and this skill disagree on the policy shape: re-run
  `/add-slack` and this skill from the same channels branch.
