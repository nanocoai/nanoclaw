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

`additional_mounts` is a JSON column not exposed via `ncl config update`. Update it directly via the DB helper, merging with any existing mounts.

Read current mounts first:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

Then write the merged array (include all existing entries plus the rtk entry):

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<merged-json>' WHERE agent_group_id = '<group-id>'"
```

The rtk entry to append: `{"hostPath":"/home/<user>/.local/bin/rtk","containerPath":"/usr/local/bin/rtk","readonly":true}`

Verify:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

## Step 4 — Add the PreToolUse hook to settings.json

Each agent group has a `settings.json` at:

```
data/v2-sessions/<group-id>/.claude-shared/settings.json
```

This file is mounted at `/home/node/.claude/settings.json` inside the container and is read by Claude Code for hooks, env, and model config.

Add the `PreToolUse` entry using `jq` to merge safely:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = [{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

If `PreToolUse` already exists, append instead of overwriting:

```bash
jq '.hooks.PreToolUse += [{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## Step 5 — Restart the container

```bash
ncl groups restart --id <group-id>
```

No `--message` needed — the hook is transparent and requires no agent awareness.

## Verify

Ask the agent to run `git status` or any other supported command. rtk intercepts it silently. Check savings with:

```bash
~/.local/bin/rtk gain
```

## Troubleshooting

### `rtk: command not found` inside the container

Mount wasn't applied or container wasn't restarted:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
# Look for entry with /usr/local/bin/rtk
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
