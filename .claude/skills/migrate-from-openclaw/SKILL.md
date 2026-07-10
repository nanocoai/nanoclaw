---
name: migrate-from-openclaw
description: Migrate from OpenClaw to NanoClaw v2. Detects an existing OpenClaw installation, extracts identity, channel credentials, scheduled tasks, and other config, then guides interactive migration. Triggers on "migrate from openclaw", "openclaw migration", "import from openclaw".
---

# Migrate from OpenClaw

Guide the user through migrating their OpenClaw installation into NanoClaw v2.
This is a conversation, not a batch job. Read OpenClaw state, discuss it with
the user, decide together what to bring over and where it belongs in v2's
entity model, and show proposed changes before applying.

**Principle:** Never silently copy data. Read it, explain it, place it, then
apply. Credentials are masked when displayed (first 4 + `...` + last 4). Make
judgment calls about what's core vs. reference material.

**UX:** Use `AskUserQuestion` for multiple-choice only. Use plain text for
free-form input. Don't dump raw data — summarize and explain conversationally.

## What this skill changes (conformance)

This skill drives existing NanoClaw entry points (`setup/index.ts --step
register`, `scripts/init-first-agent.ts`, the `onecli` CLI) and copies a few
files in (workspace markdown, OpenClaw skills, and its own transform module +
test). It makes no code-level reach-in into core. Its integration assumptions
about v2 are guarded by `scripts/transform.test.ts`, which is copied into the
project's `scripts/` test tree on apply (Phase 8) so vitest runs it against the
composed install. `REMOVE.md` reverses every file the skill copies.

## v2 architecture the migration targets

OpenClaw and NanoClaw v2 differ structurally. Keep these in mind throughout:

- **Entity model.** v2's central DB (`data/v2.db`) holds `users`,
  `user_roles`, `agent_groups`, `messaging_groups`, and the
  `messaging_group_agents` wiring between them. There is no `store/messages.db`
  and no `scheduled_tasks` table.
- **Container isolation.** Each agent group runs in its own Linux container.
  An OpenClaw "agent" maps to a v2 *agent group* (workspace + memory +
  CLAUDE.md); an OpenClaw chat/group maps to a v2 *messaging group*; the wiring
  row connects them.
- **Shared vs per-group context.** v2 has no `groups/global/`. Shared
  instructions live in `container/CLAUDE.md` (mounted read-only into every
  container). Per-group memory is `groups/<folder>/CLAUDE.local.md`; the
  `CLAUDE.md` in each group is **composed at spawn — do not edit it.**
- **Credentials.** Container-facing API credentials (Anthropic, OpenAI, …) are
  held in the OneCLI Agent Vault and injected per request — never in container
  env vars. Host-side channel tokens (Telegram/Discord/Slack bot tokens) stay
  in `.env`; the NanoClaw host process reads them to connect to the platform.
- **Access control.** Per messaging group `unknown_sender_policy` plus
  `user_roles` (owner/admin) and `agent_group_members` — not a JSON allowlist
  file.
- **Scheduled tasks.** A task is a `messages_in` row (`kind='task'`) in a
  session's `inbound.db`, carrying a cron `recurrence` and a `process_after`
  timestamp. The agent creates them via its `schedule_task` MCP tool.

## Migration State File

Create `migration-state.md` in the project root at the start of Phase 0. Update
it after each phase. It's the single source of truth — if context is lost,
re-read it to recover decisions and progress. Re-read it before starting any
phase.

Sections to maintain:

- **Progress** — checkbox list of phases (Phase 0–8)
- **Discovery** — STATE_DIR, IDENTITY_NAME, channels, groups (with v2
  platform_id mappings), workspace files, cron count, MCP servers
- **Decisions** — assistant_name, shared-vs-separate, primary owner agent
- **Owner & Primary Agent** — user id, role, agent group folder
- **Registered Groups** — table: folder, platform_id, channel, session_mode
- **Credentials** — table: credential, destination (vault / .env), status
- **Settings Migrated** — timezone, container timeout
- **Identity & Memory** — paths of files created, which CLAUDE.local.md edited
- **Scheduled Tasks** — table: original_id, name, mapped schedule, status
- **Deferred / Not Applicable** — unsupported channels, OpenClaw-only features

Keep it factual and terse. Delete it at the end of Phase 8 (or offer to keep it
as a record).

## Phase 0: Discovery

