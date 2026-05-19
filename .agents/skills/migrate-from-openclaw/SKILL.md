---
name: migrate-from-openclaw
description: Migrate from OpenClaw to NanoClaw. Detects existing OpenClaw installation, extracts identity, channel credentials, scheduled tasks, and other config, then guides interactive migration. Triggers on "migrate from openclaw", "openclaw migration", "import from openclaw".
---

# Migrate from OpenClaw

Guide the user through migrating their OpenClaw installation to NanoClaw. This is a conversation, not a batch job. Read OpenClaw state, discuss it with the user, make judgment calls together about what to bring over and how.

**Principle:** Never silently copy data. Read it, explain it, discuss where it belongs in NanoClaw's architecture, show proposed changes before applying. Credentials must be masked when displayed (first 4 + `...` + last 4 characters). Make judgment calls about what's core vs. reference material.

**UX:** Use `AskUserQuestion` for multiple-choice only. Use plain text for free-form input. Don't dump raw data — summarize and explain conversationally.

## Migration State File

Create `migration-state.md` in the project root at the start of Phase 0. Update it after each phase completes. This file is the single source of truth for the migration — if context is compacted or lost, re-read it to recover all decisions and progress.

Before starting any phase, re-read `migration-state.md` to ensure you have current state.

Sections to maintain (add data as each phase completes):

- **Progress** — checkbox list of phases (Phase 0–7)
- **Discovery** — STATE_DIR, IDENTITY_NAME, channels, groups (with JID mappings), workspace files, cron job count, MCP servers
- **Decisions** — assistant_name, group_model (shared/separate/main-only), main_group (folder + jid)
- **Registered Groups** — table: folder, jid, channel, is_main
- **Settings Migrated** — timezone, anthropic_credential (masked), sender_allowlist (created/skipped)
- **Identity & Memory** — paths of files created, which AGENTS.md was edited
- **Channel Credentials** — table: channel, status, env_var
- **Scheduled Tasks** — table: original_id, name, migrated/deferred
- **Deferred / Not Applicable** — unsupported channels, discussed customizations, OpenClaw-only features

Keep it factual and terse — this is for machine recovery after compaction, not human reading. Delete the file at the end of Phase 7 (or offer to keep it as a record).

## Phase 0: Discovery

