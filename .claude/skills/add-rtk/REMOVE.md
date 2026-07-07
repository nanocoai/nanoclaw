# Remove rtk

Idempotent — safe to run even if some steps were never applied. Run Steps 1–3 once per agent group that had rtk wired (`ncl groups list`).

## 1. Remove the mount from the container config

Read the current mounts, drop the rtk entry, and write the rest back. Match **both** the current `containerPath` (`bin/rtk`) and the legacy absolute one (`/usr/local/bin/rtk`) so installs from any version of the skill are cleaned up.

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

Write the filtered array (omit any entry whose `containerPath` is `bin/rtk` **or** `/usr/local/bin/rtk`):

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<filtered-json>' WHERE agent_group_id = '<group-id>'"
```

If no rtk entry is present, leave the array as-is.

## 2. Remove PATH + the PreToolUse hook from settings.json

Delete the rtk Bash hook (matching both the bare and absolute forms) and drop the `env.PATH` key this skill added. This leaves any other `PreToolUse` entries and `env` keys intact and is safe to re-run:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '
  del(.env.PATH)
  | .hooks.PreToolUse = ((.hooks.PreToolUse // [])
        | map(select((.hooks // []) | any(.command | test("rtk hook claude$")) | not)))' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

> The rtk `PATH` lived in a dedicated `env.PATH` key that only this skill set, so deleting it is safe. If you had set `PATH` in `settings.json` for another reason, restore that value instead of deleting the key.

## 3. Restart the container

```bash
ncl groups restart --id <group-id>
```

## 4. Remove the allowlist entry (optional)

Once no group mounts rtk anymore, drop the rtk entry from `~/.config/nanoclaw/mount-allowlist.json` (`allowedRoots`) and restart the host service so the cache reloads:

```bash
source setup/lib/install-slug.sh
# Linux:  systemctl --user restart "$(systemd_unit)"
# macOS:  launchctl kickstart -k gui/$(id -u)/"$(launchd_label)"
```

## 5. Remove the host binary (optional)

```bash
rm -f ~/.local/bin/rtk
```
