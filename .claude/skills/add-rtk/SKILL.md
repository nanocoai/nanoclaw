---
name: add-rtk
description: Install rtk token-compression proxy into agent containers. Routes Bash tool calls through rtk for 60–90% token savings on dev commands (git, cargo, pytest, docker, kubectl, etc.).
---

# Add rtk

Install [rtk](https://github.com/rtk-ai/rtk) — a CLI proxy delivering 60–90% token savings on common dev commands (git, cargo, pytest, docker, kubectl, etc.) — and wire it transparently into agent containers via the Claude Code `PreToolUse` hook.

## What this sets up

- `rtk` binary at `~/.local/bin/rtk` on the host
- `~/.local/bin/rtk` mounted read-only at `/usr/local/bin/rtk` inside the target agent group's containers
- `PreToolUse` hook in the agent group's `settings.json` so every Bash call is automatically filtered through rtk — no CLAUDE.md instructions needed

## Integration tests

This skill has **no in-tree integration test** by design. Its only functional reach-ins are runtime operator actions — the host-only `ncl groups config add-mount` (Step 3) and the `settings.json` `PreToolUse` hook write (Step 4) — neither of which leaves a line in the source tree whose deletion a test could catch. There are no package dependencies or Dockerfile edits to guard either. Conformance is idempotent apply + `REMOVE.md`; the mount and hook are verified at runtime (see Verify).

## Step 1 — Install rtk on the host

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

If the script put the binary elsewhere, move it:

```bash
find ~/.local ~/.cargo/bin ~/bin -name rtk 2>/dev/null
mv "$(which rtk 2>/dev/null)" ~/.local/bin/rtk
```

Verify:

```bash
~/.local/bin/rtk --version
chmod +x ~/.local/bin/rtk   # if needed
```

## Step 2 — Identify the target agent group

```bash
ncl groups list
```

Note the group ID (e.g. `ag-1776342942165-ptgddd`). Repeat Steps 3–5 for each group.

## Step 3 — Mount rtk into the container config

Mount the host rtk binary read-only into the container with the host-only `add-mount` verb. It is idempotent — re-running skips the entry if it is already present:

```bash
ncl groups config add-mount --id <group-id> \
  --host ~/.local/bin/rtk \
  --container /usr/local/bin/rtk \
  --ro
```

This verb is operator-only and runs host-side (via `/setup`, `/customize`, or `/manage-mounts`); it is rejected from inside a container.

The host root (`~/.local/bin`) must also be in the external mount allowlist at `~/.config/nanoclaw/mount-allowlist.json` for the mount to take effect at spawn. Add it there if it isn't already.

Verify:

```bash
ncl groups config get --id <group-id>
# Look for the /usr/local/bin/rtk mount
```

## Step 4 — Add the PreToolUse hook to settings.json

Each agent group has a `settings.json` at:

```
data/v2-sessions/<group-id>/.claude-shared/settings.json
```

This file is mounted at `/home/node/.claude/settings.json` inside the container and is read by Claude Code for hooks, env, and model config.

Add the `PreToolUse` entry with `jq`. This drops any existing rtk Bash hook first, then appends a fresh one, so it is safe to re-run without creating duplicates:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any(.command == "rtk hook claude") | not)))
    + [{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## Step 5 — Restart the container

```bash
ncl groups restart --id <group-id>
```

## Verify

Confirm the binary is executable inside the container so a missing or non-executable mount surfaces immediately rather than as a silent hook failure:

```bash
docker exec "$(docker ps --filter "name=<group-id>" --format '{{.Names}}' | head -1)" rtk --version
```

Then ask the agent to run `git status` or any other supported command. rtk intercepts it silently. Check savings with:

```bash
~/.local/bin/rtk gain
```

## Troubleshooting

### `rtk: command not found` inside the container

Mount wasn't applied or container wasn't restarted:

```bash
ncl groups config get --id <group-id>
# Look for the /usr/local/bin/rtk mount
ncl groups restart --id <group-id>
```

### Hook not firing

Verify the hook is in `settings.json`:

```bash
jq '.hooks.PreToolUse' data/v2-sessions/<group-id>/.claude-shared/settings.json
```

If missing, re-run Step 4.

### Binary won't execute — permission denied

```bash
chmod +x ~/.local/bin/rtk
```