Run the discovery script to find and summarize the OpenClaw installation:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/discover-openclaw.ts
```

If the user specifies a custom path, pass it: `--state-dir <path>`

Parse the status block. Key fields: STATUS, STATE_DIR, CHANNELS, WORKSPACE_FILES, DAILY_MEMORY_FILES, SKILL_COUNT, SKILLS, CRON_JOBS, MCP_SERVERS, IDENTITY_NAME, AGENT_COUNT, AGENT_IDS.

**Sanity-check the output:** The discovery script detects known structures but can silently miss data if OpenClaw's format has changed. Check `CONFIG_TOP_KEYS` and `CONFIG_CHANNEL_KEYS` — if you see keys the script didn't report on (e.g. a channel name not in CHANNELS, or a top-level section like `integrations` or `plugins`), read that section of the config directly with the Read tool. Also check `STATE_DIR_CONTENTS` for directories the script doesn't scan (e.g. unexpected folders alongside `workspace/`, `agents/`, `cron/`).

**If STATUS=not_found:** Tell the user no OpenClaw installation was detected at the standard locations (`~/.openclaw`, `~/.clawdbot`). Ask if they have a custom path. If not, exit.

**If STATUS=found:** Present a human-readable summary:

- "I found your OpenClaw installation at `<STATE_DIR>`."
- Identity: name from IDENTITY.md (if found)
- Workspace files: which of SOUL.md, USER.md, MEMORY.md, IDENTITY.md exist
- Channels: list each, note which NanoClaw supports (whatsapp, telegram, slack, discord) and which it doesn't
- Daily memory files: count (if any)
- Skills: count and names (from workspace, shared, personal, project locations)
- Cron jobs: count and names
- MCP servers: count and names
- Agents: count (relevant for Phase 1 groups discussion)

Then explain the key architectural differences. Don't dump a table — paraphrase conversationally:

- **Container isolation:** NanoClaw runs each agent in an isolated Linux container (Docker or Apple Container). OpenClaw runs everything in one process. This means stronger isolation but also means each group is its own sandbox.
- **Group-based memory:** In OpenClaw, all groups under one agent share the same SOUL.md, MEMORY.md, and IDENTITY.md. In NanoClaw, each group has its own filesystem and AGENTS.md. Shared state goes in `groups/global/AGENTS.md` (mounted read-only into all non-main containers).
- **Channel skills:** In OpenClaw, channels are configured in `openclaw.json`. In NanoClaw, channels are installed as code via skills (`/add-telegram`, `/add-whatsapp`, etc.) and configured through `.env` variables.
- **Simpler config:** NanoClaw has no config file — behavior is in the code and `AGENTS.md` files. Credentials live in `.env` or the OneCLI vault.

AskUserQuestion: "Ready to start migrating? I'll go through each area one at a time."
1. **Yes, let's go** — proceed to Phase 1
2. **Tell me more** — explain more about any area they ask about
3. **Skip migration** — exit

## Phase 1: Groups and Architecture

**This discussion must happen before identity/memory, because the shared-vs-isolated decision determines where files go.**

If GROUP_COUNT > 0 or AGENT_COUNT > 1, this is a critical conversation. Even with just one group, explain the model difference so the user understands what they're getting into.

**OpenClaw model:** All groups routed to the same agent share one workspace — the same SOUL.md, MEMORY.md, IDENTITY.md, and tools. When you talk to the bot in your family chat or your work chat, it's the same agent with the same personality and memory. Only the session (conversation history) is separate per group.

**NanoClaw model:** Each group is a completely separate agent running in its own Linux container. Separate filesystem, separate memory, separate AGENTS.md. The bot in your family chat and your work chat are different agents that don't know about each other — unless you explicitly share state via `groups/global/AGENTS.md`, which is mounted read-only into all non-main containers.

Explain this conversationally. If the user only has one group, it's simple — just note the difference and move on. If they have multiple groups, discuss:

AskUserQuestion: "In OpenClaw, your groups shared the same personality and memory. In NanoClaw, each group is a fully separate agent. How would you like to handle this?"

1. **Shared personality (recommended if your groups had the same bot)** — "I'll put the shared personality, identity, and user context in `groups/global/AGENTS.md`. Every group sees it. Each group can add its own customizations on top."
2. **Fully separate** — "Each group gets its own independent personality and memory. Complete isolation between groups."
3. **Just main group for now** — "Set up one group now. We can add others later."

Remember this choice — it determines where identity and memory files go in the next phase.

### Confirm assistant name

Before registering groups, confirm the assistant name — it's used for trigger patterns and AGENTS.md templates.

IDENTITY_NAME from discovery gives the OpenClaw name. Ask the user: "Your OpenClaw assistant was named `<IDENTITY_NAME>`. Want to keep this name in NanoClaw?" If they want a different name, ask what it should be. If IDENTITY_NAME was empty, ask them to choose a name (default: "Andy").

The register step's `--assistant-name` flag writes `ASSISTANT_NAME` to `.env` and updates AGENTS.md templates automatically — no manual `.env` write needed.

### Registering groups

The discovery script provides detected groups in the GROUPS field (format: `channel:id(name)=>nanoclaw_jid`). These are extracted from OpenClaw's session store and channel config.

For each group the user wants to bring over, pre-register it:

```bash
pnpm exec tsx setup/index.ts --step register -- --jid "<nanoclaw_jid>" --name "<group_name>" --folder "<channel>_<slug>" --trigger "@<confirmed_name>" --channel <channel> --assistant-name "<confirmed_name>"
```

Only pass `--assistant-name` on the first registration (it updates all AGENTS.md templates globally).

Folder naming: `<channel>_<name-slug>` (e.g. `whatsapp_family-chat`, `telegram_dev-team`). Ask the user to confirm each group's name and folder.

For the first/primary group, add `--is-main --no-trigger-required`. Other groups default to requiring a trigger prefix.

**Important:** Registration requires the database to exist. If the environment step hasn't been run yet, run it first: `pnpm exec tsx setup/index.ts --step environment`. Registration also creates the group folder under `groups/` and copies the AGENTS.md template.

Register groups from all channels — including channels NanoClaw doesn't yet support (signal, matrix, etc.). The registration stores the JID and metadata in the database, ready for when that channel is added later. Groups won't receive messages until their channel code is installed, but the registration, group folder, and AGENTS.md will be ready.

## Phase 2: Settings from Config

Before identity/memory, extract settings from `openclaw.json` that map directly to NanoClaw setup. Read the config file with the Read tool (`<STATE_DIR>/openclaw.json` or `clawdbot.json`).

### Timezone

Check `agents.defaults.userTimezone` in the config. If present and it's a valid IANA timezone (e.g. `America/New_York`, `Asia/Jerusalem`), write it to `.env` as `TZ=<timezone>`. NanoClaw's setup step 2a reads `TZ` from `.env` (`src/config.ts:84-97`) and will skip the autodetection prompt.

### Anthropic Credentials

Check for Anthropic API keys or tokens in OpenClaw's auth system. OpenClaw stores credentials in `<STATE_DIR>/auth-profiles.json` or `<STATE_DIR>/agents/main/agent/auth-profiles.json` with this structure:

```json
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",       // or "token" or "oauth"
      "provider": "anthropic",
      "key": "sk-ant-..."      // for api_key type
    }
  }
}
```

Profile IDs follow `provider:identifier` format. Look for any profile where `provider` is `"anthropic"`. The credential field depends on the `type`:
- `type: "api_key"` → `key` field (or `keyRef` for SecretRef)
- `type: "token"` → `token` field (or `tokenRef` for SecretRef)
- `type: "oauth"` → `access` field (OAuth access token, may need refresh)

Also check:
1. `<STATE_DIR>/.env` — for `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
2. Config `models.providers` — for Anthropic provider entries with `apiKey`

