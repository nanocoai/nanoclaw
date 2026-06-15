---
name: add-strava
description: Add Strava as an MCP tool (activities, stats, routes, training zones) using the official Strava MCP endpoint. OAuth tokens are managed host-side and injected at container spawn time — no raw credentials reach the container.
---

# Add Strava (Official MCP Endpoint)

This skill wires the official Strava MCP endpoint (`https://mcp.strava.com/mcp`) into selected agent groups using HTTP transport. Unlike stdio-based MCP servers, this is a remote endpoint — the container connects directly to Strava's hosted MCP service.

Authentication uses Strava's standard OAuth 2.0 flow. A one-time script obtains tokens, then the host-side `strava-token.ts` module auto-refreshes them before expiry. At container spawn time, `materializeContainerJson` resolves the `Bearer {{strava}}` placeholder in MCP headers to a fresh access token.

**Why this pattern:** v2's invariant is that containers never receive raw API keys. Strava client credentials (`client_id`, `client_secret`) stay in `data/strava-tokens.json` on the host; only the short-lived access token is injected into the materialized `container.json` at spawn time.

**Dependency:** This skill requires remote MCP type support (`McpServerRemoteConfig` in `src/container-config.ts`). If the types aren't present, apply the remote MCP types PR first.

## Phase 1: Pre-flight

### Check remote MCP type support

```bash
grep -q 'McpServerRemoteConfig' src/container-config.ts && echo "OK — remote MCP types present" || echo "MISSING — apply remote MCP types PR first"
```

If missing, tell the user:

> Remote MCP types (`McpServerRemoteConfig` with `url` and `headers` fields) are required for Strava's hosted MCP endpoint. Apply the remote MCP types PR first, then re-run this skill.

**STOP** if the types are missing. The rest of this skill depends on them.

### Check if Strava is already configured

```bash
ls -la data/strava-tokens.json 2>&1
```

If the file exists and contains valid tokens, skip to Phase 3 (wiring). If it exists but is stale or corrupt, delete it and proceed to Phase 2.

## Phase 2: Strava API App + OAuth

### Create a Strava API app

Tell the user:

> 1. Go to https://www.strava.com/settings/api
> 2. Create an application:
>    - **Application Name**: anything (e.g., "NanoClaw")
>    - **Category**: pick any
>    - **Website**: `http://localhost`
>    - **Authorization Callback Domain**: `localhost`
> 3. Note the **Client ID** and **Client Secret** from the app page.

Ask the user for `client_id` and `client_secret`.

### Run the OAuth flow

```bash
pnpm exec tsx scripts/strava-oauth.ts <client_id> <client_secret>
```

This opens a browser for Strava authorization, captures the callback on `localhost:9876`, exchanges for tokens, and saves them to `data/strava-tokens.json`.

### Verify tokens were saved

```bash
cat data/strava-tokens.json | head -5
```

Expected: a JSON object with `access_token`, `refresh_token`, `expires_at`, and athlete info.

## Phase 3: Wire to Agent Group(s)

### List groups

```bash
ncl groups list
```

Ask the user which agent group(s) should get Strava access.

### Add the Strava MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name strava \
  --type http \
  --url https://mcp.strava.com/mcp \
  --headers '{"Authorization": "Bearer {{strava}}"}'
```

The `Bearer {{strava}}` placeholder is resolved at container spawn time by `resolveRemoteMcpTokens` in `src/container-config.ts`. Each spawn gets a fresh access token (auto-refreshed if expired).

### Restart the group

```bash
ncl groups restart --id <group-id> --message "Strava MCP added — you now have access to Strava activity data, stats, routes, and training zones."
```

## Phase 4: Build and Restart

```bash
pnpm run build
```

Restart the host so the new `strava-token.ts` module is loaded:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Phase 5: Verify

### Test from a wired agent

Tell the user:

> In your agent chat, send: **"What were my last 5 Strava activities?"** or **"Show my Strava stats for this year"**.
>
> The agent should use Strava MCP tools. The first call may take a moment while the MCP connection is established.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'strava|mcp'
```

Common signals:
- `Strava token refresh failed` → check that `data/strava-tokens.json` has valid `client_id`, `client_secret`, and `refresh_token`. Re-run the OAuth script if needed.
- `Bearer {{strava}}` appears literally in logs → the `resolveRemoteMcpTokens` function didn't run. Ensure `src/strava-token.ts` exists and `pnpm run build` completed.
- Connection timeout to `mcp.strava.com` → verify the container has outbound internet access.
- Agent says "I don't have Strava tools" → the `strava` MCP server isn't registered in this group's `mcpServers` (re-run the `ncl groups config add-mcp-server` step).

## Removal

1. For each group that had Strava wired, remove the MCP server:
   ```bash
   ncl groups config remove-mcp-server --id <group-id> --name strava
   ```
2. Remove the token file:
   ```bash
   rm data/strava-tokens.json
   ```
3. Optionally remove `src/strava-token.ts` and the `resolveRemoteMcpTokens` block from `src/container-config.ts` if no other remote MCP integrations use the token resolution pattern.
4. `pnpm run build` and restart the host.
5. Optionally delete the Strava API app at https://www.strava.com/settings/api.

## Notes

- **Token refresh is automatic.** The host refreshes the access token 5 minutes before expiry. Strava access tokens last 6 hours; refresh tokens don't expire (unless the user deauthorizes the app).
- **No container image rebuild needed.** Unlike stdio MCP servers (gmail, calendar), the Strava MCP runs remotely — no binary is installed in the container image.
- **No additional mounts needed.** Tokens live in `data/strava-tokens.json` on the host. The resolved access token is injected into `container.json` at spawn time — the container never reads the token file directly.
- **Scope is read-only.** The OAuth scopes requested are `read,read_all,activity:read,activity:read_all,profile:read_all`. No write access to Strava data.
- **One athlete per install.** The token file holds credentials for a single Strava account. Multi-athlete support would need per-group token files (not implemented).
