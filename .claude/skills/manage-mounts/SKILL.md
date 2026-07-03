---
name: manage-mounts
description: Configure which host directories agent containers can access. View, add, or remove mount allowlist entries. Triggers on "mounts", "mount allowlist", "agent access to directories", "container mounts".
---

# Manage Mounts

Configure which host directories NanoClaw agent containers can access. The mount allowlist lives at `~/.config/nanoclaw/mount-allowlist.json`.

## Show Current Config

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null || echo "No mount allowlist configured"
```

Show the current config to the user in a readable format: which directories are allowed, whether non-main agents are read-only.

## Built-in Host-Managed Mounts (Informational)

Every agent container also gets these host-managed mounts wired by NanoClaw itself. They are NOT in the allowlist file and cannot be removed via this skill — they're part of the runtime contract:

| Container path | Source | Mode | Purpose |
|---|---|---|---|
| `/workspace` | `data/v2-sessions/<session-id>/` | RW | Session DBs (`inbound.db`, `outbound.db`), heartbeat, working files |
| `/workspace/agent` | `groups/<folder>/` | RW | Per-group memory (`CLAUDE.local.md`), agent's working dir |
| `/workspace/agent/container.json` | `groups/<folder>/container.json` | RO | Per-group config the runner reads at startup |
| `/workspace/skill-data` | `data/v2-sessions/<group-id>/skill-data/` | RW | Per-group persistent skill state, survives restarts |
| `/home/node/.claude` | `data/v2-sessions/<group-id>/.claude-shared/` | RW | Claude Code state (settings.json, plugins/, skill symlinks) |
| `/workspace/global` | `groups/global/` | RO | Cross-group shared memory (if present) |
| `/app/skills` | `container/skills/` | RO | Shared skill source — symlinks in `~/.claude/skills/` point here |
| `/app/src` | `container/agent-runner/src/` | RO | Agent-runner source code |

When auditing the per-group write surface, list these alongside the operator-allowlist mounts. Anything writable inside a container is one of: a per-session/per-group host-managed dir (above), or an entry from `~/.config/nanoclaw/mount-allowlist.json`.

## Add Directories

Ask which directories the user wants agents to access. For each path:
- Validate the path exists
- Ask if it should be read-only for non-main agents (default: yes)

Build the JSON config and write it:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[{"path":"/path/to/dir","readOnly":false}],"blockedPatterns":[],"nonMainReadOnly":true}'
```

Use `--force` to overwrite the existing config.

## Remove Directories

Read the current config, show it, ask which entry to remove, then write the updated config through the same write path (build the trimmed JSON and pass it to `--step mounts --force -- --json`):

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[],"blockedPatterns":[],"nonMainReadOnly":true}'
```

## Reset to Empty

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --empty
```

## After Changes

Restart the service so containers pick up the new config (the unit/label names are per-install — see `setup/lib/install-slug.sh`).

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
