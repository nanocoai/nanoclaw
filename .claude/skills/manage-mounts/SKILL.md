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

Show the current config to the user in a readable format: which directories are allowed, and whether each is read-only or read-write.

## Add Directories

Ask which directories the user wants agents to access. For each path:
- Validate the path exists
- Ask if it should be read-write (`allowReadWrite: true`) or read-only (`allowReadWrite: false`, the safer default)

Build the JSON config and write it:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[{"path":"/path/to/dir","allowReadWrite":true}],"blockedPatterns":[]}'
```

Use `--force` to overwrite the existing config.

## Remove Directories

Read the current config, show it, ask which entry to remove, then write the updated config through the same write path (build the trimmed JSON and pass it to `--step mounts --force -- --json`):

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[],"blockedPatterns":[]}'
```

## Reset to Empty

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --empty
```

## After Changes

The allowlist is read fresh when a container is spawned, so new mounts apply to newly spawned containers automatically — no service restart needed.

To apply the new config to a group that already has a running container, restart just that group:

```bash
ncl groups restart --id <group-id>
```
