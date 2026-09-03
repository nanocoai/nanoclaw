# Remove rtk

Idempotent — safe to run even if some steps were never applied. Run Steps 1–3 once per agent group that had rtk wired (`ncl groups list`).

## 1. Remove the mount from the container config

Remove the rtk mount with the host-only `remove-mount` verb. It is idempotent — a no-op if the mount isn't present:

```bash
ncl groups config remove-mount --id <group-id> \
  --host ~/.local/bin/rtk \
  --container /usr/local/bin/rtk
```

This verb is operator-only and runs host-side; it is rejected from inside a container.

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
