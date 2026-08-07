# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- **Agent-to-agent messaging no longer loses to Claude Code's built-in `SendMessage`.** That built-in addresses the SDK's own in-session subagents, so an agent that had just run `create_agent` reached for it by name and got `No agent named 'x' is currently addressable` — reading as "the group was never provisioned" while `mcp__nanoclaw__send_message` (the real path) was never called. `SendMessage` joins `AskUserQuestion` in `SDK_DISALLOWED_TOOLS`, so the PreToolUse hook now blocks it and points at the nanoclaw equivalent.
- [BREAKING] **Existing Claude installs should review the hardened agent image.** Local builds remain supported, but the Echo-built image is recommended for patched sandbox components. **Migration:** follow [the hardened-image guide](docs/hardened-image.md) to detect your current image source, switch, verify, or roll back.
- **Release publication tolerates GitHub API propagation.** The Release workflow now retries bounded post-publication read-backs when the new Release is not listed yet or its immutable state is not visible yet. Exact title, body, tag, or SHA mismatches still fail immediately.

## [2.1.54] - 2026-08-01

Rollup release covering v2.1.18 through v2.1.54 — everything merged since the v2.1.17 tag.

- [BREAKING] **iMessage unified into one `imessage` channel with two backends via `/add-imessage`:** Local (this Mac's `chat.db` via the Chat SDK) or Hosted (native [Photon](https://photon.codes) via `spectrum-ts`, no Mac relay). Backend chosen at install or via `IMESSAGE_BACKEND=local|hosted`. The legacy Chat-SDK remote mode (`IMESSAGE_SERVER_URL`/`IMESSAGE_API_KEY`) and the separate `imessage-cloud` channel + `/add-imessage-cloud` skill are **removed**. See [docs/imessage.md](.claude/skills/add-imessage/docs.md).
- [BREAKING] **Provider-agnostic memory.** All providers now share one OKF v0.1-compatible `memory/` tree, while persona lives in `instructions.prepend.md`; startup, clear, and compact reload memory automatically. Existing groups with legacy memory must run `/migrate-memory` before use. See [memory](docs/memory.md) and [provider migration](docs/provider-migration.md).
- **New groups can inherit an instance-wide default provider.** `DEFAULT_AGENT_PROVIDER` sets the provider used when a new agent group is created without an explicit provider. Each group's stored provider still overrides it, and existing groups are unchanged.
- [BREAKING] **Channel install skills are now the single source of truth.** The setup wizard installs channels by applying the same `/add-<channel>` SKILL.md a coding agent would follow — a deterministic engine executes the skill's mechanical steps directly from the document, so wizard and skill cannot drift, and anything the engine cannot do falls back to an agent reading the prose. **Migration:** the bespoke non-interactive channel installers (`setup/add-<channel>.sh`, `setup/install-<channel>.sh`) and per-channel wizard flows (`setup/channels/<channel>.ts`) are deleted. Anything that invoked them should apply the skill instead: interactively via `/add-<channel>` or the setup wizard, or programmatically via [skill directives](docs/skill-directives.md).
- **One guard for privileged actions.** Every privileged action crossing the container or channel boundary now passes through `guard()` before execution: `allow`, `hold`, or `deny`. Approved replays carry the approval row as a grant and re-run checks against current state; forged, consumed, mismatched, or newly unauthorized grants fail closed. Guarded delivery actions can no longer be re-registered without their guard specification.
- [BREAKING] **`whatsapp-formatting` and `slack-formatting` moved from trunk to the `channels` branch.** They now install with their channel, so installations without those channels no longer carry channel-specific formatting instructions in every agent's context. **Migration — only if the channel is installed:** re-run `/add-whatsapp` or `/add-slack` after updating. Do not run an add-skill preemptively; it installs the full adapter.
- [BREAKING] **Scheduled tasks moved from MCP tools to `ncl tasks`.** Agents and operators now manage tasks with `ncl tasks list/get/create/update/cancel/pause/resume/delete/run/append-log`; task sessions are isolated from the chat session that created them. **Migration:** follow [the scheduled-task migration guide](docs/ncl-tasks-migration.md).
- [BREAKING] **Task delivery is explicit and uses one door.** Every `send_message` and `send_file` call requires a named `to` destination; task-session final output becomes the run summary, while only explicitly addressed tool calls deliver. **Migration:** rebuild the agent image, restart NanoClaw, update custom instructions that omit `to`, and clear or compact existing sessions. Failed pre-task scripts now back their recurring series off and auto-pause after eight consecutive failures instead of spinning.
- [BREAKING] **Chat SDK and channel adapters are pinned to `4.29.0`.** The bridge and adapter must use the same `ChatInstance` type, so exact pins replace caret ranges. Core installations without a channel are unaffected. **Migration:** if a channel is installed, re-run its `/add-<channel>` skill after updating.
- **Hardened agent images are available as an opt-in setup path.** A digest-pinned, multi-architecture image can be fetched from the NanoClaw registry and retagged to the same local name used by builds; architecture, lockfile, provenance, size, and optional publisher-signature checks fail closed. Local builds remain the default and require no account. See [hardened images](docs/hardened-image.md).
- **Agent containers now start with safer defaults.** New spawns always drop all Linux capabilities, set `no-new-privileges`, and use Docker's init process; these controls have no per-group override. A PID limit defaults to 2048 and can be changed installation-wide with `CONTAINER_PIDS_LIMIT` (`0` disables it). The Vercel CLI is now opt-in instead of being baked into every image.
- **Agent containers can have installation-wide resource caps.** `CONTAINER_CPU_LIMIT` and `CONTAINER_MEMORY_LIMIT` pass `--cpus` and `--memory` to Docker for every agent container. Both remain empty by default, so existing installations keep their current behavior.
- **Per-agent-group timezones.** `ncl groups config update --timezone <IANA>` overrides the install timezone for that group's scheduling, run-log display, and container `TZ`; `""` clears the override. Host-side operator display remains in the install timezone.
- **Agent templates and reusable skills expanded.** Local templates can stamp persona, context, MCP configuration, and skills through `ncl groups create --template`; templates can also seed scheduled tasks and timezone. `/learn` distills a reusable skill from an existing workflow, and `/add-clidash` installs a read-only CLI-derived dashboard.
- **A clearer, safer `ncl` control plane.** Verbs now declare and validate their arguments, generate deep help, preserve dashed IDs, render human-readable output on the host, and flush large responses before exit. Creating groups and wirings now provisions their required companion rows transactionally, fixing first-spawn failures and silently dropped replies.
- **Approval and agent-to-agent controls are more expressive.** Connected agents can require per-message approval; rejection reasons reach the requester; OneCLI approval cards use the gateway's structured summary; and shared-channel cards retain who approved or rejected an action.
- **Delivery and provider failures stop disappearing.** Missing adapters route messages into retry instead of marking them delivered, agent image builds no longer block the host, and Claude rate-limit telemetry only aborts a turn when the SDK reports a rejection. Billing exhaustion and transient rate limits remain distinct.
- **Setup and update recovery improved.** Setup can parse wrapped Claude OAuth captures, offer Slack Socket Mode, and reap dead peer-service registrations. Re-applying an updated skill rebuilds the container when needed, and a missing session folder is re-provisioned so the documented reset path works.
- **Security fixes.** Inbox attachment writes reject symlink escapes, approved CLI calls preserve the original caller context, command-gate checks no longer fail open, mount allowlists honor `readOnly`, and stale v1 secret/config mirrors were removed.
- Documentation was refreshed across architecture, database schemas, security boundaries, provider configuration, SDK behavior, skills, and registry-branch maintenance. A Korean README is now available.

## [2.1.17] - 2026-06-17

Rollup release covering v2.1.1 through v2.1.17 — every `package.json` bump merged since the v2.1.0 tag. This section restores the changelog entry from the already-published [v2.1.17 GitHub Release](https://github.com/nanocoai/nanoclaw/releases/tag/v2.1.17).

- [BREAKING] **`@onecli-sh/sdk` 0.5.0 → 2.2.1 requires a OneCLI server with the `/v1` API.** Older servers return 404 for every SDK call. The sanctioned gateway and CLI versions are pinned in `versions.json`, and the `onecli` setup step enforces them. **Migration:** `/update-nanoclaw` upgrades the gateway when its pin moves; otherwise follow [the OneCLI upgrade guide](docs/onecli-upgrades.md).
- **New Codex agent provider.** Run `/add-codex` to install the `codex app-server` provider from the `providers` branch. Authentication remains vault-only; no credential enters a container.
- **Setup can select, install, and authenticate a non-default agent provider.** The selected provider is stored on the first agent before its first spawn. Picking the default Claude provider changes nothing.
- **Provider choice is explicit per group.** Change it with `ncl groups config update --provider`, then restart the group.
- **Provider memory moves through `/migrate-memory`.** Runtime does not copy provider-owned stores automatically; follow [the provider migration guide](docs/provider-migration.md).
- **`/update-nanoclaw` upgrades the OneCLI gateway when its sanctioned pin moves.** Hosts whose gateway pin did not change are unaffected.
- **Budget and billing errors reach the user.** Non-retryable provider errors without message wrapping are delivered to the originating channel instead of entering a silent retry loop.
- **Command-gate denials reach the sender.** Host-side outbound writes now use the read-write opener, fixing a `SQLITE_READONLY` failure that silently dropped denial responses.
- **Slash commands interrupt an in-flight turn.** Runner-handled commands such as `/clear`, `/compact`, and `/cost` no longer wait for the current turn to finish.
- **Container boot failures say why.** A stderr tail is logged at warning level when a container exits non-zero instead of disappearing below the default log level.
- **Opt-in egress lockdown.** Containers can fail closed against a configured outbound allowlist. See [the security model](docs/SECURITY.md#5-egress-lockdown-forced-proxy).
- **Channel instances are first-class.** One channel kind can run multiple independent instances with separate credentials, Chat SDK state, and webhook routes; existing single-instance installs remain compatible.
- **Native uninstaller.** `bash uninstall.sh` or `nanoclaw.sh --uninstall` removes the service, data directory, host registration, and OneCLI agent registration for that installation. Dry-run and confirmation modes are included.
- **Interactive setup handoffs preserve context.** Failure and `?` handoffs now provide the context as Claude's first user prompt and retain one session across handoffs.
- **Raw webhook route registry.** Channels can register HTTP routes without editing the host route table.
- **Typed delivery-action and approval-resolved registries.** Channels can expose delivery actions and receive approval-resolution callbacks without channel-specific branching at the host call site.
- **Provider-owned per-exchange archiving.** The agent runner exposes `onExchangeComplete`; providers opt into their own archival behavior.
- [security] **A2A attachment resolution rejects symlink escapes** from the per-group sandbox.
- [security] **Approval responses require an authorized admin** whose scope covers the request's group.
- [security] **Agent creation is authorized on the host** as well as the API edge; confined groups require host-side approval.
- `host-sweep` respects a per-group wake grace instead of tearing down a container that just woke with a stale processing claim.
- Global container CLI installs are data-driven through `container/cli-tools.json`; `agent-browser` is pinned to `0.27.1`.
- Four v1-only skills were retired: `claw`, `x-integration`, `add-parallel`, and `convert-to-apple-container`.
- The skills installation model is documented in [the skills model](docs/skills-model.md), and twelve skills were updated to the current contract.
- An Ollama prompt-cache guide was added for the Claude Code → Ollama path. See [Ollama](docs/ollama.md).
- Resolved approval and question cards in shared channels retain the acting user's name.
- `@anthropic-ai/claude-code` and `@anthropic-ai/claude-agent-sdk` were updated to `2.1.170` and `0.3.170`.

## [2.1.0] - 2026-06-07

- [BREAKING] **Startup now requires an upgrade marker.** The host refuses to boot unless `data/upgrade-state.json` records that this install reached the current version through a sanctioned path (`/setup`, `/update-nanoclaw`, `/migrate-nanoclaw`). After this update completes — and before restarting the service — stamp the marker by running `pnpm exec tsx scripts/upgrade-state.ts set`. If the host has already tripped on restart with "update did not go through the supported path", that same command clears it. See [docs/upgrade-recovery.md](docs/upgrade-recovery.md).

## [2.0.64] - 2026-05-18

- **`ncl destinations add` and `remove` through the approval flow now reach the receiver immediately.** Approved destinations weren't being projected into the receiving agent's local session state, so a freshly-added destination silently failed at `send_message` with `unknown destination`, and a removed destination stayed resolvable until the next container restart. Both now take effect the moment the approval executes. Direct (non-approval) calls were unaffected.

## [2.0.63] - 2026-05-15

Rollup release covering v2.0.55 through v2.0.63 — everything merged since the v2.0.54 tag. Starting with this release, the goal is to publish a GitHub Release for every `package.json` version bump that lands on `main`; see [RELEASING.md](RELEASING.md).

- [BREAKING] **Service names are now per-install.** On v2 installs the launchd label and systemd unit are slugged to your project root: `com.nanoclaw.<sha1(projectRoot)[:8]>` and `nanoclaw-<slug>.service`. The old `com.nanoclaw` / `nanoclaw.service` names no longer match a real service — update any copy-pasted restart or status commands. Find your install's names with `source setup/lib/install-slug.sh && launchd_label` (macOS) or `systemd_unit` (Linux). The `ncl` transport-error help text and 26 skill files now use the canonical helper-driven pattern; see [setup/lib/install-slug.sh](setup/lib/install-slug.sh).
- **Compaction destination reminder placement fixed.** The reminder injected after SDK auto-compaction now appears at the end of the compaction summary so it isn't stripped during truncation. Replaces the placement shipped in v2.0.54.
- **Stronger message-wrapping enforcement.** The poll loop nudges the agent when its output lacks `<message>` wrapping, and `CLAUDE.md` core instructions now require wrapping even for single-destination agents. The welcome flow no longer double-greets.
- **OneCLI credentials after MCP install.** MCP servers added through `add_mcp_server` now inherit OneCLI gateway routing — fixes the case where the agent kept asking for API keys after installing a new server.
- **CLI scope hardening.** `scopeField` now fails closed when scope is missing, and `sessions get` is guarded against cross-group oracle access from group-scoped agents.
- **gmail/gcal skills aligned with v2.** `/add-gmail-tool` and `/add-gcal-tool` now reflect the v2 container-config model — DB-backed mounts, no dead `TOOL_ALLOWLIST` edits, no `container.json` writes that get clobbered on next spawn. Manual sqlite3/JSON1 invocations corrected.
- **Repo-rename cleanup.** Remaining `qwibitai/nanoclaw` references swept to `nanocoai/nanoclaw` across code and docs; CI workflow guards updated so they no longer no-op after the rename.
- Slack scope checklist now includes `files:read` and `files:write` for skills that read or post attachments.
- The internal-tag description in destination instructions no longer mentions scratchpads (which confused agents into routing them incorrectly).
- Container startup is now graceful when the `on_wake` column is missing on older sessions DBs.

## [2.0.54] - 2026-05-10

- **Per-group model and effort overrides.** Agent groups can now run a specific Claude model and effort level, set via `ncl groups config update --model <model> --effort <level>`. Defaults to the host-configured model when unset.
- **Claude Code 2.1.128.** Container claude-code bumped from 2.1.116 to 2.1.128.
- CLI help text improvements for `ncl groups config` and `ncl groups restart`.

## [2.0.48] - 2026-05-09

- **Container config moved to DB.** Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, skills) now lives in the `container_configs` table instead of `groups/<folder>/container.json`. Existing filesystem configs are backfilled automatically on startup. Managed via `ncl groups config get/update` and `config add-mcp-server/remove-mcp-server/add-package/remove-package`.
- **Explicit restart with on-wake messages.** Config CLI operations no longer auto-kill containers. New `ncl groups restart` command with `--rebuild` and `--message` flags. On-wake messages (`on_wake` column on `messages_in`) are only picked up by a fresh container's first poll, preventing dying containers from stealing them during the SIGTERM grace period. Self-mod approval handlers (`install_packages`, `add_mcp_server`) use the same race-free mechanism.
- **Per-group CLI scope.** New `cli_scope` setting on container config (`disabled` / `group` / `global`, default `group`). Controls what the agent can access via `ncl` from inside the container. `disabled` excludes CLI instructions from CLAUDE.md and blocks all requests. `group` (default) restricts to own-group resources with auto-filled args. `global` gives unrestricted access (set automatically for owner agent groups). Includes post-handler result filtering to prevent cross-group data leaks and blocks `cli_scope` escalation from group-scoped agents.

## [2.0.45] - 2026-05-08

- **Admin CLI (`ncl`).** New `ncl` command for querying and modifying the central DB — agent groups, messaging groups, wirings, users, roles, members, destinations, sessions, approvals, and dropped messages. Host-side transport via Unix socket; container-side transport via session DB. Write operations from inside containers go through the approval flow. `list` supports column filtering and `--limit`. Run `ncl help` for usage.
- **v1 → v2 migration.** Run `bash migrate-v2.sh` from the v2 checkout. Finds your v1 install (sibling directory or `NANOCLAW_V1_PATH`), merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders (`CLAUDE.md` → `CLAUDE.local.md`), copies session data with conversation continuity, ports scheduled tasks, interactively selects and installs channels (clack multiselect), copies container skills, builds the agent container, and offers a service switchover to test. Hands off to Claude (`/migrate-from-v1`) for owner seeding, access policy, CLAUDE.md cleanup, and fork customization porting. See [docs/migration-dev.md](docs/migration-dev.md) and [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md).

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
