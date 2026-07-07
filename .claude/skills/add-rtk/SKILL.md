---
name: add-rtk
description: Install rtk token-compression proxy into agent containers. Routes Bash tool calls through rtk for 60–90% token savings on dev commands (git, cargo, pytest, docker, kubectl, etc.).
---

# Add rtk

Install [rtk](https://github.com/rtk-ai/rtk) — a CLI proxy delivering 60–90% token savings on common dev commands (git, cargo, pytest, docker, kubectl, etc.) — and wire it transparently into agent containers via the Claude Code `PreToolUse` hook.

## What this sets up

- `rtk` binary at `~/.local/bin/rtk` on the host
- That host path allowed for mounting in `~/.config/nanoclaw/mount-allowlist.json`
- `~/.local/bin/rtk` mounted read-only at `/workspace/extra/bin/rtk` inside the target agent group's containers (mount-security forces every additional mount under `/workspace/extra/`, so the `containerPath` **must be relative** — see the mount-security note below)
- `/workspace/extra/bin` added to the container's `PATH` via the agent group's `settings.json` `env`, so the bare `rtk` command that the hook rewrites resolves
- `PreToolUse` hook in the agent group's `settings.json` (invoked by absolute path) so every Bash call is automatically filtered through rtk — no CLAUDE.md instructions needed

> **Migrating from an earlier version of this skill?** An older `/add-rtk` mounted rtk at an **absolute** `containerPath` (`/usr/local/bin/rtk`). On NanoClaw v2 that mount is silently **rejected** by mount-security (see the note below), so rtk never actually reached the container and the hook failed quietly. Symptoms: rtk appears wired but has no effect; `logs/nanoclaw.error.log` shows `Additional mount REJECTED`; `container_configs.additional_mounts` still contains `"containerPath":"/usr/local/bin/rtk"`. **Fix = just re-run this skill** — every step below detects and replaces the old broken entry (mount, allowlist, PATH, hook), then restarts. It is safe to re-run.

> **mount-security note.** `src/modules/mount-security/index.ts` requires every additional mount's `containerPath` to be **relative** and force-prefixes it under `/workspace/extra/`. Absolute container paths (like `/usr/local/bin/rtk`) are rejected outright — that is a deliberate guard against overwriting container system files, not a bug to work around. rtk therefore lands at `/workspace/extra/bin/rtk`, and we put that directory on `PATH` instead.

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

Note the group ID (e.g. `ag-1776342942165-ptgddd`). Repeat Steps 4–6 for each group.

## Step 3 — Allow the rtk path in the mount allowlist

Additional mounts are gated by `~/.config/nanoclaw/mount-allowlist.json` — a host path is only mountable if it falls under an entry in `allowedRoots`. Add rtk as a single-file, read-only root (no `allowReadWrite` → forced read-only):

```json
{ "path": "/home/<user>/.local/bin/rtk", "description": "rtk token-optimizer binary (ro)" }
```

Append that object to the `allowedRoots` array (you can also use `/manage-mounts`). Granting the exact file — not the whole `~/.local/bin` — keeps the surface minimal.

The allowlist is cached in-process, so **restart the host service** after editing:

```bash
source setup/lib/install-slug.sh
# Linux:  systemctl --user restart "$(systemd_unit)"
# macOS:  launchctl kickstart -k gui/$(id -u)/"$(launchd_label)"
```

## Step 4 — Mount rtk into the container config

`additional_mounts` is a JSON array column on `container_configs`. Read the current value, merge in the rtk entry, and write the merged array back.

Read current mounts first:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

Build the merged array: keep every existing entry, **drop any entry whose `containerPath` is `bin/rtk` OR the legacy `/usr/local/bin/rtk`** (so re-running replaces rather than duplicates, and heals installs from the older skill), then add the rtk entry:

```json
{"hostPath":"/home/<user>/.local/bin/rtk","containerPath":"bin/rtk","readonly":true}
```

The relative `bin/rtk` is force-prefixed to `/workspace/extra/bin/rtk` at spawn time. Write the merged array back:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<merged-json>' WHERE agent_group_id = '<group-id>'"
```

Verify:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

## Step 5 — Add PATH + the PreToolUse hook to settings.json

Each agent group has a `settings.json` at:

```
data/v2-sessions/<group-id>/.claude-shared/settings.json
```

This file is mounted at `/home/node/.claude/settings.json` inside the container and is read by Claude Code for hooks, env, and model config.

Two edits, both via one `jq` pass (safe to re-run — dedups the hook and overwrites the PATH key):

1. **PATH** — the rewritten command rtk emits is the bare name `rtk …`, so `rtk` must be on `PATH`. `/workspace/extra/bin` is not on the image `PATH` by default, and Claude Code's `settings.json` `env` values are literal (no `${PATH}` expansion), so set the full container `PATH` plus `/workspace/extra/bin`. The value below matches the stock agent image (`node:22-slim` base + `/pnpm`); if you run a **non-default provider that extends PATH**, append its entries here too.
2. **Hook** — invoke rtk by **absolute path** so the hook itself never depends on `PATH`; only the rewritten command relies on the `env.PATH` above (the best-supported case, since it runs as a Bash-tool subprocess).

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"
PATHVAL="/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/extra/bin"

jq --arg p "$PATHVAL" '
  .env.PATH = $p
  | .hooks.PreToolUse = ((.hooks.PreToolUse // [])
        | map(select((.hooks // []) | any(.command | test("rtk hook claude$")) | not)))
      + [{"matcher":"Bash","hooks":[{"type":"command","command":"/workspace/extra/bin/rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

The `test("rtk hook claude$")` selector matches both the legacy bare `rtk hook claude` and the new absolute form, so re-running (or migrating from the old skill) never leaves a duplicate.

## Step 6 — Restart the container

```bash
ncl groups restart --id <group-id>
```

## Verify

Confirm the binary is mounted, read-only, and executable inside the container so a missing or rejected mount surfaces immediately rather than as a silent hook failure:

```bash
c="$(docker ps --filter "name=<group-id>" --format '{{.Names}}' | head -1)"
docker exec "$c" sh -c 'ls -l /workspace/extra/bin/rtk && /workspace/extra/bin/rtk --version'
docker inspect "$c" --format '{{range .Mounts}}{{if eq .Destination "/workspace/extra/bin/rtk"}}RW={{.RW}}{{end}}{{end}}'   # expect RW=false
```

Then ask the agent to run `git status` or any other supported command. rtk intercepts it silently. Each container keeps its **own** rtk stats (separate `HOME`, reset on respawn), so check savings **inside the container**, not on the host:

```bash
docker exec "$c" rtk gain
```

## Updating rtk later

A running container binds the rtk file by **inode**. The usual update path (download + `mv` into place) creates a **new inode**, so a container that is already running keeps the old version — it does **not** update live. New/respawned containers pick up the new binary automatically. To push a new rtk into a live container, restart it:

```bash
ncl groups restart --id <group-id>
```

## Troubleshooting

### `rtk: command not found` inside the container

Work down the two independent gates:

1. **Was the mount rejected?** Check the host log first — this is the real failure signal:
   ```bash
   grep 'Additional mount REJECTED' logs/nanoclaw.error.log | tail
   ```
   Two common reasons:
   - `must be relative` → the `containerPath` is absolute (e.g. the legacy `/usr/local/bin/rtk`). Re-run **Step 4** with the relative `bin/rtk`.
   - not under an allowed root → the rtk path is missing from the allowlist. Do **Step 3** (and restart the host service).
2. **Is the mount present but not on PATH?** Confirm the file is there and `env.PATH` includes `/workspace/extra/bin`:
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db \
     "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"   # expect "containerPath":"bin/rtk"
   jq '.env.PATH' data/v2-sessions/<group-id>/.claude-shared/settings.json                    # expect …:/workspace/extra/bin
   ```
   Then `ncl groups restart --id <group-id>`.

### Hook not firing

Verify the hook is in `settings.json`:

```bash
jq '.hooks.PreToolUse' data/v2-sessions/<group-id>/.claude-shared/settings.json
```

If missing, re-run Step 5.

### Binary won't execute — permission denied

```bash
chmod +x ~/.local/bin/rtk
```
