---
name: migrate-slack-agents
description: Migrate a classic single-bot Slack install to one provisioned Slack app per existing agent group while preserving agent identities, workspaces, memory, and wiring behavior — or record the operator's choice to stay on classic, which remains supported. Use when /update-nanoclaw surfaces the Slack agents requirement, or standalone any time later.
---

# Migrate classic Slack agents

Turn every agent group wired through the classic `instance='slack'` adapter into
a named `slack-<slug>` bot without replacing the agent group. This is an
operator-guided, resumable data migration. It never creates an agent group and
never edits an agent workspace.

Migration is optional. Classic single-bot Slack remains fully supported; this
skill first offers the choice, and staying on classic is a valid outcome that
also satisfies the update requirement.

Hard invariants:

- Never call `create_agent` or `ncl groups create`.
- Never change an `agent_groups.id` or write under `groups/<folder>/`.
- Never merge the `channels` branch; fetch and copy skill-owned files only.
- Never print token values. Show key names and masked presence only.
- Keep classic rows, credentials, and the shared Slack app available for
  rollback until the operator explicitly approves cutover.

## Phase 1: Detect classic state

Run from the NanoClaw project root. Read the central DB only through the
sanctioned wrapper.

Classic state requires all four signals:

1. `src/channels/index.ts` contains the Slack barrel import
   `import './slack.js';`.
2. `.env` has a non-empty unsuffixed `SLACK_BOT_TOKEN` and either a non-empty
   `SLACK_APP_TOKEN` or `SLACK_SIGNING_SECRET`. Check presence without echoing
   values.
3. This query returns at least one row:

   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.id, mga.id, mga.agent_group_id FROM messaging_groups mg JOIN messaging_group_agents mga ON mga.messaging_group_id=mg.id WHERE mg.channel_type='slack' AND mg.instance='slack' ORDER BY mg.id, mga.agent_group_id"
   ```

4. At least one wired group does not yet have complete named-instance coverage:
   a stable slug, both `SLACK_BOT_TOKEN_<SUFFIX>` and
   `SLACK_APP_TOKEN_<SUFFIX>`, that slug in `SLACK_INSTANCES`, and the expected
   `slack-<slug>` messaging-group/wiring rows.

If the classic conjunction is absent and there is no partial state, stop with:

> Nothing to migrate: this install does not have the classic shared-bot Slack state.

This is a successful no-op. If only some signals exist, make no changes; report
the inconsistent or partial state instead of guessing. If every wired group
already has complete named coverage, report that the migration is already
complete and proceed only to the update-requirement acknowledgement in Phase 9.

## Phase 1b: Offer the choice

Classic state confirmed does not mean migration is required. Present the
decision to the operator before touching anything, in words like these:

> Your classic Slack setup keeps working as-is — nothing forces this
> migration. The new Slack experience adds Slack agent spawning (create new
> agents straight from Slack, each with its own provisioned bot and avatar)
> plus UX improvements — per-agent identities, DM onboarding, multi-agent
> rooms. Say the word and we'll run the upgrade now — or run
> `/migrate-slack-agents` later manually.

If the operator chooses to **stay on classic**: make no changes, acknowledge
the update requirement now using the Phase 9 ack command (the requirement
records a decision, not only a completed migration), state that classic Slack
continues working unchanged, and stop. Re-running this skill later re-offers
the migration.

If the operator chooses to **migrate**, continue to Phase 2.

## Phase 2: Inventory and propose the map

Before any mutation, capture every classic surface and its complete behavior:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT ag.id, ag.name, ag.folder, mg.id, mg.platform_id, mg.name, mg.is_group, mg.unknown_sender_policy, mga.id, mga.engage_mode, mga.engage_pattern, mga.sender_scope, mga.ignored_message_policy, mga.session_mode, mga.threads, mga.priority FROM messaging_groups mg JOIN messaging_group_agents mga ON mga.messaging_group_id=mg.id JOIN agent_groups ag ON ag.id=mga.agent_group_id WHERE mg.channel_type='slack' AND mg.instance='slack' ORDER BY ag.id, mg.id, mga.priority DESC"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT ad.agent_group_id, ad.local_name, ad.target_type, ad.target_id FROM agent_destinations ad JOIN messaging_groups mg ON ad.target_type='channel' AND ad.target_id=mg.id WHERE mg.channel_type='slack' AND mg.instance='slack' ORDER BY ad.agent_group_id, ad.local_name"
```

Classify each surface as DM, channel, or MPIM. A `D…` conversation is a DM;
use Slack `conversations.info` with the classic bot token to distinguish an
MPIM from a channel when the stored id is ambiguous, returning only type/id
metadata and never the token.

