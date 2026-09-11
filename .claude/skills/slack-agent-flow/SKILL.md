---
name: slack-agent-flow
description: Let an existing Slack agent create new agents that arrive as their own Slack bots — provisioned app, operator DM, and a shared three-way room, hot-started without a host restart.
---

# Slack agent flow (create_agent → provisioned Slack bot)

Composes the Slack extension skills into one conversational flow: a user tells
an existing Slack-wired agent "create an agent called Research", and the new
agent doesn't just exist as a `send_message` destination — it arrives in Slack
as **its own bot**. The host provisions a Slack app for it (managed broker, or
a workspace manager token), registers it as a `slack-<name>` instance,
hot-starts the adapter in the running host, opens a DM between the new bot and
the operator, opens a three-way MPIM (operator + originating bot + new bot)
registered as an agent-to-agent room, and wires everything so both agents hear
the room. The flow also adds two agent-facing room actions — `create_room`
(one shared room with N agents at once, the team primitive) and `add_to_room`
(grow a room by one agent) — and extends the base `create_agent` tool with the
flow's `purpose` / `allow_guests` / `room` parameters. Non-Slack sessions are
untouched: `create_agent` from any other channel behaves exactly as upstream.

**Canonical home.** This directory on `main` is the skill's canonical source —
the setup wizard and any direct apply read it from the checkout. The copy on
the `channels` branch is a compatibility mirror for older checkouts whose
setup fetches companions from there; edits land here, never there. The
payload the Apply steps fetch with `from-branch:channels` stays on the
channels branch, exactly like `/add-slack`'s own.

## Prerequisites

All prose below assumes these are already in place, in this order:

