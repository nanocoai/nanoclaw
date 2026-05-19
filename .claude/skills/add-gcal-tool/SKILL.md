---
name: add-gcal-tool
description: Add Google Calendar as an MCP tool (list calendars, list/search/create events, free/busy queries) using OneCLI-managed OAuth. Multi-calendar and multi-account supported. Mirrors /add-gmail-tool's stub pattern — no raw credentials ever reach the container; OneCLI injects real tokens at request time.
---

# Add Google Calendar Tool (OneCLI-native)

This skill wires [`@cocal/google-calendar-mcp`](https://github.com/cocal-com/google-calendar-mcp) into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `calendar.googleapis.com` / `oauth2.googleapis.com` and swaps the bearer for the real OAuth token from its vault.

**Why this package (and not gongrzhe's):** `@gongrzhe/server-calendar-autoauth-mcp` only supports the `primary` calendar and exposes 5 tools (no `list_calendars`). `@cocal/google-calendar-mcp` explicitly supports multi-calendar and multi-account, and is actively maintained.

Tools exposed (surfaced as `mcp__calendar__<name>`, exact set depends on version — run `tools/list` against the MCP server to enumerate): `list-calendars`, `list-events`, `search-events`, `create-event`, `update-event`, `delete-event`, `get-event`, `list-colors`, `get-freebusy`, `get-current-time`, plus multi-account management tools.

**Why this pattern:** v2's invariant is that containers never receive raw API keys (CHANGELOG 2.0.0). Same stub pattern `/add-gmail-tool` uses. This skill is deliberately a sibling, not a combined "Google Workspace" skill — installs independently and removes cleanly.

## Phase 1: Pre-flight

### Verify OneCLI has Google Calendar connected

```bash
onecli apps get --provider google-calendar
```

Expected: `"connection": { "status": "connected" }` with scopes including `calendar.readonly` and `calendar.events`.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Calendar, and click Connect. Sign in with the Google account the agent should act as. `calendar.readonly` + `calendar.events` are the minimum useful scopes.

### Verify stub credentials exist

The stub lives at `~/.calendar-mcp/` by convention (shared with `/add-gmail-tool`'s sibling). cocal doesn't default to this path (it uses `~/.config/google-calendar-mcp/tokens.json`) — we override via env vars below so it reads our stubs instead.

```bash
ls -la ~/.calendar-mcp/gcp-oauth.keys.json ~/.calendar-mcp/credentials.json 2>&1
```

If both exist with `onecli-managed`:

```bash
grep -l onecli-managed ~/.calendar-mcp/gcp-oauth.keys.json ~/.calendar-mcp/credentials.json
```

...skip to Phase 2. If either file has real credentials (no `onecli-managed`), **STOP** — back up and delete before proceeding.

If absent, write them:

```bash
mkdir -p ~/.calendar-mcp
cat > ~/.calendar-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.calendar-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events"
}
EOF
chmod 600 ~/.calendar-mcp/*.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.calendar-mcp` must sit under an `allowedRoots` entry.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the Google Calendar token:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the Calendar secret.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'CALENDAR_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block and add:

```dockerfile
ARG CALENDAR_MCP_VERSION=2.6.1
```

If `/add-gmail-tool` has already been applied, the pnpm global-install block already exists with its `zod-to-json-schema@3.22.5` pin. Just append the calendar package — **the calendar-mcp uses `zod@4.x` and does NOT need that pin**, but it's harmless to share the block:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```

If `/add-gmail-tool` hasn't been applied, install Calendar standalone:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}"
```

**No `TOOL_ALLOWLIST` edit needed.** `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `calendar` in Phase 3 automatically allows `mcp__calendar__*`. Earlier versions of this skill instructed a static `TOOL_ALLOWLIST` edit — that's now redundant.

### Rebuild the container image

```bash
./container/build.sh
```

## Phase 3: Wire Per-Agent-Group

For each agent group, persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.calendar` entry and an `additionalMounts` entry for `.calendar-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### Register the MCP server

For each chosen `<group-id>` (use `ncl groups list` to enumerate):

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name calendar \
  --command google-calendar-mcp \
  --args '[]' \
  --env '{"GOOGLE_OAUTH_CREDENTIALS":"/workspace/extra/.calendar-mcp/gcp-oauth.keys.json","GOOGLE_CALENDAR_MCP_TOKEN_PATH":"/workspace/extra/.calendar-mcp/credentials.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.calendar-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts` — `setup/verify.ts:5` codifies that NanoClaw avoids depending on the `sqlite3` CLI binary, so don't shell out to it):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.calendar-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".calendar-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoClaw project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it. `updated_at` is ISO-string everywhere else in the schema, so use `datetime('now')` — not `strftime('%s','now')`, which would silently mix epoch ints into a column of YYYY-MM-DD HH:MM:SS strings.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

`containerPath` is relative (mount-security rejects absolute paths — additional mounts land at `/workspace/extra/<relative>`).

**Why this can't be `groups/<folder>/container.json`:** post-migration `014-container-configs`, `materializeContainerJson` in `src/container-config.ts` rewrites that file from the DB on every spawn. Anything hand-edited there is silently overwritten on next restart.

**Same-group-as-gmail tip:** if this group already has the gmail MCP + `.gmail-mcp` mount, both coexist — `ncl groups config add-mcp-server` only updates the named entry, and `json_insert` appends to `additional_mounts` without disturbing existing entries.

## Phase 4: Build and Restart

```bash
pnpm run build
```

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Kill any existing agent containers so they respawn with the new mcpServers config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Test from a wired agent

> Send: **"list my calendars"** or **"what's on my work calendar next Monday?"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'calendar|mcp'
```

Common signals:
- `command not found: google-calendar-mcp` → image not rebuilt.
- `ENOENT ...credentials.json` → mount missing. Check the mount allowlist.
- `401 Unauthorized` from `*.googleapis.com` → OneCLI isn't injecting; verify agent's secret mode and that Google Calendar is connected.
- Agent says "I don't have calendar tools" → the `calendar` MCP server isn't registered in this group's `mcpServers` (re-run the `ncl groups config add-mcp-server` step in Phase 3 for that group and restart it), or the agent-runner image is stale (`./container/build.sh`, `--no-cache` if suspicious).

## Removal

1. For each group that had Calendar wired, remove the MCP server from the DB:
   ```bash
   ncl groups config remove-mcp-server --id <group-id> --name calendar
   ```
2. Remove the `.calendar-mcp` mount from the DB (no `remove-mount` verb yet — same #2395 dependency):
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
     SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                              WHERE json_extract(value, '\$.containerPath') != '.calendar-mcp'), \
         updated_at = datetime('now') \
     WHERE agent_group_id = '<group-id>';"
   ```
3. Remove `CALENDAR_MCP_VERSION` ARG and the calendar package from the Dockerfile install block.
4. `pnpm run build && ./container/build.sh && systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"`.
5. Optional: `rm -rf ~/.calendar-mcp/` and `onecli apps disconnect --provider google-calendar`.

No `TOOL_ALLOWLIST` removal step — Phase 2 no longer edits it.

## Credits & references

- **MCP server:** [`@cocal/google-calendar-mcp`](https://github.com/cocal-com/google-calendar-mcp) — MIT-licensed, actively maintained, multi-account and multi-calendar.
- **Why not gongrzhe:** earlier versions of this skill used `@gongrzhe/server-calendar-autoauth-mcp@1.0.2` which only supports the primary calendar with 5 event-level tools. The cocal server supersedes it.
- **Skill pattern:** direct sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md); same OneCLI stub mechanism.
