# Remove iMessage summaries

Reverses every change `/add-imessage-summaries` made. Steps 4 and 5 need the user (sudo and System Settings).

## 1. Remove the agent instructions

In `groups/<folder>/instructions.prepend.md`, delete everything from `<!-- imessage-summaries:start -->` through `<!-- imessage-summaries:end -->`, both markers included. If the file is then empty, delete it.

## 2. Remove the mount

```bash
ncl groups config remove-mount --id <group-id> --host "$HOME/Library/Application Support/imsg-reader/outbox/<agent>" --container imsg-summaries
ncl groups restart --id <group-id>
```

## 3. Remove the allowlist root

Read `~/.config/nanoclaw/mount-allowlist.json`, drop the `~/Library/Application Support/imsg-reader/outbox` entry, keep the rest, and write it back:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '<config without the imsg-reader root>'
```

## 4. Uninstall the reader (the user runs this)

```bash
sudo .claude/skills/add-imessage-summaries/add/uninstall.sh
```

This unloads and deletes the LaunchAgent, both binaries in `/usr/local/libexec`, and `/Library/Application Support/imsg-reader` with its config.

## 5. Revoke Full Disk Access (the user does this)

System Settings > Privacy & Security > Full Disk Access: select `imsg-reader` and click **–**.

## 6. Delete summaries and builds

```bash
rm -rf "$HOME/Library/Application Support/imsg-reader"
rm -rf dist/imsg-reader
```
