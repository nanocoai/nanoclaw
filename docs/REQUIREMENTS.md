# NanoClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

NanoClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

### Built for the Individual User

This isn't a framework or a platform. It's software that fits each user's exact needs. You fork the repo, add the channels you want (WhatsApp, Telegram, Discord, Slack, Gmail), and end up with clean code that does exactly what you need.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Claude Code guides the setup. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd like to see contributed:

### Communication Channels

None currently — Signal and Matrix have since shipped as skills.

> **Note:** Telegram, Slack, Discord, Gmail, Signal, and Matrix skills already exist. See the [skills documentation](https://docs.nanoclaw.dev/integrations/skills-system) for the full list.

---

## Vision

A personal AI assistant accessible via messaging, with minimal custom code.

**Core components:**
- **Claude Agent SDK** as the core agent
- **Containers** for isolated agent execution (Docker)
- **Multi-channel messaging** (WhatsApp, Telegram, Discord, Slack, Gmail) — add exactly the channels you need
- **Persistent memory** per conversation and globally
- **Scheduled tasks** executed by the agent, which can message back
- **Web access** for search and browsing
- **Browser automation** via agent-browser

**Implementation approach:**
- Use existing tools (channel libraries, Claude Agent SDK, MCP servers)
- Minimal glue code
- File-based systems where possible (CLAUDE.md for memory, folders for groups)

---

## Architecture Decisions

### Message Routing
- A router listens to connected channels and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all groups, but only writable from "main" (self-chat)
- **Files**: Groups can create/read files in their folder and reference them
- Agent runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each group maintains a conversation session (via Claude Agent SDK)
- Sessions auto-compact when context gets too long, preserving critical information

### Container Isolation
- All agents run inside Docker containers
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation - agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser with Chromium in the container

### Scheduled Tasks
- Users can ask the agent to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered in SQLite (via the main channel or IPC `register_group` command)
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`groups/CLAUDE.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure additional directory mounts for any group

---

## Integration Points

### Channels
- WhatsApp (baileys), Telegram (grammy), Discord (discord.js), Slack (@slack/bolt), Gmail (googleapis)
- Each channel lives in a separate fork repo and is added via skills (e.g., `/add-whatsapp`, `/add-telegram`)
- Messages stored in SQLite, polled by router
- Channels self-register at startup — unconfigured channels are skipped with a warning

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- `ncl tasks` provides scheduling commands
- Commands: `list`, `get`, `create`, `update`, `cancel`, `pause`, `resume`, `delete`, `run`, `append-log`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute in the agent group's system session

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via Claude Code
- Users clone the repo and run Claude Code to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, configure channels, start services
- `/customize` - General-purpose skill for adding capabilities
- `/update-nanoclaw` - Pull upstream changes, merge with customizations

### Deployment
- Runs on macOS (launchd), Linux (systemd), or Windows (WSL2)
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**NanoClaw** - A reference to Clawdbot (now OpenClaw).