Run the discovery script to find and summarize the OpenClaw installation:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/discover-openclaw.ts
```

If the user specifies a custom path, pass `--state-dir <path>`.

Parse the status block. Key fields: STATUS, STATE_DIR, CHANNELS,
WORKSPACE_FILES, DAILY_MEMORY_FILES, SKILL_COUNT, SKILLS, CRON_JOBS,
MCP_SERVERS, IDENTITY_NAME, AGENT_COUNT, AGENT_IDS, GROUPS (each formatted
`channel:id(name)=>v2_platform_id` — the right-hand value is what to pass as
`--platform-id` to register).

**Sanity-check the output.** The script detects known structures but can miss
data if OpenClaw's format changed. Check `CONFIG_TOP_KEYS` and
`CONFIG_CHANNEL_KEYS` — if you see keys it didn't report on, read that section
of the config with the Read tool. Check `STATE_DIR_CONTENTS` for directories it
doesn't scan.

**If STATUS=not_found:** Tell the user no OpenClaw install was detected at the
standard locations (`~/.openclaw`, `~/.clawdbot`). Ask for a custom path; if
none, exit.

**If STATUS=found:** Present a human-readable summary (identity name, workspace
files, channels and which v2 supports, daily memory count, skills, cron count,
MCP servers, agent count). Then paraphrase the key architectural differences
from the section above — don't dump it as a table.

AskUserQuestion: "Ready to start migrating? I'll go through each area one at a
time."
1. **Yes, let's go** — proceed to Phase 1
2. **Tell me more** — explain any area they ask about
3. **Skip migration** — exit

## Phase 1: Agents, Groups, and Shared vs Separate

**Decide this before identity/memory** — it determines where files go.

**OpenClaw model:** all groups routed to one agent share a workspace
(SOUL/MEMORY/IDENTITY) and personality; only the session is per-group.

**v2 model:** each agent group is a separate container with its own filesystem,
memory, and CLAUDE.local.md. Shared instructions are placed in
`container/CLAUDE.md` (read-only in every container). There is no
`groups/global/`.

AskUserQuestion: "In OpenClaw your groups shared one personality and memory. In
v2 each agent group is separate. How do you want to handle this?"

1. **Shared base (recommended if it was one bot)** — core personality/identity
   goes in `container/CLAUDE.md` (every container sees it); each group adds its
   own `CLAUDE.local.md` on top.
2. **Fully separate** — each group gets independent memory and instructions; no
   shared base edit.
3. **Just the primary agent for now** — set one agent up; add others later.

Remember this choice for Phase 3.

### Confirm the assistant name

`IDENTITY_NAME` from discovery is the OpenClaw name. Ask: "Your OpenClaw
assistant was named `<IDENTITY_NAME>`. Keep it in v2?" If empty, ask them to
choose (default: "Andy"). The chosen name is passed as `--assistant-name` to
register/init.

### Seed the owner and the primary DM agent

The owner identity and the primary agent are created together by
`scripts/init-first-agent.ts`. It upserts the user, grants the owner role,
creates the agent group + filesystem, wires a DM messaging group, and queues a
welcome DM over the running service's CLI socket — **so the service must be
running.** If it isn't, tell the user to start it first.

Resolve the owner's channel identity and the DM platform id (use the channel's
own terminology). Then:

```bash
pnpm exec tsx scripts/init-first-agent.ts \
  --channel <channel> \
  --user-id <channel>:<handle> \
  --platform-id <channel>:<dm-id> \
  --display-name "<Owner Name>" \
  --agent-name "<confirmed assistant name>" \
  [--role owner]      # default: owner
```

For direct-addressable channels (telegram, whatsapp) the `--platform-id` is
usually the same handle as `--user-id` with the channel prefix. `--role`
defaults to `owner` (global, cross-channel) — use `admin` (scoped to the agent
group) or `member` only if intended.

### Register the remaining groups

For each additional OpenClaw group the user wants to bring over, register a
messaging group and wire it to an agent group:

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "<v2_platform_id from discovery>" \
  --name "<group name>" \
  --folder "<channel>_<name-slug>" \
  --channel "<channel>" \
  --session-mode "<shared|agent-shared|per-thread>" \
  [--trigger "@<assistant name>"] \
  [--no-trigger-required] \
  --assistant-name "<assistant name>"
```

Notes:
- `register` namespaces the `--platform-id` the same way the adapter will at
  runtime, so pass the `=>` value discovery emitted (or the raw OpenClaw id).
- Reuse a `--folder` to put a group on an existing agent (shared base/separate
  conversations); use a new `--folder` for a fully separate agent.
- Engage defaults come from the channel adapter's declaration (most group
  chats default to mention-based engagement; channels without a mention
  signal default to a name pattern). Pass `--trigger` to set an explicit
  regex, or `--no-trigger-required` for respond-to-everything.
