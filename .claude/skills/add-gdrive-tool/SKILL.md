---
name: add-gdrive-tool
description: Add Google Drive as an MCP tool (list/search/upload/download files, edit Docs/Sheets/Slides) using OneCLI-managed OAuth. Mirrors /add-gmail-tool and /add-gcal-tool's stub pattern — no raw credentials ever reach the container; OneCLI injects real tokens at request time.
---

# Add Google Drive Tool (OneCLI-native)

This skill wires [`@piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `www.googleapis.com` / `oauth2.googleapis.com` and swaps the bearer for the real OAuth token from its vault.

**Why this package:** `@piotr-agier/google-drive-mcp` covers Drive + Docs + Sheets + Slides (and Calendar, but `/add-gcal-tool` is preferred for that). Actively maintained, MIT-licensed, multi-format support including surgical Docs edits, shared drives, and folder-path navigation. Same `installed`-schema stub format the Gmail and Calendar siblings use.

Tools exposed (surfaced as `mcp__drive__<name>`, exact set depends on version — run `tools/list` against the MCP server to enumerate): `list-files`, `search-files`, `read-file`, `create-file`, `update-file`, `delete-file`, `move-file`, `copy-file`, `upload-file`, `download-file`, `create-folder`, `list-folder`, plus Docs/Sheets/Slides editing tools.

**Why this pattern:** v2's invariant is that containers never receive raw API keys (CHANGELOG 2.0.0). Same stub pattern `/add-gmail-tool` and `/add-gcal-tool` use. This skill is deliberately a sibling, not a combined "Google Workspace" skill — installs independently and removes cleanly.

## Phase 1: Pre-flight

### Verify OneCLI has Google Drive connected

```bash
onecli apps get --provider google-drive
```

Expected: `"connection": { "status": "connected" }` with scopes including `drive.file` and/or `drive.readonly`.

If not connected, tell the user:

> Open the OneCLI web UI, go to Apps → Google Drive, and click Connect. Sign in with the Google account the agent should act as. Recommended scopes: `drive.file` (non-sensitive — files the agent creates/opens) and `drive.readonly` (sensitive — read everything; requires Production OAuth verification or Testing-mode test-user). The Docs/Sheets/Slides APIs read-write within the chosen scope set.

**Scope caveat:** `drive.readonly` is a Google "sensitive" scope. In Production OAuth, it triggers Google's app-verification flow (weeks to months). For personal use, either keep the OAuth consent screen in Testing mode (limited to 100 test users, refresh tokens expire weekly) or use only `drive.file` (non-sensitive, no verification needed).

### Verify stub credentials exist

The stub lives at `~/.drive-mcp/` by convention. piotr-agier defaults to `~/.config/google-drive-mcp/tokens.json` — we override via env vars below so it reads our stubs instead.

```bash
ls -la ~/.drive-mcp/gcp-oauth.keys.json ~/.drive-mcp/credentials.json 2>&1
```

If both exist with `onecli-managed`:

```bash
grep -l onecli-managed ~/.drive-mcp/gcp-oauth.keys.json ~/.drive-mcp/credentials.json
```

...skip to Phase 2. If either file has real credentials (no `onecli-managed`), **STOP** — back up and delete before proceeding.

If absent, write them:

```bash
mkdir -p ~/.drive-mcp
cat > ~/.drive-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.drive-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly"
}
EOF
chmod 600 ~/.drive-mcp/*.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.drive-mcp` must sit under an `allowedRoots` entry.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the Google Drive token:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the Drive secret.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'DRIVE_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block and add:

```dockerfile
ARG DRIVE_MCP_VERSION=2.2.0
```

If `/add-gmail-tool` or `/add-gcal-tool` has already been applied, the pnpm global-install block already exists. Just append the drive package:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}" \
        "@piotr-agier/google-drive-mcp@${DRIVE_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```

If neither sibling has been applied, install Drive standalone:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@piotr-agier/google-drive-mcp@${DRIVE_MCP_VERSION}"
```

### Tool allowlist

Current agent-runner auto-derives `mcp__<server>__*` patterns from the registered `mcpServers` map (`container/agent-runner/src/providers/claude.ts`), so no `TOOL_ALLOWLIST` edit is needed — the `drive` entry added in Phase 3 is picked up automatically.

### Rebuild the container image

```bash
./container/build.sh
```

## Phase 3: Wire Per-Agent-Group

For each agent group, merge into `groups/<folder>/container.json`:

```jsonc
{
  "mcpServers": {
    "drive": {
      "command": "google-drive-mcp",
      "args": [],
      "env": {
        "GOOGLE_DRIVE_OAUTH_CREDENTIALS": "/workspace/extra/.drive-mcp/gcp-oauth.keys.json",
        "GOOGLE_DRIVE_MCP_TOKEN_PATH": "/workspace/extra/.drive-mcp/credentials.json"
      }
    }
  },
  "additionalMounts": [
    {
      "hostPath": "/home/<user>/.drive-mcp",
      "containerPath": ".drive-mcp",
      "readonly": false
    }
  ]
}
```

Substitute `<user>` with `echo $HOME`. `containerPath` is relative (mount-security rejects absolute paths — additional mounts land at `/workspace/extra/<relative>`).

**Same-group-as-gmail/calendar tip:** if this group already has the gmail and/or calendar MCPs, **merge, don't replace** — all entries coexist in `mcpServers` and `additionalMounts`.

## Phase 4: Build and Restart

```bash
pnpm run build
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

Kill any existing agent containers so they respawn with the new mcpServers config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Test from a wired agent

> Send: **"list my recent Google Docs"** or **"find a file named X in my drive"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'drive|mcp'
```

Common signals:
- `command not found: google-drive-mcp` → image not rebuilt.
- `ENOENT ...credentials.json` → mount missing. Check the mount allowlist.
- `401 Unauthorized` from `*.googleapis.com` → OneCLI isn't injecting; verify agent's secret mode and that Google Drive is connected.
- `403 insufficientPermissions` → scope you connected doesn't cover the operation. Reconnect with broader scopes (or use `drive.file`-compatible operations only).
- Agent says "I don't have drive tools" → image cache stale (`./container/build.sh` again).

## Removal

1. Delete `"drive"` from `mcpServers` and the `.drive-mcp` mount from `additionalMounts` in each group's `container.json`.
2. Remove `DRIVE_MCP_VERSION` ARG and the drive package from the Dockerfile install block.
3. `pnpm run build && ./container/build.sh && systemctl --user restart nanoclaw`.
4. Optional: `rm -rf ~/.drive-mcp/` and `onecli apps disconnect --provider google-drive`.

## Credits & references

- **MCP server:** [`@piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) — MIT-licensed, actively maintained, covers Drive + Docs + Sheets + Slides.
- **Skill pattern:** direct sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md); same OneCLI stub mechanism.
