---
name: add-gmail-tool
description: Add Gmail as an MCP tool (read, search, send, label, draft) using OneCLI-managed OAuth. The agent gets Gmail tools in every enabled group; OneCLI injects real tokens at request time so no raw credentials are ever in the container or on disk in usable form.
---

# Add Gmail Tool (OneCLI-native)

This skill wires the [`@gongrzhe/server-gmail-autoauth-mcp`](https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp) stdio MCP server into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `gmail.googleapis.com` and injects the real OAuth bearer from its vault.

Tools exposed (from `gmail-mcp@1.1.11`, surfaced to the agent as `mcp__gmail__<name>`): `search_emails`, `read_email`, `send_email`, `draft_email`, `delete_email`, `modify_email`, `batch_modify_emails`, `batch_delete_emails`, `download_attachment`, `list_email_labels`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `list_filters`, `get_filter`, `create_filter`, `create_filter_from_template`, `delete_filter`.

**Why this pattern:** v2's invariant is that containers never receive raw API keys — OneCLI is the sole credential path (see CHANGELOG v2.0.0). The stub-file pattern satisfies this: the container sees `"onecli-managed"` placeholders, the gateway swaps them in flight.

## Phase 1: Pre-flight

### Verify OneCLI has Gmail connected

```bash
onecli apps get --provider gmail
```

Expected: `"connection": { "status": "connected" }` with scopes including `gmail.readonly`, `gmail.modify`, `gmail.send`.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Gmail, and click Connect. Sign in with the Google account you want the agent to act as.

### Verify stub credentials exist

```bash
ls -la ~/.gmail-mcp/gcp-oauth.keys.json ~/.gmail-mcp/credentials.json 2>&1
```

If both exist and contain `"onecli-managed"`:

```bash
grep -l onecli-managed ~/.gmail-mcp/gcp-oauth.keys.json ~/.gmail-mcp/credentials.json
```

...skip to Phase 2.

If either file exists but does **not** contain `onecli-managed`, **STOP** and tell the user — these are real OAuth credentials from a previous non-OneCLI install. Back them up, then delete before proceeding. The OneCLI migration normally handles this; if it didn't, something is wrong.

If both files are absent, write them now:

```bash
mkdir -p ~/.gmail-mcp
cat > ~/.gmail-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.gmail-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send"
}
EOF
chmod 600 ~/.gmail-mcp/gcp-oauth.keys.json ~/.gmail-mcp/credentials.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gmail-mcp` must sit under an `allowedRoots` entry (e.g. `/home/<user>`). If it doesn't, tell the user to run `/manage-mounts` first or add their home directory.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject Gmail secrets into its container. Find the OneCLI agent ID that matches the group's `agentGroupId`:

```bash
onecli agents list
```

If that agent's `secretMode` is `all`, you're done — Gmail secrets (identified by OneCLI's Gmail hostPattern) will auto-inject. If it's `selective`, explicitly assign the Gmail secrets using the safe merge pattern (`set-secrets` replaces the entire list — always read first):

```bash
GMAIL_IDS=$(onecli secrets list | jq -r '[.data[] | select(.name | test("(?i)gmail")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$GMAIL_IDS" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
onecli agents secrets --id <agent-id>
```

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'GMAIL_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block:

```dockerfile
ARG CLAUDE_CODE_VERSION=2.1.116
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=latest
ARG BUN_VERSION=1.3.12
```

Add a new line:

```dockerfile
ARG GMAIL_MCP_VERSION=1.1.11
```

Then find the last pnpm global-install `RUN` block (the one that installs `@anthropic-ai/claude-code`) and add a new block after it, before `# ---- Entrypoint`:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```

Pinned version matters — `minimumReleaseAge` in `pnpm-workspace.yaml` gates trunk installs, and CLAUDE.md requires a fixed ARG version for all Node CLIs installed into the image.

**Why the `zod-to-json-schema` pin:** `@gongrzhe/server-gmail-autoauth-mcp@1.1.11` has loose deps (`zod-to-json-schema: ^3.22.1`, `zod: ^3.22.4`). pnpm resolves `zod-to-json-schema` to the latest 3.25.x, which imports `zod/v3` — a subpath that only exists in `zod>=3.25`. But `zod` resolves to `3.24.x` (highest satisfying `^3.22.4` without breaking peer ranges). Result: `ERR_PACKAGE_PATH_NOT_EXPORTED` at import time. Pinning `zod-to-json-schema` to a pre-v3-subpath version avoids it. Re-check if you bump `GMAIL_MCP_VERSION`.

**No `TOOL_ALLOWLIST` edit needed.** `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `gmail` in Phase 3 automatically allows `mcp__gmail__*`. Earlier versions of this skill instructed a static `TOOL_ALLOWLIST` edit — that's now redundant.

### Rebuild the container image

```bash
./container/build.sh
```

Must complete cleanly. The new `pnpm install -g` layer is ~60s first time (cached on rebuild).

## Phase 3: Wire Per-Agent-Group

For each agent group that should have Gmail (ask the user — typically their personal DM and CLI agents, sometimes shared household agents), persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gmail` entry and an `additionalMounts` entry for `.gmail-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### List groups, pick which ones get Gmail

```bash
ncl groups list
```

### Register the MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gmail \
  --command gmail-mcp \
  --args '[]' \
  --env '{"GMAIL_OAUTH_PATH":"/workspace/extra/.gmail-mcp/gcp-oauth.keys.json","GMAIL_CREDENTIALS_PATH":"/workspace/extra/.gmail-mcp/credentials.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.gmail-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts` — `setup/verify.ts:5` codifies that NanoClaw avoids depending on the `sqlite3` CLI binary, so don't shell out to it):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gmail-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gmail-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoClaw project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it. `updated_at` is ISO-string everywhere else in the schema, so use `datetime('now')` — not `strftime('%s','now')`, which would silently mix epoch ints into a column of YYYY-MM-DD HH:MM:SS strings.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