- Register groups from channels v2 doesn't support yet too — the messaging
  group and wiring persist and activate when that channel is installed.

Folder naming: `<channel>_<name-slug>` (e.g. `telegram_dev-team`). Confirm each
name and folder with the user.

## Phase 2: Settings from Config

Read the config (`<STATE_DIR>/openclaw.json` or `clawdbot.json`) for settings
that map to v2 setup.

### Timezone

Check `agents.defaults.userTimezone`. If it's a valid IANA zone, write it to
`.env` as `TZ=<timezone>`. v2 reads `TZ` from `.env` (`src/config.ts`) and uses
it for cron/recurrence evaluation, so this matters for scheduled tasks.

### Container timeout

Check `agents.defaults.timeoutSeconds`. v2's equivalent is `CONTAINER_TIMEOUT`
(env var, default 30 min) or per-group `ncl groups config update`. If the
OpenClaw value differs notably, note it; the user can set
`CONTAINER_TIMEOUT=<ms>` in `.env`.

### Access control (sender policies)

OpenClaw per-channel `allowFrom` / `dmPolicy` / `groupPolicy` map onto v2's
model, which is **not** a JSON file. Each messaging group has an
`unknown_sender_policy`; access is granted via `user_roles` (owner/admin) and
`agent_group_members`. Map:

- `dmPolicy`/`groupPolicy: "open"` → leave the default; no extra grants.
- `allowFrom` / `groupAllowFrom` lists → for each allowed sender, upsert the
  user and add them as a member of the relevant agent group via `ncl`:

  ```bash
  ncl users create --id "<channel>:<handle>" --kind <channel> --display-name "<name>"
  ncl members add --user "<channel>:<handle>" --group "<ag-id>"
  ```
- `dmPolicy: "disabled"` → don't wire that chat (or leave it registered but
  unwired).

The messaging groups `register` / `init-first-agent` create default their
`unknown_sender_policy` to whatever the channel adapter declares for that
context (DM vs group) — `strict` when the channel has no declaration — so
unknown senders are gated until you add them (or an admin approves the
adapter-declared approval card). Pass `--unknown-sender-policy` to `register`
to override. Show the user the OpenClaw allowlist and confirm who to grant
before running the commands.

## Phase 3: Identity and Memory

Fully conversational — read files directly and discuss. **Placement depends on
the Phase 1 choice:**

- **Shared base:** core identity/personality → `container/CLAUDE.md` (seen by
  all containers, read-only). Group specifics → that group's
  `groups/<folder>/CLAUDE.local.md`.
- **Fully separate / primary only:** everything → the primary agent's
  `groups/<folder>/CLAUDE.local.md`.

Never edit a group's composed `CLAUDE.md` — it's regenerated each spawn. Edit
`CLAUDE.local.md` (or `container/CLAUDE.md` for the shared base).

Find workspace files at `<STATE_DIR>/workspace/`. If `AGENT_COUNT > 1`, also
check `<STATE_DIR>/agents/*/workspace/` and ask which agent maps to which v2
agent group.

### IDENTITY.md / SOUL.md

Read them. Distinguish always-loaded vs reference:
- **Always loaded** (core traits, communication style, key rules) → weave into
  `container/CLAUDE.md` (shared) or the group's `CLAUDE.local.md` (separate).
- **Reference** (backstory, extended guidelines) → a separate
  `groups/<folder>/soul.md`, with a one-line pointer in `CLAUDE.local.md`:
  "Extended personality is in `soul.md`."

Show proposed edits before applying — this is a thoughtful merge, not a paste.

### USER.md

Create `groups/<folder>/user-context.md` and add a pointer in `CLAUDE.local.md`.
Ask whether any critical facts (name, timezone, key prefs) should go directly
into `CLAUDE.local.md` for always-on awareness.

### MEMORY.md and daily memory files

Show `MEMORY.md`; keep relevant items in `groups/<folder>/memories.md` with a
pointer. For daily files (`workspace/memory/*.md`, count = DAILY_MEMORY_FILES):

AskUserQuestion: "You have N daily memory files. How to handle them?"
1. **Copy as-is** — `cp <workspace>/memory/*.md <group_dir>/daily-memories/`,
   add a pointer in `CLAUDE.local.md`.
2. **Consolidate** — read, extract durable facts, append to `memories.md`.
3. **Skip.**

### OpenClaw skills

If `SKILL_COUNT > 0`, the SKILL.md format is shared, so skills are portable.
Present each (name + description from the front matter) and let the user pick.
For each confirmed skill, copy the directory into the container skills tree:

