# Remove Remote Storage

Reverses everything `/add-remote-storage` set up for a given mount `{name}`. Repeat for each mount being removed.

## 1. Unassign from all agent groups

Find which groups reference the mount, then remove the assignment from each:

```bash
ncl groups list
ncl groups config get --id {group-id}   # check additional_mounts for /mnt/nanoclaw/{name}
ncl groups config remove-mount --id {group-id} --host-path /mnt/nanoclaw/{name}
ncl groups restart --id {group-id}      # only if the group has a running container
```

## 2. Remove the allowlist entry

Read `~/.config/nanoclaw/mount-allowlist.json`, drop the `/mnt/nanoclaw/{name}` entry from `allowedRoots` while preserving everything else, and write the trimmed document back:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[...remaining roots...],"blockedPatterns":[...existing...]}'
```

If this was the only entry, write the empty config instead:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --empty
```

## 3. Stop and remove the systemd unit

Before stopping, check the VFS cache for writes that have not reached the remote — stopping with dirty data queued loses those uploads:

```bash
grep -rl '"Dirty": *true' {home}/.cache/rclone/vfsMeta/nanoclaw-{name} 2>/dev/null | wc -l   # expect 0
```

If non-zero, leave the mount up until rclone flushes (watch `journalctl -u nanoclaw-mount-{name}.service -f` for `vfs cache: cleaned`).

```bash
sudo systemctl disable --now nanoclaw-mount-{name}.service
sudo rm /etc/systemd/system/nanoclaw-mount-{name}.service
sudo systemctl daemon-reload
```

Any container still running from a group that had this mount holds a now-dead FUSE handle. Kill those containers so they respawn without it:

```bash
docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-'   # kill the ones for the affected groups
```

## 4. Remove the mount point and cache

```bash
sudo rmdir /mnt/nanoclaw/{name}
rm -rf {home}/.cache/rclone/vfs/nanoclaw-{name} {home}/.cache/rclone/vfsMeta/nanoclaw-{name}
```

## 5. Delete the rclone remote

This deletes the stored server credentials. Confirm with the operator first — skip it if they plan to recreate the mount later.

```bash
rclone config delete nanoclaw-{name}
```

If the mount used the end-to-end `crypt` wrapping (see SKILL.md Encryption), also delete the base remote:

```bash
rclone listremotes | grep -q "^nanoclaw-{name}-base:$" && rclone config delete nanoclaw-{name}-base
```

## 6. Verify

```bash
systemctl list-units --all 'nanoclaw-mount-*'   # unit gone
rclone listremotes                               # remote gone (if deleted)
cat ~/.config/nanoclaw/mount-allowlist.json      # root gone
```