**Why the container path is relative:** `mount-security` rejects absolute `containerPath` values. Additional mounts are prefixed with `/workspace/extra/`, so `containerPath: ".gmail-mcp"` lands at `/workspace/extra/.gmail-mcp`. The MCP server's `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` env vars point at that absolute location inside the container.

**Why this can't be `groups/<folder>/container.json`:** post-migration `014-container-configs`, `materializeContainerJson` in `src/container-config.ts` rewrites that file from the DB on every spawn. Anything hand-edited there is silently overwritten on next restart.

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

## Phase 5: Verify

### Test from the wired agent

Tell the user:

> In your `<agent-name>` chat, send: **"list my gmail labels"** or **"search my inbox for invoices from last month"**.
>
> The agent should use `mcp__gmail__list_labels` / `mcp__gmail__search`. The first call may take a second or two while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'gmail|mcp'
# Per-container logs — session-scoped:
ls data/v2-sessions/*/stderr.log | head
```

Common signals:
- `command not found: gmail-mcp` → image wasn't rebuilt or PATH doesn't include `/pnpm` (should — `ENV PATH="$PNPM_HOME:$PATH"` in Dockerfile).
- `ENOENT: no such file or directory, open '/workspace/extra/.gmail-mcp/credentials.json'` → mount is missing. Check `~/.config/nanoclaw/mount-allowlist.json` includes a parent of `~/.gmail-mcp`.
- `401 Unauthorized` from `gmail.googleapis.com` → OneCLI isn't injecting. Check the agent's secret mode (`onecli agents secrets --id <agent-id>`) and that the Gmail app is connected (`onecli apps get --provider gmail`).
- Agent says "I don't have Gmail tools" → the `gmail` MCP server isn't registered in this group's `mcpServers` (re-run the `ncl groups config add-mcp-server` step in Phase 3 for that group and restart it), or the agent-runner image is stale (rebuild with `./container/build.sh`, with `--no-cache` if suspicious).

## Removal

1. For each group that had Gmail wired, remove the MCP server from the DB:
   ```bash
   ncl groups config remove-mcp-server --id <group-id> --name gmail
   ```
2. Remove the `.gmail-mcp` mount from the DB (no `remove-mount` verb yet — same #2395 dependency):
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
     SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                              WHERE json_extract(value, '\$.containerPath') != '.gmail-mcp'), \
         updated_at = datetime('now') \
     WHERE agent_group_id = '<group-id>';"
   ```
3. Remove the `GMAIL_MCP_VERSION` ARG and the `pnpm install -g @gongrzhe/server-gmail-autoauth-mcp` block from `container/Dockerfile`.
4. `pnpm run build && ./container/build.sh && systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"`.
5. (Optional) `rm -rf ~/.gmail-mcp/` if no other host-side tool needs the stubs.
6. (Optional) Disconnect Gmail in OneCLI: `onecli apps disconnect --provider gmail`.

No `TOOL_ALLOWLIST` removal step — Phase 2 no longer edits it.

## Notes

- **Stub format is OneCLI-prescribed.** The `access_token: "onecli-managed"` pattern with `expiry_date: 99999999999999` tells the Google auth client the token is valid; OneCLI intercepts the outgoing Gmail API call and rewrites `Authorization: Bearer onecli-managed` to the real token. `expiry_date: 0` (refresh-interception) is an alternative the OneCLI docs describe — both work but OneCLI's own `migrate` command writes the far-future variant, which is what this skill assumes.
- **Scopes are set at OAuth connect time.** If the agent needs scopes beyond what's currently connected (e.g. the user later wants `calendar.readonly` for combined email/calendar workflows), disconnect and reconnect Gmail in the OneCLI web UI with the expanded scope set.
- **This is tool-only.** Inbound email as a channel (emails trigger the agent) is a separate piece of work — it needs a `src/channels/gmail.ts` adapter that polls the inbox and routes to a messaging group. The pre-v2 qwibitai skill had this; it has not been ported to v2's channel architecture as of v2.0.0.

## Credits & references

- **MCP server:** [`@gongrzhe/server-gmail-autoauth-mcp`](https://github.com/GongRzhe/Gmail-MCP-Server) by GongRzhe — MIT-licensed.
- **OneCLI credential stubs:** pattern documented at `https://onecli.sh/docs/guides/credential-stubs/gmail.md`.
- **Skill pattern:** modeled on [`add-atomic-chat-tool`](../add-atomic-chat-tool/SKILL.md) and [`add-vercel`](../add-vercel/SKILL.md).
- **Addresses:** [issue #1500](https://github.com/nanocoai/nanoclaw/issues/1500) (proxy Gmail/Calendar OAuth tokens through credential proxy) for the Gmail side.
- **Related PRs:** [#1810](https://github.com/nanocoai/nanoclaw/pull/1810) (pre-install Gmail/Notion MCP) overlaps on the "install the MCP server in the image" idea but bundles many unrelated changes; this skill is the focused OneCLI-native version.