```bash
cp -r <skill_source_dir> container/skills/<skill_name>
```

A container rebuild is needed afterward — note it for Phase 8.

### Config-registered plugins (with API keys)

If `CONFIG_PLUGINS` is non-empty, OpenClaw had plugins/skills carrying keys.
For each, read the config section and decide together:
- **Matching v2 skill** → run that skill; route its credential per Phase 4.
- **An MCP server** → install the exact configured package; wire via
  `ncl groups config add-mcp-server`. Don't guess at packages.
- **An API key** → route to the OneCLI vault if container-facing (Phase 4).

Don't install unknown packages or search for replacements — supply-chain risk.

## Phase 4: Credentials

Two destinations, decided per credential. **Channel tokens → `.env`** (host
reads them). **Container-facing API credentials → the OneCLI vault** (injected
per request, never in container env).

### Channel tokens (telegram, discord, slack)

Preview, then write to `.env`. The script emits only masked values:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/extract-channel-credentials.ts \
  --state-dir <STATE_DIR> --channel <name>
```

Parse the status block. `DESTINATION: env` confirms a host-side token. Show
`CREDENTIAL_MASKED` (and `CREDENTIAL_MASKED_2` for Slack's app token).

AskUserQuestion:
1. **Use this credential** — re-run with `--write-env .env` to save it.
2. **Enter a new one** — ask in plain text, write to `.env` yourself.
3. **Skip this channel.**

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/extract-channel-credentials.ts \
  --state-dir <STATE_DIR> --channel <name> --write-env .env
```

Check `WRITTEN_TO` / `WRITTEN_COUNT`. Slack writes both `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` in one run.

**If `HAS_CREDENTIAL=false` but a credential is expected:** the config shape may
be unrecognized, or it uses a `file`/`exec` SecretRef (`CREDENTIAL_SOURCE`
ends in `_ref` with a NOTE) that can't be auto-extracted. Read the channel
section of the config directly and ask the user to confirm or paste the value.

**WhatsApp:** authenticates via QR/pairing code — there's no token. Don't copy
Baileys auth state (stale encryption sessions break decryption).
Re-authenticate during `/setup` via `/add-whatsapp`. The extraction script
reports `DESTINATION: none` for it.

### Anthropic and other container-facing credentials → OneCLI vault

Find the agent's model credentials in OpenClaw. Check, in order:
1. `<STATE_DIR>/auth-profiles.json` (and
   `<STATE_DIR>/agents/<id>/agent/auth-profiles.json`) — a `profiles` map keyed
   `provider:identifier`. For an `anthropic` provider profile the value depends
   on `type`: `api_key` → `key`, `token` → `token`, `oauth` → `access`.
2. `<STATE_DIR>/.env` — `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
3. Config `models.providers` — Anthropic provider `apiKey`.

These are container-facing, so they go to the OneCLI vault. Do **not** write
them to `.env` or thread them into a container. Register each in the vault:

```bash
onecli secrets create --name Anthropic --type anthropic \
  --value <key-or-token> --host-pattern api.anthropic.com
```

For other container-facing keys discovered in plugins (e.g. OpenAI):

```bash
onecli secrets create --name OpenAI --type api_key \
  --value <key> --host-pattern api.openai.com
```

Run the command on the user's behalf so the value never lands in the chat
transcript; confirm with `onecli secrets list`.

**Caveats:** `keyRef`/`tokenRef` with `source:"exec"` or `source:"file"` can't
be auto-extracted — ask the user to paste it. For an `oauth` profile with a
past expiry, warn that the token may need refreshing; the user can run
`claude setup-token` and register the fresh token.

If OneCLI isn't installed yet, defer this: tell the user that during `/setup`
(or `/init-onecli`) they'll register the Anthropic credential, and note the
discovered profile in `migration-state.md` so it isn't lost.

> If the user explicitly wants `.env`-based credentials instead of the OneCLI
> vault, that's the `/use-native-credential-proxy` opt-out — the one place
> credentials are read from `.env` and injected into container requests without
> OneCLI. Only go there if the user asks for it.

## Phase 5: Scheduled Tasks

Read `<STATE_DIR>/cron/jobs.json`. If absent or empty, skip.

If jobs exist, read `${CLAUDE_SKILL_DIR}/MIGRATE_CRONS.md` for the v2 task
model, the `mapCronToRecurrence` transform, the full field mapping, and how
tasks are created (the agent's `schedule_task` MCP tool, since tasks live in a
per-session `inbound.db` the host owns). Follow it for each enabled job.

## Phase 6: MCP, Webhooks, Other Config

Read the relevant config sections directly. Conversational.

### MCP servers

If `MCP_SERVERS` is non-empty, v2 supports per-agent-group MCP servers via the
container config. Read each server's `command`/`args`/`env`/`url` from
`mcp.servers`. For each one the user wants:

```bash
ncl groups config add-mcp-server --id <agent-group-id> \
  --name <server-name> --command <cmd> \
  [--args '<json-array>'] [--env '<json-object>']
