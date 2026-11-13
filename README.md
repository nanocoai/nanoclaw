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

With a free NanoClaw account, setup gives each agent its own Slack app: manifest, avatar, and workspace install, no tokens to paste.
Spawn teammates from chat: every one gets its own bot identity, container, and memory, with shared rooms and canvases.

[![Quick Start](https://img.shields.io/badge/Quick%20Start%20%E2%86%92-4A154B?style=for-the-badge)](#quick-start)

</div>

---

## Why I Built NanoClaw

When I started NanoClaw, [OpenClaw](https://github.com/openclaw/openclaw) was an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. It had nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security was at the application level (allowlists, pairing codes) rather than true OS-level isolation, and everything ran in one Node process with shared memory.

NanoClaw provides that same core functionality in a codebase small enough to understand: one host process, and code a coding agent can read in one pass. Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/nanocoai/nanoclaw.git
cd nanoclaw
bash nanoclaw.sh
```

`nanoclaw.sh` takes a fresh machine to an agent you can message. Along the way it:

- checks your machine and installs Node, pnpm, and Docker if they are missing (on macOS it uses Homebrew, and offers to install it; on Linux it asks for your password for `sudo`)
- builds the agent's container image, or fetches a prebuilt hardened one if you sign in to a free NanoClaw account
- installs a credential gateway and stores your model sign-in there, so agents never see it
- lets you pick the agent runtime: Claude (built in), or Codex, Cursor, or OpenCode
- starts the background service, checks that a test agent replies, and offers to connect a chat app or chat from the terminal

If a step fails, setup can hand it to Claude Code (or your runtime's own helper) to diagnose and retry. A failure before Claude is set up just stops; run `bash nanoclaw.sh` again to carry on.

This installs the newest code on `main`. `/update-nanoclaw` follows releases by default, so the first time you run it, it asks whether to keep following `main` or wait for the next release.

Step-by-step guide, including Windows: [Quickstart](https://docs.nanoclaw.dev/quickstart).

<details>
<summary><strong>Migrating from NanoClaw v1?</strong></summary>

Clone v2 next to your v1 folder and run the migration from a real terminal, not from inside a Claude session:

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh` finds v1 in a sibling folder (or set `NANOCLAW_V1_PATH=/path/to/nanoclaw`). It merges `.env`, seeds the v2 database from `registered_groups`, and copies group folders, session data, scheduled tasks, and channel sign-ins (including the WhatsApp keystore). Then it installs the credential gateway and builds the agent container. It only reads your v1 files.

If your v1 service is running, it asks before switching to v2. On yes it stops v1, starts v2, and lets you keep v2 or switch back. If you keep v2, or v1 wasn't running, it stops the v1 service and keeps its service file for rollback. On macOS that file still starts v1 at your next login, so move `~/Library/LaunchAgents/com.nanoclaw.plist` out of that folder once you're happy with v2. Last, it opens Claude Code to finish the parts that need judgment (owner seeding, shared memory, fork changes), or tells you to run `/migrate-from-v1` if Claude Code is not installed.

Guide: [Migrate from v1](https://docs.nanoclaw.dev/migrate-from-v1). Details: [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) and [docs/migration-dev.md](docs/migration-dev.md).

</details>

## Philosophy

**Small enough to understand.** One host process and no microservices of its own. If you want to understand the full codebase, ask your coding agent to walk you through it.

**Secure by isolation.** Agents run in Linux containers and can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. You make your own fork and have a coding agent change it to match yours.

**Customization = code changes.** A few settings live in `.env` and in `ncl`; for anything more, change the code. The codebase is small enough that this is safe.

**AI-native, hybrid by design.** Install and onboarding are a fast, scripted path. When a step needs judgment, such as a failed install, a guided decision, or a customization, it hands off to a coding agent. Core has no monitoring dashboard or debugging UI: describe the problem to your coding agent instead (optional dashboard skills exist).

**Skills over features.** Core ships the registries and seams, not every channel, provider, or gateway. Channel adapters live on the long-lived `channels` branch. Other agent providers and credential gateways keep their code in their skill's `payload/` folder. You run `/add-telegram`, `/add-codex`, and so on, and the skill copies in exactly what you asked for.

**Claude built in, other models as skills.** Claude runs out of the box through Anthropic's official Claude Agent SDK, with Claude Code's full toolset. `/add-codex` (OpenAI Codex), `/add-cursor` (Cursor's Agent SDK), and `/add-opencode` (OpenRouter, Google, DeepSeek, and more) add other runtimes. Each agent group picks its own.

## What It Supports

- **Chat apps.** A built-in terminal chat, plus skills for Slack, Microsoft Teams, Telegram, Discord, WhatsApp (linked device or Cloud API), Signal, iMessage, Matrix, Mattermost, Google Chat, Webex, WeChat, Delta Chat, Dial (phone calls and SMS), email via Resend, GitHub, Linear, and Emacs. Setup connects the common ones for you; the rest install with `/add-<channel>`. Run one or many at once.
- **Agent runtimes.** Claude built in; Codex, Cursor, and OpenCode as skills, chosen per agent group.
- **Credential gateways.** Agents never hold your keys. A gateway outside the container adds credentials to outbound requests and can hold a request until you approve it in chat. Setup installs OneCLI by default; Iron Proxy is the other choice under **Advanced**. Both are skills behind one gateway seam. [Gateways](https://docs.nanoclaw.dev/operate/gateways)
- **Isolation you choose.** Each agent group has its own folder, memory, and instructions, and each session runs in its own container with only the mounts you allow (`/manage-mounts`). Give each chat its own agent, share one agent across chats, or share one conversation across chats (`/manage-channels`). [docs/isolation-model.md](docs/isolation-model.md)
- **Scheduled tasks.** One-off or recurring jobs, with optional [gate scripts](https://docs.nanoclaw.dev/guides/scheduled-tasks) that skip waking the agent when there is no work.
- **Web access.** Search and fetch, plus a headless Chromium browser in the agent image.
- **Agent templates.** `ncl groups create --template <ref>` stamps a ready-to-run agent (instructions, MCP tools, and skills, no secrets) from the local `templates/` folder. Setup, and an agent creating another agent, can also fetch one from the [public library](https://github.com/nanocoai/nanoclaw-templates). [Templates](https://docs.nanoclaw.dev/templates/overview)

## Accounts and what leaves your machine

NanoClaw works without an account.

**Setup diagnostics.** Setup sends anonymous events (which steps ran, how they ended, your platform) to PostHog under a random install id. To turn them off, run `export NANOCLAW_NO_DIAGNOSTICS=1` before `bash nanoclaw.sh`.

**Your model and chat apps.** Your messages and files go to the model provider and chat apps you connect, not to NanoClaw.

**Optional free account.** Signing in to the [community portal](https://portal.nanoclaw.dev) switches on perks: Echo's prebuilt hardened agent image (Claude runtime only) and a managed Slack app for each agent. Setup asks before each one, then opens the portal in your browser. The account sends:

- your email address
- a random host id with your OS and CPU type, at sign-in and on every image pull
- your NanoClaw version at sign-in; the image digest, Node version, and helper version on each pull
- a device label (`<hostname> · <folder name>`)
- for Slack, the agent's name, your workspace, your Slack user id, and your NanoClaw version; for a teammate made from chat, also its template and the app that made it; and up to 300 characters of its instructions (or its template's description) to draw its avatar

While signed in, the host stays connected to portal.nanoclaw.dev so perk changes reach it. It sends nothing about your agents, messages, or files. Building the image yourself needs no account and contacts no NanoClaw service (the build still downloads its base image and packages).

The sign-in record, device key, and perk state live in `~/.config/nanoclaw/` and `data/community-portal.json`, mode `0600`. Revisit a perk with `pnpm exec tsx setup/portal.ts --stage echo` (or `--stage slack`). Sign out with `pnpm exec tsx setup/index.ts --step registry -- --logout`. Details: [docs/community-portal.md](docs/community-portal.md) and [docs/hardened-image.md](docs/hardened-image.md).

## Usage

Message your agent in a direct message, or @mention its bot in a group. When you connect a chat app, setup asks what to call the agent (default: Nano).

Ask in plain words:

```
Send me an overview of the sales pipeline every weekday at 9am
Every Monday at 8am, compile AI news from Hacker News and TechCrunch and send me a briefing
Pause the Monday briefing
```

To give an agent a folder on your computer (say, an Obsidian vault), allow the folder with `/manage-mounts`, then mount it with `ncl groups config add-mount --id <group-id> --host <path> --container <name>` and `ncl groups restart --id <group-id>`. The agent sees it at `/workspace/extra/<name>`, so `<name>` is relative, not a full path. To add the agent to another chat, invite its bot there and mention it: on most apps you then get a card to connect it, start a new agent for that chat, or reject it. Where that doesn't work (for example WhatsApp on a shared number), wire the chat with `/manage-channels`.

On the host, `ncl` manages groups, tasks, wirings, and roles, for example `ncl status`, `ncl groups list`, and `ncl tasks list`. Setup links it into `~/.local/bin`; if that folder isn't on your PATH, run it from the checkout instead (`pnpm run ncl status`). [ncl reference](https://docs.nanoclaw.dev/reference/ncl-cli)

## Customizing

There are two places to change things:

- **In chat, with your agent:** standing instructions ("keep replies short"), memory, and recurring tasks. Agents can also ask to install packages or add MCP servers; an admin approves each request.
- **In code, with a coding agent:** open the checkout in Claude Code, Codex, or another coding agent (`AGENTS.md` and `.agents/skills` point at the same files as `CLAUDE.md` and `.claude/skills`) and say what you want. Run `/customize` for guided changes.

Settings that aren't code live in `.env` and in the database through `ncl`, for example `ncl groups config update --id <group-id> --provider codex`. [Customize an agent](https://docs.nanoclaw.dev/guides/customize-an-agent)

## Contributing

**Don't add features. Add skills.**

Core accepts bug fixes, security fixes, simplifications, and less code. New channels, providers, gateways, and tools ship as skills: channel adapters land on the `channels` branch; providers and gateways keep their code in the skill's `payload/` folder; tools keep theirs in the skill folder itself. Users install them in their own fork with `/add-<name>`, which copies the code into place, wires the registration, and pins dependencies. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a PR.

Want a skill that doesn't exist yet? Search the open issues, then open a [capability or skill request](https://github.com/nanocoai/nanoclaw/issues/new?template=capability-request.yml).

## Requirements

- macOS or Linux (Windows through WSL2)
- About 4 GB of RAM or more (setup warns below that)
- Node.js 22.23.4+, 24.22.1+, or 26.12.1+, and pnpm 10 (setup installs them if missing: Node through Homebrew on macOS or NodeSource on Debian and Ubuntu)
- jq, which the channel skills use (setup installs it if missing)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS, Windows) or Docker Engine (Linux); setup can install it
- An account with your model provider: Claude (subscription or API key), or the provider you add
- [Claude Code](https://claude.ai/download) is optional. Setup installs it when you choose Claude subscription sign-in or ask it to diagnose a failure. Skills that setup doesn't run for you (`/customize`, `/debug`, most `/add-<name>`) run inside a coding agent.

## Architecture

```
chat apps → host (router) → inbound.db → agent container → outbound.db → host (delivery) → chat apps
```

One Node host process routes each incoming message from its messaging group to every wired agent group, and from there to a session. It writes the message to that session's `inbound.db` and wakes its container. The agent runner (Bun) inside the container polls `inbound.db`, runs the agent, and writes replies to `outbound.db`, which the host polls and delivers. Each file has exactly one writer: no IPC, no stdin piping.

Core is registries and seams. Channels, agent providers, credential gateways, the container runtime (Docker today), and the session mailbox all self-register at startup, and skills add more.

Key paths:

- `src/` — the host: routing (`router.ts`), delivery (`delivery.ts`), sessions and containers (`session-manager.ts`, `container-runner.ts`), the 60-second sweep (`host-sweep.ts`), the central DB (`db/`), and `ncl` (`cli/`)
- `src/channels/`, `src/providers/`, `src/gateway-providers/`, `src/drivers/` — the seams (the terminal channel and Claude are built in)
- `container/agent-runner/` — the Bun agent runner: poll loop, MCP tools, providers
- `setup/` — the install wizard
- `groups/<folder>/` — each agent group's files: memory and `instructions.prepend.md`; the agent's `CLAUDE.md` (`AGENTS.md` for Codex and Cursor) is rebuilt at every container start
- `.claude/skills/` — skills

More: [Architecture](https://docs.nanoclaw.dev/concepts/architecture).

## FAQ

**Is this secure?**

Agents run in containers and see only what you mount. The container's environment is built from scratch: `.env` is not passed in, and credential-shaped values are refused. Keep keys in the gateway, not in an MCP server's `--env`: those values land in the agent's own config, where it can read them. Outbound API calls go through the installed credential gateway, which adds credentials outside the container and can hold a request until you approve it. For a hard network fence, set `NANOCLAW_EGRESS_LOCKDOWN=true` so the gateway is the only way out (Iron Proxy setup turns it on). You should still review what you run, and the codebase is small enough that you can. See the [security model](docs/SECURITY.md).

**Why Docker?**

It works the same on macOS, Linux, and Windows (WSL2), with a mature ecosystem. Docker is the only container runtime that ships today; the runtime sits behind a driver seam.

**Can I use other models?**

Yes. Add a runtime skill (`/add-opencode` for OpenRouter, OpenAI, Google, DeepSeek, and more; `/add-codex`; `/add-cursor`) and pick it per agent group. For any Claude API-compatible endpoint, choose **Advanced** in setup and fill in *Anthropic API base URL* and *Anthropic auth token*; the token is stored in the gateway, not in `.env`.

**How do I debug issues?**

Ask your coding agent in the checkout: "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" Or run `/debug`.

**Why isn't setup working for me?**

When a step fails, setup can hand it to Claude Code to diagnose and retry. Running `bash nanoclaw.sh` again is safe: it keeps your install and carries on. Still stuck? Run `/debug` in your coding agent. If you find an issue likely to affect other users, open a PR against the setup step or skill.

**How do I uninstall NanoClaw?**

```bash
bash nanoclaw.sh --uninstall
```

Every install is tagged with a per-checkout id, so the uninstaller removes only what belongs to that copy: the background service, containers and image, app data and logs, your agents' files, and gateway services labelled with this copy's id (with their data, including any credentials stored in them). A gateway installed for the whole machine, such as OneCLI's default install in `~/.onecli`, keeps its credentials, and other NanoClaw copies are left alone. It shows what it found and asks per group; nothing is deleted until you say yes. Use `--dry-run` to preview, or `--yes` to skip the prompts. Your `.env` is backed up inside the folder (the uninstaller prints the backup's name), so copy it out before you delete the folder. [Uninstall](https://docs.nanoclaw.dev/operate/uninstall)

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42) or ask in [GitHub Discussions](https://github.com/nanocoai/nanoclaw/discussions).

## Security

Found a vulnerability? [Report it privately](https://github.com/nanocoai/nanoclaw/security/advisories/new), not in a public issue. See [SECURITY.md](SECURITY.md).

## Changelog

Releases use calendar versions (`vYYYY.MM.N`, for example `v2026.10.0`). See [CHANGELOG.md](CHANGELOG.md), including each release's *Before you update* notes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

[MIT](LICENSE)

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