If found, offer to save to `.env`. This pre-fills the NanoClaw setup credential step (step 4) so the user doesn't need to re-enter it. Use the same masking approach — show first 4 + last 4 characters, write the full value directly.

**Important:** If the credential uses `keyRef`/`tokenRef` with `source:"exec"` or `source:"file"`, explain that it can't be auto-extracted and the user will need to enter it during setup. For `type: "oauth"` credentials with an expiry in the past, warn the user the token may need to be refreshed during setup.

### Sender Allowlists

Read the channel configs for access control settings. OpenClaw stores these per-channel:
- `channels.<channel>.allowFrom` — array of allowed sender IDs (E.164 for WhatsApp, numeric IDs for Telegram)
- `channels.<channel>.dmPolicy` — `"open"`, `"allowlist"`, `"disabled"`
- `channels.<channel>.groupPolicy` — `"open"`, `"allowlist"`, `"disabled"`
- `channels.<channel>.groupAllowFrom` — array of allowed group member IDs

NanoClaw uses `~/.config/nanoclaw/sender-allowlist.json` with this format:
```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": {
      "allow": ["sender-id-1", "sender-id-2"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

Fields:
- `allow`: `"*"` (all senders) or `string[]` (specific sender IDs)
- `mode`: `"trigger"` (messages stored but trigger blocked for non-allowed senders) or `"drop"` (messages silently discarded before storage)
- `logDenied`: optional boolean (default `true`), logs denied messages

If OpenClaw had allowlists configured, show the user what was set and offer to create the NanoClaw equivalent. Map:
- `dmPolicy:"allowlist"` + `allowFrom` → per-chat entry with `"allow"` array, `"mode": "trigger"`
- `groupPolicy:"allowlist"` + `groupAllowFrom` → per-group entry with `"allow"` array, `"mode": "trigger"`
- `dmPolicy:"open"` → `"allow": "*"`
- `dmPolicy:"disabled"` → per-chat entry with `"allow": []`, `"mode": "drop"` (or don't register that chat)

Create the directory and file:
```bash
mkdir -p ~/.config/nanoclaw
```

Then write the JSON file. If no allowlists were configured, skip this.

### Container Timeout

Check `agents.defaults.timeoutSeconds` in the config. This is maximum total agent runtime (wall-clock). NanoClaw's equivalent is `CONTAINER_TIMEOUT` (env var, default 30 min), also configurable per-group via `containerConfig.timeout`. Note: NanoClaw also has a separate `IDLE_TIMEOUT` (max time without output) which resets on activity — OpenClaw has no equivalent.

If the OpenClaw value differs significantly from 30 minutes, note it for the user. They can set `CONTAINER_TIMEOUT=<ms>` in `.env` after setup.

## Phase 3: Identity and Memory

This phase is fully conversational — read files directly and discuss with the user. No script needed.

**Where files go depends on the Phase 1 (groups) decision:**
- **Shared personality:** Core identity goes in `groups/global/AGENTS.md` (seen by all groups). Group-specific customizations go in each group's own AGENTS.md.
- **Fully separate:** Everything goes in `groups/main/` (or each group's own folder).
- **Just main group:** Everything goes in `groups/main/`.

### Find workspace files

The STATE_DIR from discovery tells you where OpenClaw lives. Look for workspace files at `<STATE_DIR>/workspace/`. If AGENT_COUNT > 1, also check `<STATE_DIR>/agents/*/workspace/` and ask which agent to migrate.

Use the Read tool to look at each file found.

### IDENTITY.md

Read `<STATE_DIR>/workspace/IDENTITY.md` if it exists. It uses a key:value format (name, emoji, creature, vibe, etc.).

The assistant name was already confirmed and written to `.env` in Phase 1. Here, focus on the rest of the identity — create an `identity.md` file with the full identity details (emoji, creature, vibe, personality traits, etc.). If shared personality was chosen in Phase 1, put it alongside `groups/global/AGENTS.md`. Otherwise, put it in `groups/main/`.

### SOUL.md

Read `<STATE_DIR>/workspace/SOUL.md` if it exists. Then read `groups/main/AGENTS.md`.

AGENTS.md is always loaded into the agent's context — it's the agent's continuous instructions. Not everything from SOUL.md needs to be there. Discuss with the user what belongs where:

- **In AGENTS.md (always loaded):** Core personality traits, communication style, key behavioral rules. Weave these into the existing AGENTS.md structure — adjust the opening description under the `# <Name>` heading, modify the tone in the Communication section.
- **In a separate soul file:** Detailed personality backstory, extended guidelines, creative writing style, philosophical grounding — things the agent can reference when relevant but don't need to consume context tokens on every turn.

**File placement depends on Phase 1 choice:**
- Shared personality → edit `groups/global/AGENTS.md` for the core traits, create `groups/global/soul.md` for the extended content. All groups will see both.
- Separate / main only → edit `groups/main/AGENTS.md`, create `groups/main/soul.md`.

Add a reference in the relevant AGENTS.md: "Your personality and extended behavioral guidelines are in `soul.md`. Refer to it for identity questions or when crafting responses that need your full character."

Show proposed edits to the user before applying. This is a thoughtful merge, not a copy-paste.

### USER.md

Read `<STATE_DIR>/workspace/USER.md` if it exists.

Create `groups/main/user-context.md` with the user information. Add a reference in AGENTS.md: "Information about your user is in `user-context.md`. Read it when you need context about who you're talking to."

Ask if they want any critical user facts (name, timezone, key preferences) directly in AGENTS.md for always-on awareness.

### MEMORY.md

Read `<STATE_DIR>/workspace/MEMORY.md` if it exists.

Show the contents and discuss what's worth keeping. Some memory entries may be stale or OpenClaw-specific. Create `groups/main/memories.md` for relevant items. Add a reference in AGENTS.md.

### Daily memory files (`workspace/memory/*.md`)

If DAILY_MEMORY_FILES > 0 in the discovery output, OpenClaw accumulated dated memory files (e.g. `2024-01-01.md`). These contain observations, facts, and context gathered over time.

AskUserQuestion: "You have N daily memory files from OpenClaw. How would you like to handle them?"

1. **Copy as-is (recommended for many files)** — "I'll create a `daily-memories/` folder in your group directory and copy them over. Your agent can reference them when needed."
   - Create the folder in the appropriate group directory (per Phase 1 decision)
   - Copy all `.md` files: `cp -r <workspace>/memory/*.md <group_dir>/daily-memories/`
   - Add a reference in AGENTS.md: "Historical daily memory files from your previous system are in `daily-memories/`. Refer to them when you need context about past events or observations."

2. **Consolidate into memories** — "I'll read through them, extract the durable facts, and add them to your memories file. This reduces clutter but takes longer."
   - Read each file, extract entries worth keeping (skip transient observations, focus on durable facts about the user, preferences, recurring topics)
   - Consolidate into `memories.md`
   - Use sub-agents for large volumes (>10 files)

3. **Skip** — "Don't bring daily memories over."

### OpenClaw Skills

If SKILL_COUNT > 0 in discovery, OpenClaw had custom skills. The SKILL.md format is a shared standard — skills are directly portable.

The discovery reports skill names and source locations. For each skill, read just the YAML front matter (name + description at the top of SKILL.md) and present a list to the user: skill name, description, source location. Let the user select which ones to bring over.

For confirmed skills, copy the entire skill directory as-is:

```bash
cp -r <skill_source_dir> container/skills/<skill_name>
```

After all skills are copied, a container rebuild is needed — note this for post-migration: `./container/build.sh`.

### Config-registered plugins and skills

If CONFIG_PLUGIN_COUNT > 0 in discovery, OpenClaw had installed plugins/skills with API keys (e.g. `plugins.entries.brave`, `skills.entries.openai-whisper-api`). These are functional tools the agent had access to.

For each detected plugin, present the name to the user and discuss whether to set it up in NanoClaw. Read the OpenClaw config section to understand what it is, then:

1. **If NanoClaw has a matching skill** — check the available NanoClaw skills list for an equivalent (e.g. `/add-voice-transcription` for whisper). If found, save the API key to `.env` and invoke that skill.

2. **If the OpenClaw plugin was an MCP server** — read its config to find the exact package name and command. Install the same MCP server (e.g. `pnpm dlx <exact-package-from-config>`). Don't search for or guess at MCP packages — only install what was explicitly configured.

3. **If the OpenClaw plugin was a CLI tool** — read the config to identify the exact tool. If it's an npm package, add it to the container's Dockerfile. Add a note to the group's AGENTS.md that the tool is available and how to invoke it.

4. **If the plugin wraps an API** — discuss with the user what it did and offer to implement the equivalent: save the API key to `.env`, write a container skill with instructions for using the API, or wire it into the message flow if it's something automatic (e.g. voice transcription).

5. **If unclear** — discuss with the user what the plugin did and decide together. Don't install unknown packages or search for replacements — that's a supply chain risk.

For API keys, read the config value directly (don't display raw keys) and write to `.env`. The discovery script reports which plugins have keys but never extracts them.

### Other files (TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md, AGENTS.md)

If these exist, briefly mention them and explain:
- TOOLS.md: NanoClaw agents have their own tool discovery; this doesn't transfer
- HEARTBEAT.md: NanoClaw uses scheduled tasks instead
- BOOTSTRAP.md: NanoClaw uses AGENTS.md and container skills instead
- AGENTS.md: Already covered in the Phase 1 groups discussion

## Phase 4: Channel Credentials

For each channel found in the discovery results, handle it based on NanoClaw support:

### Supported channels (whatsapp, telegram, slack, discord)

Run the credential extraction script with `--write-env .env` so it writes credentials directly to NanoClaw's `.env` file. The script never emits raw credential values to stdout — only masked versions.

First, run without `--write-env` to preview:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/extract-channel-credentials.ts --state-dir <STATE_DIR> --channel <name>
```

Parse the status block. Key fields: HAS_CREDENTIAL, CREDENTIAL_MASKED, NANOCLAW_ENV_VAR.

**If HAS_CREDENTIAL=false but the user expects a credential:** The extraction script may not recognize the config structure. Fall back to reading the channel section of `openclaw.json` directly with the Read tool and look for any field that contains a token or key value. Ask the user to confirm.

If HAS_CREDENTIAL=true: Show the masked credential (`CREDENTIAL_MASKED`). AskUserQuestion:
1. **Use this credential** — run again with `--write-env .env` to save it
2. **Enter a new one** — ask in plain text, write to `.env` manually
3. **Skip this channel** — don't configure

If using the credential:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/extract-channel-credentials.ts --state-dir <STATE_DIR> --channel <name> --write-env .env
```

The script writes the credential directly to `.env` using the correct NanoClaw variable name (e.g. `TELEGRAM_BOT_TOKEN`). Check the status block for `WRITTEN_TO` and `WRITTEN_COUNT` to confirm.

**Credential destination note:** Credentials are saved to `.env` for now. During `/setup`, the credential step will either keep them in `.env` (Apple Container) or migrate them to the OneCLI vault (Docker). The user doesn't need to worry about this now.

For Slack: there are two credentials (bot token + app token). The script handles both in one run — check `HAS_CREDENTIAL_2` and `NANOCLAW_ENV_VAR_2` in the status block.

**WhatsApp special case:** WhatsApp uses QR/pairing-code authentication, not a token. Do not copy auth state from OpenClaw — encryption sessions become stale after copying and messages fail to decrypt. Authentication will be handled during `/setup` via the `/add-whatsapp` skill (takes about 60 seconds with a pairing code). Just note that WhatsApp was configured and move on.

**Allowlist note:** If the channel had `allowFrom` or group policies, these were already handled in Phase 2 (sender allowlists). Mention that the allowlist file was created earlier.

### Unsupported channels (signal, matrix, irc, msteams, feishu, etc.)

Explain briefly: "NanoClaw doesn't have a `<channel>` integration yet, but channels are added over time via skills. Any groups from this channel were already registered in Phase 1 — they'll activate when the channel is added."

If there are credentials (tokens, keys) for the unsupported channel, offer to save them to `.env` with a descriptive variable name (e.g. `SIGNAL_ACCOUNT`, `MATRIX_ACCESS_TOKEN`) so they're available when the channel is eventually supported.

Don't invoke channel skills here — just prepare `.env` credentials. Channel code is installed during `/setup`.

## Phase 5: Scheduled Tasks

Read `<STATE_DIR>/cron/jobs.json` with the Read tool. If the file doesn't exist or has no jobs, skip this phase.

If jobs exist, read `${CLAUDE_SKILL_DIR}/MIGRATE_CRONS.md` for the full OpenClaw cron format, NanoClaw table schema, field mapping, and SQL insert template. Follow those instructions for each job.

## Phase 6: Webhooks, MCP, and Other Config

Read relevant sections from `<STATE_DIR>/openclaw.json` directly with the Read tool. This phase is fully conversational.

### MCP Servers

If MCP_SERVERS was non-empty in discovery, these can be ported. Codex supports MCP servers natively. Read the OpenClaw config's `mcp.servers` section to get each server's details (`command`, `args`, `env`, `url`).

MCP servers in NanoClaw are registered in the agent-runner source code. Before editing, grep for `mcpServers` in `container/agent-runner/src/` to find the current location — it's expected to be in `index.ts` in the `query()` options, but may have moved. For each OpenClaw MCP server the user wants to bring over:

1. Read its config: command, args, env, url
2. **stdio servers** (have `command`): Add an entry to the `mcpServers` object in `container/agent-runner/src/index.ts`. The command runs inside the container, so it needs to be available there (Node.js/npx-based servers work; custom binaries would need to be added to the Dockerfile).
3. **HTTP/SSE servers** (have `url`): These work if the URL is accessible from inside the container. Add them the same way.
4. **Environment variables**: Any `env` values that reference secrets should be added to `.env` and passed through via `process.env.*` in the mcpServers entry.

After adding all MCP servers, a container rebuild is needed: `./container/build.sh`

Show the user each server and ask which to bring over. For servers that need custom binaries not available in the container, note them for manual setup.

### Webhooks and Endpoints

If the config has webhook sections (in `cron.webhook`, `cron.failureDestination`, or channel-specific webhooks):
- Explain what they were used for
- These don't map directly but NanoClaw can be customized to support them
- Discuss the use case with the user and propose a solution if it's important to them
- For simple webhook notifications: a task script with `curl` often suffices

### Other Config

Scan the config for notable sections and briefly mention anything that doesn't carry over:
- **Exec approvals / command allowlist:** NanoClaw uses container isolation instead — the agent runs with `--dangerously-skip-permissions` inside a sandboxed container
- **Human delay:** Not applicable in NanoClaw's container model
- **Compaction:** Handled by Codex SDK automatically
- **TTS:** Not built into NanoClaw
- **Model configuration:** NanoClaw uses whatever Anthropic model the credential provides access to

Don't belabor these — just mention and move on.

## Phase 7: Summary

### Summary

Print a comprehensive summary:

**Migrated:**
- Assistant name → `.env` ASSISTANT_NAME + AGENTS.md templates updated
- Groups → registered in database, folders created with AGENTS.md templates
- Timezone → `.env` TZ
- Anthropic credential → `.env` (for setup to pick up)
- Sender allowlists → `~/.config/nanoclaw/sender-allowlist.json`
- Personality → AGENTS.md (core) + `soul.md` (extended), placed per Phase 1 decision (global or per-group)
- User context → `user-context.md`
- Memories → `memories.md` + daily memory files (copied to `daily-memories/` or consolidated)
- OpenClaw skills → copied to `container/skills/`
- Channel credentials → `.env` (list which channels)
- Scheduled tasks → inserted into database or noted for post-setup
- MCP servers → registered in agent-runner

**Noted for later:**
- Channel code installation (happens during `/setup`)
- Task creation (if deferred due to no registered group yet)
- Container rebuild needed (if skills or MCP servers were added): `./container/build.sh`

**Not applicable:**
- Unsupported channels (list them — groups registered for future)
- OpenClaw-specific features (exec approvals, human delay, TTS, model config, session reset policies, etc.)

**Discussed and deferred:**
- List any customizations agreed on but not yet implemented

Remind: "Run `/setup` next to complete your NanoClaw installation. Channel credentials are already prepared in `.env`. When setup asks which channels to enable, select the ones we configured."

## Troubleshooting

**Config parse error:** If `openclaw.json` fails to parse, it may use JSON5 features the parser doesn't handle. Ask the user to check the file for unusual syntax. As a fallback, the agent can read the file directly and work with it manually.

**Credential not found:** If a channel credential resolves to empty, it may use `source:"exec"` or `source:"file"` SecretRef. These can't be auto-extracted. Ask the user to provide the value directly.

**Multi-agent complexity:** If the user had many agents with different configs, focus on the primary/default agent first. Additional agents can be set up as separate NanoClaw groups later.
