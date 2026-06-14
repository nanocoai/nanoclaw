# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (Signal, Telegram, Slack, Discord, Gmail, Emacs, WhatsApp) are feature skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory. This install currently registers `signal` + `emacs` (see `src/channels/index.ts`); other channels are added via the matching `/add-*` skill.

## Canonical Paths

IMPORTANT: This project runs from /Users/Shared/, NOT from ~/. Never assume HOME-relative paths.

| What | Path |
|------|------|
| NanoClaw | /Users/Shared/nanoclaw/ |
| Memory Defender Sync | /Users/Shared/bd-brain-sync/ |
| Obsidian Vault | /Users/Shared/obsidian-vault/ |
| Sync Scripts (canonical) | /Users/Shared/bd-brain-sync/scripts/ |
| Slug Registry | /Users/Shared/bd-brain-sync/state/slug-registry.json |
| Wikilink Entities | /Users/Shared/bd-brain-sync/config/wikilink_entities.json |
| gog keyring (canonical) | /Users/Shared/Library/Application Support/gogcli/keyring/ |
| gog keyring (agent path) | /Users/Shared/nanoclaw/store/Library/Application Support/gogcli/keyring → symlink to canonical |
| gog HOME override | HOME=/Users/Shared/nanoclaw/store (agents) or HOME=/Users/Shared (sync) — both resolve to the same keyring via symlink |
| GOG_KEYRING_PASSWORD | nanoclaw |
| NanoClaw .env | /Users/Shared/nanoclaw/.env |
| LaunchAgents | ~/Library/LaunchAgents/com.nanoclaw.plist, com.bdbrain.*.plist |

When running gog commands, always prefix: `HOME=/Users/Shared/nanoclaw/store GOG_KEYRING_PASSWORD=nanoclaw` (or `HOME=/Users/Shared` — both resolve to the same keyring as of 2026-05-06).

When running sync scripts, always use the canonical path: `python3 /Users/Shared/bd-brain-sync/scripts/<script>.py`

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `groups/global/CLAUDE.md` | Global memory (main-channel-only writes; mounted read-only into every agent) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy

This install uses the **native credential proxy** (`src/credential-proxy.ts`, port 3001) — see `.claude/skills/use-native-credential-proxy/`. Containers connect to the host proxy instead of holding real keys; the proxy injects API keys (or exchanges OAuth placeholders for temp tokens) per request. OneCLI was the previous gateway and has been migrated away from — `onecli` is no longer installed and `@onecli-sh/sdk` is no longer a dependency. Disregard older docs that reference `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
