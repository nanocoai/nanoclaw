<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

<div align="center">

### <img src="https://img.shields.io/badge/NEW!-2EB67D?style=for-the-badge" alt="NEW!" valign="middle"> Agents in Slack: one app per agent <img src="assets/slack-icon.svg" alt="" width="22" valign="middle">

With a free NanoClaw account, setup provisions each agent its own Slack app: manifest, avatar, and workspace install, no tokens to paste.
Spawn teammates from chat: every one gets its own bot identity, container, and memory, with shared rooms and canvases.

[![Quick Start](https://img.shields.io/badge/Quick%20Start%20%E2%86%92-4A154B?style=for-the-badge)](#quick-start)

</div>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one host process and no microservices of its own. Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

> [!TIP]
> Unsure whether you're ready to install? Paste this prompt into your coding agent on the computer where you'll run NanoClaw.
>
> ```text
> I want to install NanoClaw, a self-hosted assistant that runs agents in containers and connects them to messaging apps. The official repository is https://github.com/nanocoai/nanoclaw. Check whether this computer is ready to run its setup script, nanoclaw.sh. Use read-only checks.
>
> Read the requirements for my checkout, or use https://docs.nanoclaw.dev/installation if I haven't cloned it yet. Check the OS (including WSL2 on Windows), Git, Bash, Node.js, pnpm, and jq. Check whether Docker is installed and whether my user can reach its daemon.
>
> Tell me whether I'm ready to run setup, what the installer will handle, and what I need to fix first. Give the smallest next step for each blocker. Flag anything you couldn't verify.
> ```

```bash
git clone https://github.com/nanocoai/nanoclaw.git
cd nanoclaw
bash nanoclaw.sh
```

`nanoclaw.sh` walks you from a fresh machine to a named agent you can message. It:

- installs or updates Node and pnpm, and installs Docker if missing
- installs a credential gateway and offers to register your model credential with it when your runtime needs one (Claude by default, or Codex, Cursor or OpenCode if you pick one)
- fetches a prebuilt agent image or builds one locally
- pairs your first channel (Slack, Mattermost, Microsoft Teams, Telegram, Discord, WhatsApp, Dial, Signal, iMessage, or chat from the terminal)

If a wizard step fails, setup can hand it to Claude Code (or to Codex or OpenCode, if you picked one of those) to diagnose, then retry from where it broke.

<details>
<summary><strong>Migrating from NanoClaw v1?</strong></summary>

Run it from a fresh v2 checkout. Clone v2 into a separate parent folder (your v1 checkout is likely `~/nanoclaw`) and point the script at it:

```bash
mkdir -p ~/v2 && cd ~/v2
git clone https://github.com/nanocoai/nanoclaw.git
cd nanoclaw
NANOCLAW_V1_PATH=~/nanoclaw bash migrate-v2.sh
```

`migrate-v2.sh` finds your v1 install (sibling directory, or `NANOCLAW_V1_PATH=/path/to/nanoclaw`), migrates state into the v2 checkout, then `exec`s into Claude Code, if it is installed, to finish the parts that need judgment (owner seeding, shared-memory migration, fork-customisation replay).

Run the script directly, not from inside a coding agent session — the deterministic side needs interactive prompts and real shell I/O for Node/pnpm bootstrap, Docker, the credential gateway, and the container build.

**What it does:** merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders + session data + active scheduled tasks (it skips paused tasks, and tasks it cannot match to a migrated chat or whose schedule it cannot convert), installs the GitHub adapter if you select GitHub, copies channel auth state (including the Baileys keystore for WhatsApp — LID mapping is now resolved per-message by the Baileys v7 adapter, not migrated), builds or pulls the agent container.

**What it doesn't:** switch services without asking. If your v1 service is running, it asks whether to *"switch to v2"* and lets you revert. Once you keep v2, or if v1 wasn't running, it stops the v1 service and keeps its unit file or plist for rollback. On Linux it is also disabled; on macOS the plist can load it again at the next login. Your v1 files are only read.

See [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) for what's different and [docs/migration-dev.md](docs/migration-dev.md) for development notes.

</details>

## Philosophy

**Small enough to understand.** One host process and no microservices of its own. If you want to understand the full NanoClaw codebase, just ask your coding agent (Claude Code, Codex, …) to walk you through it.

**Secure by isolation.** Agents run in Linux containers and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have your coding agent modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native, hybrid by design.** The install and onboarding flow is an optimized scripted path, fast and deterministic. When a step needs judgment, whether a failed install, a guided decision, or a customization, control passes to a coding agent: setup can hand a failed step to Claude Code, Codex or OpenCode, and your coding agent runs the customization skills. Beyond setup, core ships no monitoring dashboard or debugging UI either (optional skills such as `/add-dashboard` add one): describe the problem to your coding agent and it handles it.

**Skills over features.** Trunk ships the registry and infrastructure plus a terminal channel, not chat-app adapters or alternative agent providers. Channels (Discord, Slack, Telegram, WhatsApp, …) live on a long-lived `channels` branch; alternative providers (OpenCode, Codex, Cursor) ship inside their own skill's `payload/` folder. You run `/add-telegram`, `/add-opencode`, etc. and the skill copies exactly the module(s) you need into your fork. No feature you didn't ask for.

**Best harness, best model.** By default each agent runs Claude through Anthropic's official Claude Agent SDK, so you get the latest Claude models and Claude Code's tools. Setup's runtime picker also offers Codex, Cursor and OpenCode, and skills add them later: `/add-codex` for OpenAI's Codex (ChatGPT subscription or API key), `/add-opencode` for OpenRouter, Google, DeepSeek, local OpenAI-compatible servers and more via OpenCode, and `/add-cursor` for Cursor's local Agent SDK (Cursor account or API key). Provider is configurable per agent group.

## What It Supports

- **Multi-channel messaging** — WhatsApp, WhatsApp Cloud API, Telegram, Discord, Slack, Microsoft Teams, Mattermost, Signal, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, Delta Chat, Dial (SMS and voice calls), Emacs, and email via Resend. Installed on demand with `/add-<channel>` skills. Run one or many at the same time.
- **Flexible isolation** — connect each channel to its own agent for full privacy, share one agent across many channels for unified memory with separate conversations, or fold multiple channels into a single shared session so one conversation spans many surfaces. Pick per channel via `/manage-channels`. See [docs/isolation-model.md](docs/isolation-model.md).
- **Per-agent workspace** — each agent group has its own instructions file (`CLAUDE.md`, or `AGENTS.md` for Codex and Cursor), its own memory, its own containers (one per session), and only the mounts you allow. Nothing crosses the boundary unless you wire it to.
- **Scheduled tasks**: one-off or recurring jobs executed by the agent, with optional [script gates](docs/scheduled-tasks.md) that avoid waking it when there is no work
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker containers (macOS/Linux/WSL2)
- **Credential security** — agents never hold the raw API keys kept in the gateway. Outbound requests that use the configured proxy route through a credential gateway that injects credentials at request time and can enforce per-agent policies; rate limits and other policy features depend on the gateway. Which gateway is yours to pick: setup installs [OneCLI's Agent Vault](https://github.com/onecli/onecli) by default, or Iron Proxy from its Advanced screen, behind a provider seam.
- **Agent templates**: stamp a ready-to-run agent (instructions + MCP tools + skills, no secrets) from a reusable bundle via `ncl groups create --template <ref>`. Templates load from the local `templates/` folder; populate it by hand, or let setup or an agent creating another agent fetch one from the [public library](https://github.com/nanocoai/nanoclaw-templates). See [docs/templates.md](docs/templates.md).

## Accounts and what leaves your machine

NanoClaw works without a user account. Without one, and unless you open the portal (below), the only thing it reports is setup and uninstall diagnostics: which steps ran, how long they took, whether they passed, the error message when one fails (it can include a name you typed, such as the agent's), the choices you make (runtime, channel, image source) and your setup environment (OS, WSL, Node version, whether setup runs as root, and RAM when it is low), sent to PostHog under a random per-install id. `NANOCLAW_NO_DIAGNOSTICS=1` turns those off. With or without an account, NanoClaw never sends your messages, files or API keys to us; the only part of an agent's instructions we can see is the Slack avatar excerpt listed below. Your messages do go to your model provider and to the chat apps you connect.

The account is free, and setup's default path uses it: setup asks *Enable Echo’s hardened agent image? Open the perks dashboard in your browser?* with yes as the default, and yes opens the perks dashboard, where you sign in and can enable a [prebuilt agent image](docs/hardened-image.md) (Claude runtime only). Answer no to skip the account and build the image locally; the build contacts no NanoClaw service, though it downloads the base image and packages. If you decline the sign-in, setup also builds locally. The same account unlocks the [perks](#perks) below.

What we see once you use the portal or the account:

- **Before any perk:** setup fetches the list of available perks from the portal.
- **Opening the portal**, even before you sign in: a device label (your machine's hostname and the checkout folder name).
- **Slack setup:** the agent's name. It can be sent before you sign in, and on a machine with an earlier Slack setup, before setup asks to open the portal.
- **Signing in:** your email address, a random host id, your OS, CPU type and NanoClaw version.
- **Each image pull:** the image digest and your Node and helper versions.
- **Managed Slack perk:** the app name you choose, your workspace ID, your Slack user ID, and whether the app finished installing. Our service creates the Slack app, so it handles that app's tokens; Slack messages go straight between Slack and your machine.
- **A Slack teammate an agent creates from chat:** its name, template reference, whether guests may join, and up to 300 characters of its template's description (or, without a template, its instructions) to draw its avatar. When an agent proposes several teammates at once, the name and excerpt are sent before you approve them.
- **While this checkout is registered** with the portal, the host keeps a connection to it (see [Perks](#perks)).

Nothing else about your agents reaches us.

## Perks

The free account also opens the **community portal** at [portal.nanoclaw.dev](https://portal.nanoclaw.dev),
a dashboard where you switch on what the account offers. Today that is Echo's hardened agent
image and a managed Slack app for your agent, created and installed for you with no tokens to
paste. Everything else in NanoClaw works without it.

Setup asks a yes/no question before each perk and opens the portal only if you say yes. You sign in in the browser, approve the terminal you are running setup from, and enable the perk; the wizard notices and continues on its own. Enabling Echo is where you agree to Echo's terms, including whether you want product and security email. Answer no, or decline the sign-in, and setup carries on without the perk; you can enable it later (see below).

What stays on your machine: the sign-in record and install token in `~/.config/nanoclaw/account.json`,
one device key per machine in `~/.config/nanoclaw/device-key.json`, and this checkout's journal in
`data/community-portal.json` (which perks are on, setup progress, the credentials a perk handed
you), all mode `0600`. The install token never passes through the browser: the browser sees only
the one-time sign-in code, and the token reaches this machine from the account service directly.
The host keeps one outbound connection to the portal so a perk you change in the browser reaches
the running agent; it sends nothing about your agents, messages or files.

Revisit a step with `pnpm exec tsx setup/portal.ts --stage echo` or `--stage slack`. To sign a
machine out, forget it under **Devices** in the portal: its token stops working and the host
disconnects. Files, recovery commands and troubleshooting: [docs/community-portal.md](docs/community-portal.md).

## Usage

When you connect a chat app, setup asks what to call your assistant (default: Nano). Message it directly, or @mention its bot in a group chat:

```
send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
review the git history for the past week each Friday and update the README if there's drift
every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

You can also manage its scheduled tasks from chat:
```
list my scheduled tasks
pause the Monday briefing task
```

## Customizing

NanoClaw avoids configuration sprawl. To make changes, just tell your coding agent (Claude Code, Codex, …) what you want:

- "Rename the assistant to Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that a coding agent can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add a new channel or agent provider, don't add it to trunk. New channel adapters land on the `channels` branch; a new agent provider keeps its code in its skill's `payload/` folder on `main`. Users install them in their own fork with `/add-<name>` skills, which copy the relevant module(s) into the standard paths, wire the registration, and pin dependencies.

This keeps trunk as pure registry and infra, and every fork stays lean — users get the channels and providers they asked for and nothing else.

### RFS (Request for Skills)

Propose a channel or provider skill with the [capability request form](https://github.com/nanocoai/nanoclaw/issues/new?template=capability-request.yml).

## Requirements

- macOS or Linux (Windows via WSL2)
- About 4 GB of RAM (setup warns below that)
- git (setup does not install it)
- Node.js 22.23.4+, 24.22.1+ or 26.12.1+ and pnpm 10+ (the installer will install or update both if needed)
- jq (the installer adds it if missing; channel skills use it)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) or Docker Engine (Linux)
- A coding agent that reads the repo's skills, for `/customize`, `/debug` and `/add-<channel>` skills you run yourself (setup's own channel step does not need one). The skills are written for [Claude Code](https://claude.ai/download) (`.claude/skills/`); Codex reads the same folder through `.agents/skills/`. Setup's error recovery uses Claude Code if your runtime is Claude (setup can offer to install it).

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun, the agent's provider: Claude Agent SDK by default) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. When a message arrives, the host routes it via the entity model (messaging group → agent group → session), writes it to the session's `inbound.db`, and wakes the container when the agent should answer. The agent-runner inside the container polls `inbound.db`, runs the agent, and writes responses to `outbound.db`. The host polls `outbound.db` and delivers back through the channel adapter.

Two SQLite files per session, each with exactly one writer — no cross-mount contention, no IPC, no stdin piping. Channels and alternative providers self-register at startup; trunk ships the registry and the Chat SDK bridge, while the adapters themselves are skill-installed per fork.

For the full architecture writeup see [docs/architecture.md](docs/architecture.md); for the three-level isolation model see [docs/isolation-model.md](docs/isolation-model.md).

Key files:
- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions and manages their mailboxes (`inbound.db` / `outbound.db`)
- `src/container-runner.ts` — spawns each session's agent container (plus any containers its gateway adds) through the driver in `src/drivers/`, leases the session's gateway contribution
- `src/db/` — central DB (users, roles, agent groups, messaging groups, wiring, migrations)
- `src/channels/` — channel adapter infra and the built-in terminal channel (`cli`); other adapters are installed via `/add-<channel>` skills
- `src/providers/` — host-side provider config (`claude` baked in; others via skills)
- `container/agent-runner/` — Bun agent-runner: poll loop, MCP tools, provider abstraction
- `groups/<folder>/` — per-agent-group memory and working files (its instructions file and `container.json` are rewritten at each spawn)

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and Windows via WSL2) and a mature ecosystem.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `bash nanoclaw.sh`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Your stored API keys never enter the container (Cursor's SDK does get a short-lived session token) — outbound API requests that use the proxy route through the installed credential gateway, which injects authentication at the proxy level and, depending on the gateway, can enforce access policies. Blocking all other outbound traffic is opt-in (`NANOCLAW_EGRESS_LOCKDOWN=true`; the Iron Proxy skill turns it on). Values you give an MCP server with `--env` are different: they are written to the agent's `container.json`, which the agent can read, so keep keys in the gateway. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. A few settings live in `.env`, and per-agent settings live in the database through `ncl`. Beyond those, every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell your coding agent to add them.

**Can I use third-party or open-source models?**

Yes. The supported path is `/add-opencode` (OpenRouter, OpenAI, Google, DeepSeek, a local OpenAI-compatible server, and more via OpenCode config). The provider is configurable per agent group, so different agents can run on different backends in the same install.

For one-off experiments, a Claude API-compatible HTTPS endpoint also works. Pick **Advanced** when setup starts and fill in *Anthropic API base URL* and *Anthropic auth token* (sent as a bearer token), or set them before you run setup. Setup stores the token in the credential gateway and the URL in `.env`:

```bash
NANOCLAW_ANTHROPIC_BASE_URL=https://your-api-endpoint.com \
NANOCLAW_ANTHROPIC_AUTH_TOKEN=your-token-here \
bash nanoclaw.sh
```

**How do I debug issues?**

Ask your coding agent. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If a wizard step fails, `nanoclaw.sh` can hand off to Claude Code (or to Codex or OpenCode, if you picked one of those) to diagnose and resume. If that doesn't resolve it, run the `/debug` skill in your coding agent (in Claude Code: `claude`, then `/debug`). If it identifies an issue likely to affect other users, open a PR against the relevant setup step or skill.

**How do I uninstall NanoClaw?**

```bash
bash nanoclaw.sh --uninstall
```

Every install is tagged with a per-checkout id, so the uninstaller removes only what belongs to that copy: the background service, containers and image, app data and logs, your agents' files, and the volumes and networks of this copy's gateway containers. Shared things (a OneCLI gateway and its credentials, other NanoClaw copies on the machine) are left alone. Iron Proxy runs per copy, so removing app data also deletes its stored credentials; see its [REMOVE.md](.claude/skills/add-iron-proxy/REMOVE.md) to keep them. It shows exactly what it found and asks for confirmation per group; nothing is deleted until you say yes. Use `--dry-run` to preview without changing anything, or `--yes` to skip the prompts. Your `.env` is backed up inside the checkout folder (the uninstaller prints the backup's path), so copy it out before you delete the folder to finish.

**What changes will be accepted into the codebase?**

Only bug fixes, security fixes, simplifications and code reductions will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills: channel code on the `channels` registry branch, everything else (agent providers included) as a self-contained skill. See [docs/customizing.md](docs/customizing.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