Choose one stable, unique slug per agent group using the flow's normalization:
lowercase, replace non-alphanumerics with `-`, trim `-`, and add a numeric
suffix if an env key, `SLACK_INSTANCES` entry, or named DB instance is already
claimed by another group. Once any migration state exists, never change that
group's slug. Include the group commonly called “master”; it also gets its own
provisioned app.

Slugs are de-duplicated, but the Slack-visible bot display name comes from the
agent group's name — and Slack allows two apps with identical display names in
one workspace, leaving humans a mention picker with twins told apart only by
avatar. If any two migrating groups share a display name, flag it in the
dry-run and have the operator differentiate the names before provisioning;
renaming at this point is free, while renaming after provisioning requires a
manifest update.

Present a dry-run table with:

- agent group id, name, folder, and chosen slug;
- every old messaging-group id, type, platform id, and destination name;
- the full old wiring row and unknown-sender policy;
- the proposed `slack-<slug>` surface and whether it is new, partial, or done.

For a channel, map the old row to a sibling with the same `platform_id` and
`instance='slack-<slug>'`. DMs and MPIMs need new conversation ids as described
in Phase 6. Ask the operator to confirm the entire map before continuing.

## Phase 3: Install the current Slack agents payloads

First run `/update-skills` for the installed Slack channel only and require its
structured result to report `success: true` and `refreshed`. That refreshes the
barrel-registered `/add-slack` payload; it deliberately does not install
companion skills, credentials, wirings, or restarts.

Resolve the remote that points at `nanocoai/nanoclaw` the same fork-aware way
`/update-skills` does; do not assume it is `origin`. Fetch, but never merge:

```bash
source setup/lib/channels-remote.sh
channels_remote="$(resolve_channels_remote)"
git fetch "$channels_remote" channels
```

From `$channels_remote/channels`, materialize every file under
`.claude/skills/slack-a2a-rooms/` and then every file under
`.claude/skills/slack-agent-flow/` with `git ls-tree` + `git show`. Read each
new `SKILL.md` completely and apply its own Apply steps, in that order. The
order is load-bearing and mirrors `setup/channels/companions.ts`. The standard
driver may apply each document:

```bash
pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/slack-a2a-rooms
pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/slack-agent-flow
```

Do not continue unless both report fully applied and their own build/tests
pass. Source contracts: `.claude/skills/add-slack/SKILL.md`,
`setup/channels/companions.ts`, and the two fetched companion `SKILL.md` files.

## Phase 4: Get provisioning authority

Pause and ask the operator to choose and complete one authority path:

1. **Managed broker** — enroll/validate the registry install token, then have
   the operator connect the intended Slack workspace through the broker OAuth
   flow. The flow accepts `NANOCLAW_INSTALL_TOKEN` or the enrolled account.
2. **Direct Slack** — the operator supplies a valid `SLACK_MANAGER_TOKEN` in
   `.env` for `apps.manifest.create` + `apps.managedInstall`.

Never select a path, workspace, or authority on the operator's behalf. Confirm
the intended workspace matches the classic bot's `auth.test` team before any
app is created. See `src/provisioning/slack-app.ts` and the fetched flow's
`provision.ts` for the two transport contracts.

## Phase 5: Provision every existing group

Choose an existing classic Slack-wired group with a Slack approver as the
stable source group. It supplies the operator identity and authenticates the
origin `slack` instance; it is not cloned. For every inventoried group,
including the source/master group, run the installed finish primitive with
the recorded slug and defer room creation:

```bash
pnpm exec tsx scripts/slack-agent-flow-finish.ts \
  --group <existing-agent-group-id> \
  --name <stable-slug> \
  --source-group <source-agent-group-id> \
  --origin-instance slack \
  --room none
```

Do not pass `--restart` yet. Run all groups first. The script reuses a complete
suffixed token pair, creates the operator DM and its wiring idempotently, and
does not create an agent group. On a partial pair, finish the existing Slack
app installation and retry the same slug; never choose a new slug or create a
second app. Ensure every completed slug is present exactly once in
`SLACK_INSTANCES`, including reuse cases. The exact CLI contract is documented
at the top of `scripts/slack-agent-flow-finish.ts`.

## Phase 6: Recreate surfaces and clone behavior

For each old wiring:

- **Channel:** the operator or an authorized Slack API caller must invite the
  new bot to the existing channel. Use the same channel `platform_id`.
- **DM:** use the operator DM created by the finish script. Every other user
  must open a new DM with the new bot; use that new DM id.
- **MPIM:** recreate the membership with the new bot. Slack forks it to a new
  conversation id; use the new id.

