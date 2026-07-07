# Remove rtk

Idempotent — safe to run even if some steps were never applied. Run Steps 1–3 once per agent group that had rtk wired (`ncl groups list`).

## 1. Remove the mount from the container config

Read the current mounts, drop the entry whose `containerPath` is `/usr/local/bin/rtk`, and write the rest back.

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

Write the filtered array (omit any entry with `"containerPath":"/usr/local/bin/rtk"`):

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<filtered-json>' WHERE agent_group_id = '<group-id>'"
```

If no rtk entry is present, leave the array as-is.

## 2. Remove the PreToolUse hook from settings.json

Delete the rtk Bash hook entry (not comment it out). This leaves any other `PreToolUse` entries intact and is safe to re-run:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any(.command == "rtk hook claude") | not)))' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## 3. Restart the container

```bash
ncl groups restart --id <group-id>
```

## 4. Remove the host binary (optional)

Once no group mounts rtk anymore, remove the binary:

```bash
rm -f ~/.local/bin/rtk
```