```

stdio servers must be runnable inside the container (Node/npx-based work;
custom binaries need a Dockerfile addition). Secrets referenced by a server's
`env` should go to the OneCLI vault (Phase 4), not be inlined. The config
change takes effect on restart: `ncl groups restart --id <agent-group-id>`
(add `--rebuild` only if a custom binary was added to the Dockerfile).

### Webhooks

OpenClaw `cron.webhook` / `failureDestination` / channel webhooks don't map to
a v2 primitive. For a notification webhook, fold it into a scheduled task's
prompt or a pre-agent `script` that `curl`s the endpoint. Discuss the use case.

### Other config (mention and move on)

- **Exec approvals / command allowlist** → v2 uses container isolation; the
  agent runs sandboxed.
- **Human delay / TTS / compaction / model config** → not v2 task/group fields
  (per-group model is in the container config).

## Phase 7: Welcome and First Run

`init-first-agent` (Phase 1) already queued a welcome DM for the primary owner
agent. If the service was up, the owner should have received it. For groups
registered via `setup --step register`, the wiring also queues a `/welcome`
onboarding message on first wiring.

Tell the user which agents are live now and which await channel installation
(unsupported channels registered for the future).

## Phase 8: Validate and Summarize

### Run the shipped test

Copy the transform module and its test into the project so vitest runs them
against the composed install, then build and test:

```bash
cp ${CLAUDE_SKILL_DIR}/scripts/transform.ts        scripts/openclaw-transform.ts
cp ${CLAUDE_SKILL_DIR}/scripts/transform.test.ts   scripts/openclaw-transform.test.ts
# Point the copied test at the copied module name:
sed -i.bak "s#from './transform.js'#from './openclaw-transform.js'#" scripts/openclaw-transform.test.ts && rm -f scripts/openclaw-transform.test.ts.bak

pnpm run build
pnpm exec vitest run scripts/openclaw-transform.test.ts
```

The test guards the skill's two v2 integration assumptions: credential routing
(container-facing → vault, channel tokens → `.env`) and the cron → v2
recurrence mapping. It imports the real `cron-parser` (the same parser the host
recurrence sweep uses), so a missing/renamed dependency turns it red. `build`
typechecks the transform module against the project.

These copied files are the only files the skill installs into the project tree;
`REMOVE.md` deletes them.

### If a container rebuild is needed

If OpenClaw skills were copied or MCP servers added: `./container/build.sh`,
then restart the service.

### Summary

Print what was migrated:
- Owner + primary agent → `users` / `user_roles` / agent group + welcome DM
- Additional groups → messaging groups + wiring (folders + session modes)
- Timezone → `.env TZ`; container timeout → noted
- Access grants → members/roles for OpenClaw allowlist senders
- Identity/personality → `container/CLAUDE.md` (shared) or per-group
  `CLAUDE.local.md` + `soul.md`
- User context / memories → `user-context.md` / `memories.md` / `daily-memories/`
- OpenClaw skills → `container/skills/`
- Channel tokens → `.env` (list channels)
- Container-facing credentials → OneCLI vault (list)
- Scheduled tasks → mapped and scheduled via the agent (or noted for first run)
- MCP servers → wired into agent group container configs

Noted for later: channel installs during `/setup`; container rebuild if needed;
tasks deferred until a session exists.

Not applicable: unsupported channels (registered for the future); OpenClaw-only
features (exec approvals, human delay, TTS, model/thinking config).

Remind: "Run `/setup` next to finish your NanoClaw install. Channel tokens are
in `.env`; container-facing credentials are in the OneCLI vault. Select the
channels we configured when setup asks."

Then delete `migration-state.md` (or offer to keep it as a record), and remove
the copied transform files if you don't want them lingering (see `REMOVE.md`).

## Troubleshooting

- **Config parse error:** the JSON5 parser may not handle unusual syntax. Read
  the file directly and work with it manually.
- **Credential not found:** likely a `file`/`exec` SecretRef — ask the user to
  paste the value.
- **`init-first-agent` can't reach the CLI socket:** the service isn't running.
  Start it, then re-run.
- **Multi-agent complexity:** do the primary/default agent first; add others as
  separate agent groups later.