1. **`add-slack`** — the Slack channel install (`src/channels/slack.ts` and
   the shared channel-layer lib `src/channels/slack-lib.ts` present, with
   `slack.ts` exporting its `SLACK_DEFAULTS` declaration and the
   multi-instance factory `slackInstanceBridgeFactory` — the adapter owns
   `SLACK_INSTANCES` registration natively, and the flow writes each new
   agent's tokens under that env-key scheme).
2. **`slack-a2a-rooms`** — the bot-sender room policy
   (`src/channels/slack-a2a.ts` present), so shared rooms admit the sibling
   bots' posts.
3. **A provisioning credential in `.env`** — `NANOCLAW_INSTALL_TOKEN` (managed
   broker) or `SLACK_MANAGER_TOKEN` (direct workspace-level app creation).
   Without one, agent creation still works but the Slack leg reports
   `no-credentials` and points at the finish script.
4. **At least one Slack owner/admin in `user_roles`** — the flow resolves "the
   operator" from the approver chain (scoped admins → global admins → owners)
   and needs a `slack:U…` identity there to open the DM and the room.

## Apply

### 1. Check the Slack payloads are installed

The flow imports the skill-installed Slack channel modules; verify they are in
the tree before copying anything. If `slack-lib.ts`, the `SLACK_DEFAULTS`
export, or the `slackInstanceBridgeFactory` export is missing, the installed
Slack channel payload predates this flow — re-apply the two skills above (or
`/update-skills`) first:

```nc:run effect:check
test -f src/channels/slack.ts && test -f src/channels/slack-lib.ts && test -f src/channels/slack-a2a.ts && grep -q "export const SLACK_DEFAULTS" src/channels/slack.ts && grep -q "export function slackInstanceBridgeFactory" src/channels/slack.ts
```

### 2. Check the trunk extension seams

Everything this flow plugs into is standard trunk API — the adapter hot-start
entry, the delivery batch preview, the mailbox delivery/session helpers, the
create-agent notify option, the decline-and-notify overrides, the container
tool-extension hook, and the setup wizard's channel registries. This is a
trunk **version requirement, not an edit**: if the check below fails, the
NanoClaw trunk is too old for this skill — bring the install up to date
(`/update-nanoclaw`) instead of patching any of these files by hand:

```nc:run effect:check
grep -q "export async function startChannelAdapter" src/channels/channel-registry.ts && grep -q "export function registerDeliveryBatchPreview" src/delivery.ts && grep -q "session: Session) => Promise<void>" src/delivery.ts && grep -q "trigger?: boolean" src/session-manager.ts && grep -q "findCliResponse" container/agent-runner/src/db/messages-in.ts && grep -q "Promise<number>" container/agent-runner/src/db/messages-out.ts && grep -q "suppressCreatedNotify" src/modules/agent-to-agent/create-agent.ts && grep -q "dedupeKey?: string" src/modules/permissions/sender-approval.ts && grep -q "declineText?: string" src/modules/permissions/sender-approval.ts && grep -q "fyiText?: string" src/modules/permissions/sender-approval.ts && grep -q "export function extendTool" container/agent-runner/src/mcp-tools/server.ts && grep -q "export function registerChannelPreStep" setup/channels/companions.ts && grep -q "instructions.md" src/project-doc-compose.ts && grep -q "await action.decide" src/guard/guard.ts
```

The last term requires an async-capable guard seam: the flow's `create_agent`
and room-action guards read container config asynchronously, and on a trunk
whose `guard()` does not await `decide` a returned Promise would be treated
as an allow — the check turns that silent fail-open into a fail-fast here.

### 3. Copy the shared feature payload from the channels branch

The agents experience needs more than the base adapter: the room-membership
module (invite-to-room adoption, group-DM fork carry-over, detach on removal,
owner-presence access rule), canvas actions + the container `canvas` tool +
the `canvas-work` skill (section-scoped canvas edits/reads via the session's
own bot identity), DM onboarding (get-started prompts, per-thread DM titles),
and their `env-file.ts` dotenv plumbing. They live on the `channels` branch;
fetch and copy them into place (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/env-file.ts
src/env-file.test.ts
src/modules/slack-room-membership/index.ts
src/modules/slack-room-membership/membership.ts
src/modules/slack-room-membership/membership.test.ts
src/modules/slack-room-membership/env-file.ts
src/modules/slack-room-membership/env-file.test.ts
src/modules/canvas-actions/index.ts
src/modules/canvas-actions/handlers.ts
src/modules/canvas-actions/canvas-api.ts
src/modules/canvas-actions/canvas-actions.test.ts
src/modules/slack-onboarding/index.ts
src/modules/slack-onboarding/onboarding.test.ts
src/modules/slack-onboarding/thread-title.test.ts
container/agent-runner/src/mcp-tools/canvas.ts
container/agent-runner/src/mcp-tools/canvas.instructions.md
container/agent-runner/src/mcp-tools/canvas.test.ts
container/skills/slack-construct/SKILL.md
container/skills/slack-construct/instructions.md
container/skills/canvas-work/SKILL.md
container/skills/welcome/addenda/slack.md
```

The welcome addendum rides with the agents feature deliberately: its tour
content describes rooms, canvases, suggested-prompt DMs, and the agents
access model — none of which exist on a base `/add-slack` install.

Register the three host modules in the modules barrel and the canvas tool in
the container tool barrel (each append is skipped if already present; these
must precede the flow module's own barrel line, which the fence order here
guarantees):

```nc:append to:src/modules/index.ts
import './slack-room-membership/index.js';
import './canvas-actions/index.js';
import './slack-onboarding/index.js';
```

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './canvas.js';
```

### 4. Copy the flow payload

This skill ships its payload alongside this document; copy the files into the
tree at the same relative paths (overwrite; the skill's copies are canonical).
The host module carries the wrapped `create_agent` handler and the room
actions; the container files carry the room tools, the `create_agent`
extension, the sibling-agent standing-context skill, and the welcome-tour
addendum. The two `mcp-tools/*.instructions.md` fragments and the
`slack-construct-agents` skill's `instructions.md` are picked up by the
CLAUDE.md compose scan; the welcome addendum is consumed by the host's
channel-matched addenda mechanism (inert on hosts that predate it) — so
copying the files is the whole install:

```nc:copy
src/modules/slack-agent-flow/types.ts
src/modules/slack-agent-flow/env-file.ts
src/modules/slack-agent-flow/provision.ts
src/modules/slack-agent-flow/slack-deps.ts
src/modules/slack-agent-flow/orchestrate.ts
src/modules/slack-agent-flow/guard.ts
src/modules/slack-agent-flow/room-actions.ts
src/modules/slack-agent-flow/room-canvas.ts
src/modules/slack-agent-flow/index.ts
src/modules/slack-agent-flow/env-file.test.ts
src/modules/slack-agent-flow/provision.congruence.test.ts
src/modules/slack-agent-flow/provision.prefetch.test.ts
src/modules/slack-agent-flow/orchestrate.test.ts
src/modules/slack-agent-flow/room-actions.test.ts
src/modules/slack-agent-flow/room-canvas.test.ts
scripts/slack-agent-flow-finish.ts
container/agent-runner/src/mcp-tools/rooms.ts
container/agent-runner/src/mcp-tools/rooms.test.ts
container/agent-runner/src/mcp-tools/rooms.instructions.md
container/agent-runner/src/mcp-tools/create-agent-slack.instructions.md
container/skills/slack-construct-agents/SKILL.md
container/skills/slack-construct-agents/instructions.md
container/skills/welcome/addenda/teams-tour.md
```

### 5. Register the host module

Append the self-registration import to the module barrel (skipped if the line
is already present). It must evaluate after the agent-to-agent module's own
registration, which appending at the end guarantees — the flow's `create_agent`
handler re-registers over upstream's:

```nc:append to:src/modules/index.ts
import './slack-agent-flow/index.js';
```

### 6. Register the container room tools

Append the tool-module import to the container MCP-tools barrel (skipped if
already present). The module registers `create_room` / `add_to_room` and
extends the base `create_agent` tool, so it must evaluate after the base
agents module — import order follows document order, and appending at the end
guarantees it:

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './rooms.js';
```

### 7. Build

The build guards every typed call the flow makes into trunk (delivery
registration, DB helpers, channel defaults, the shared Slack lib) against
drift:

```nc:run effect:build
pnpm run build
```

### 8. Validate

The flow's own tests, the shared feature payload's module tests, and the trunk
hot-start seam's test run on the host. The room-tool tests run through the
already-built agent image, so setup does not require Bun on the host; they also
pin the `create_agent` extension:

```nc:run effect:test
pnpm exec vitest run src/modules/slack-agent-flow src/modules/slack-room-membership src/modules/canvas-actions src/modules/slack-onboarding src/env-file.test.ts src/channels/adapter-hot-start.test.ts
```

```nc:run effect:test
source "$PWD/setup/lib/install-slug.sh" && "${CONTAINER_RUNTIME:-docker}" run --rm --entrypoint bun --workdir /app --volume "$PWD/container/agent-runner/src:/app/src:ro" "$(container_image_base):latest" test --preload /app/src/modules/index.ts src/mcp-tools/rooms.test.ts src/mcp-tools/canvas.test.ts
```

### 9. Restart the host

The flow module registers at boot, and container mounts are read-only at
runtime — restart so the running host picks everything up (new sessions see
the container-side files; no image rebuild):

```nc:run effect:restart
bash setup/lib/restart.sh
```

## How it behaves

- **Guard/approval flow is upstream's.** The flow re-registers `create_agent`
  with the same guard action and precheck as the agent-to-agent module; only
  the hold question changes when the request originates from a Slack session
  (it names the Slack provisioning side effects — new app, operator DM,
  shared room). The room actions get the same trust split: `global` cli_scope
  groups act directly, everything else holds for the admin chain, and
  approved replays re-enter the wrapped handlers automatically.
- **Expected boot warning.** Because the barrel imports the flow module after
  the agent-to-agent module, every boot logs
  `Delivery action handler overwritten` for `create_agent`. That warning is
  the intended signal that the wrapper won the registry — its absence means
  the barrel line is missing or ordered wrong.
- **What a successful run does.** Provisions (or reuses) the app — agent-mode
  by default; `allow_guests: true` selects the plain, guest-accessible
  variant — writes `SLACK_BOT_TOKEN_<NAME>` / `SLACK_APP_TOKEN_<NAME>` and
  unions the slug into `SLACK_INSTANCES`, hot-starts `slack-<name>`, opens
  the operator DM and wires it to the new agent group (agent-mode DMs get
  thread-per-conversation sessions straight from the channel declaration),
  opens the three-way MPIM with the new bot's token, appends the room's
  channel id to `SLACK_A2A_ROOMS`, creates one room messaging group per
  instance (both mention-gated), creates the room's canvas-tab contract, then
  posts the DM intro and nudges the originating agent to introduce the new
  one in the room. The new bot typically answers within ~10 seconds; if it
  stays silent for a minute, an operator can run `bash setup/lib/restart.sh`
  as the fallback.
- **Workspaces that gate installs.** Where an admin must approve every app
  install, the workspace refuses the automatic one and the managed service
  answers with an install link instead of a bot token. The flow does not fall
  back to hand-building an app: it posts one line into the conversation the
  create came from — as the ORIGINATING bot, since the origin agent's own
  reply cannot be delivered while the handler is still running — naming the
  link to approve, then polls the service (5s, up to 5 minutes) for the bot
  token the completed install releases. On arrival the rest of the flow runs
  exactly as if the install had been automatic. On timeout the app parks:
  `SLACK_APP_TOKEN_<NAME>`, `SLACK_APP_ID_<NAME>` and
  `SLACK_INSTALL_URL_<NAME>` stay in `.env`, and asking the same agent for the
  same name again resumes THAT app — it never provisions a second one.
  `SLACK_INSTALL_WAIT_MS=0` skips the inline wait for installs that always go
  through a slow approval queue; `SLACK_INSTALL_POLL_MS` moves the cadence.
- **Teams get one room.** `create_agent({ ..., room: 'none' })` skips the
  shared room; the multi-agent pattern is N such creates followed by ONE
  `create_room` naming all of them. When a batch of creates arrives together,
  their avatar generations are prefetched in parallel, so N waits collapse to
  roughly one.
- **A2A cache staleness.** The a2a room allowlist is re-read from `.env` on a
  ≤30s cache. The room id is appended before any intro is posted, but the
  originating agent's own bridge may still miss ingesting the intro inside
  that window — harmless; the intro is for the human, and the originating
  session is told the room id and wirings directly in its success message.
- **Failures are resumable.** Any Slack-leg failure leaves the agent group
  fully working via `send_message`, reports the exact step that failed, and
  names the retry command. The finish script re-runs the whole leg
  idempotently (tokens are reused from `.env`, rows are get-before-create,
  intro posts fire only for newly created rows):

  ```bash
  pnpm exec tsx scripts/slack-agent-flow-finish.ts --group <newAgentGroupId> --name <slug> --source-group <sourceGroupId> [--origin-instance <key>] [--room none] [--allow-guests] [--restart]
  ```

  It runs outside the host process, so it cannot hot-start the adapter:
  `--restart` runs `bash setup/lib/restart.sh` for you, otherwise it prints
  the restart instruction.

- **Setup-wizard leg.** `bash nanoclaw.sh` does the whole install by default:
  the managed-provisioning pre-step and the companion list (`slack-a2a-rooms`,
  then this skill) register unconditionally at wizard boot
  (`setup/channels/slack-auto-register.ts` → `setup/channels/companions.ts`),
  so the wizard provisions the first app, applies `/add-slack`, then applies
  both feature skills with one deferred restart. A plain-bot install is the
  manual choice inside the flow. That leg ships with trunk, and this skill
  does not touch it.

Everything the flow creates at runtime is user data, not skill payload: agent
groups, messaging groups, and wirings stay in the central DB; token lines,
`SLACK_INSTANCES` entries, and `SLACK_A2A_ROOMS` entries stay in `.env`;
provisioned Slack apps stay in the workspace. Removal (see REMOVE.md) never
touches any of it — for per-agent teardown of a provisioned bot, follow the
slack-managed-agents skill's teardown section.
