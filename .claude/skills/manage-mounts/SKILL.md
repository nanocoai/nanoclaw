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

## Add Directories

Ask which directories the user wants agents to access. For each path:
- Validate the path exists
- Ask if it should be read-only for non-main agents (default: yes)

Build the JSON config and write it:

```bash
npx tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[{"path":"/path/to/dir","readOnly":false}],"blockedPatterns":[],"nonMainReadOnly":true}'
```

Use `--force` to overwrite the existing config.

## Remove Directories

Read the current config, show it, ask which entry to remove, write the updated config.

## Reset to Empty

```bash
npx tsx setup/index.ts --step mounts --force -- --empty
```

## After Changes

Restart the service so containers pick up the new config (the unit/label names are per-install — see `setup/lib/install-slug.sh`).

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