Create each sibling through `ncl messaging-groups create`, copying `name`,
`is_group`, and `unknown_sender_policy`. Then use `ncl wirings create` with
`--channel-type slack`, the resolved `--platform-id`,
`--instance slack-<slug>`, and the existing `--agent-group-id`. Pass the
recorded `--engage-mode`, `--engage-pattern`, `--sender-scope`,
`--ignored-message-policy`, `--session-mode`, `--priority`, and thread policy;
omit `--threads` when the old value is NULL, otherwise pass `true` or `false`.

```bash
ncl messaging-groups create --channel-type slack --platform-id <new-or-reused-platform-id> --instance slack-<slug> --name "<recorded-name>" --is-group <0-or-1> --unknown-sender-policy <recorded-unknown-sender-policy>
ncl wirings create --channel-type slack --platform-id <new-or-reused-platform-id> --instance slack-<slug> --agent-group-id <existing-agent-group-id> --engage-mode <recorded-engage-mode> --sender-scope <recorded-sender-scope> --ignored-message-policy <recorded-ignored-policy> --session-mode <recorded-session-mode> --priority <recorded-priority>
```

If a legacy pattern row has NULL `engage_pattern`, pass `.` to preserve its
match-all runtime behavior. Do not accept adapter defaults in place of any
recorded behavior field. These create operations are idempotent on their
natural keys/pairs and create the companion destination row.

Show these operator-visible warnings verbatim:

- DM `platform_id`s are bot-specific (old DMs can't be copied; only the operator DM is auto-resolved — other DMs need re-opening per user).
- `user_dms` cache is not instance-aware.
- MPIM membership changes fork conversations (new IDs).
- Existing sessions stay on the old rows (session history does not transfer — new instances start fresh sessions).
- Destination names collide → suffixed (reconcile deliberately, preserve the original local name where the old wiring is retired).

Keep suffixed destination names during the rollback window. If the operator
later retires an old wiring, reconcile with `ncl destinations remove/add`
instead of raw SQL, and transfer its original local name only after the old
target no longer needs it. `src/db/messaging-groups.ts` and
`docs/db-central.md` define the destination side effect and session behavior.

## Phase 7: Verify before cutover

Restart once after all apps and rows exist:

```bash
bash setup/lib/restart.sh
```

Do not proceed until all checks pass:

- every `slack-<slug>` instance authenticates after restart; confirm with
  instance-specific startup logs and Slack `auth.test` without printing tokens;
- the operator can DM every agent and receive the response from the new bot;
- each new bot is invited to every mapped channel, and an explicit mention of
  that bot reaches only the expected existing agent group;
- controlled channel tests show no duplicate responders from the classic and
  named bots;
- the baseline and current `agent_groups` ids/folders are identical, every
  original `groups/<folder>/` remains in place, and no persona, workspace, or
  memory file was rewritten;
- every mapped sibling row and wiring matches the recorded behavior fields.

If a test fails, keep the classic app active, repair the partial named state,
and resume from the ledger. Do not acknowledge the update requirement.

## Phase 8: Explicit cutover gate

Show the verification result and ask the operator for explicit cutover
confirmation. Only after approval, remove the classic bot from migrated
channels and/or disable the unsuffixed Slack credentials so the shared adapter
cannot answer alongside the named bots. Re-run the channel tests and require
no duplicate responders.

Never delete or archive a Slack app automatically. Until this gate, keep the
old rows, apps, and tokens intact. Detached old messaging-group rows preserve
their wirings, sessions, and destinations, providing the rollback path: restore
the unsuffixed credentials or re-invite the classic bot, restart, and disable
the named instances if necessary.

## Phase 9: Resume and acknowledge the update

The workflow is safe to re-run. Treat a group as complete only when its stable
slug has both suffixed tokens, a `SLACK_INSTANCES` entry, and matching DB
coverage for every mapped surface. Skip complete steps. Resume partial rows or
credentials with the same slug; the finish primitive reuses tokens and its
Slack/DB legs are get-before-create, so retries do not duplicate apps or rows.

Acknowledge the `[BREAKING]` requirement in exactly two cases: the operator
chose to stay on classic (Phase 1b), or Phases 7 and 8 passed. Use the
transaction id and requirement id supplied by `/update-nanoclaw`:

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" ack \
  --project-root "$PWD" --id "$id" \
  --requirement "$requirement_id" --status succeeded
```

Then return control to `/update-nanoclaw` to finish and health-check. A failed
or half-migrated state remains pending; never acknowledge it merely to let the
update finish — either complete verification and cutover, or roll back to
classic and record the stay decision instead.
