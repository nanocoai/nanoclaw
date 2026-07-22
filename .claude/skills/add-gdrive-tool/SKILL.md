---
name: add-gdrive-tool
description: Connect Google Drive through OneCLI so agents can search, read, and download Drive files. No MCP server or Docker rebuild needed — Drive is accessed via direct Drive v3 API calls through the onecli-gateway's transparent HTTPS proxy. The gdrive-fetch container skill (already in trunk) teaches the agent the endpoints; this skill only completes the OAuth connection and verifies it.
---

# Add Google Drive Tool (OneCLI gateway, no MCP server)

Unlike Gmail/Calendar, Google Drive does **not** need a dedicated MCP server
package, a Dockerfile change, or a stub-credential mount. The `onecli-gateway`
container skill (loaded into every agent already) transparently proxies
outbound HTTPS and lists Google Drive as a supported app — the agent just
calls `https://www.googleapis.com/drive/v3/...` with `curl` and OneCLI injects
the real token at the proxy boundary. The `gdrive-fetch` container skill
(`container/skills/gdrive-fetch/SKILL.md`) teaches the agent the actual
endpoints and query syntax and ships in trunk, so there is no code to copy or
apply here.

This skill's only job is: **connect the OneCLI app, verify the agent can
reach it, confirm it actually works.**

## Phase 1: Connect Google Drive in OneCLI

Check current status:

```bash
onecli apps get --provider google-drive
```

If `"connection"` is `null`, the response includes a `hint` with a connect
URL, e.g.:

```
http://127.0.0.1:10254/p/<slug>/connections?connect=google-drive
```

Tell the user:

> Open this link and sign in with the Google account you want the agent to
> act as: **`<connect URL from the hint>`**
>
> This grants Drive access via Google's own OAuth consent screen — no
> credentials ever pass through me or the container.

Wait for the user to confirm they've connected, then re-run `onecli apps get
--provider google-drive` and confirm `connection.status` is `"connected"`.

## Phase 2: Check agent secret-mode

For each agent group that should get Drive access:

```bash
onecli agents list
```

Find the OneCLI agent matching the group's `agentGroupId`. If `secretMode` is
`all`, nothing further to do — the Google Drive secret auto-injects once
connected. If `selective`, assign it explicitly (safe merge — `set-secrets`
replaces the whole list, always read first):

```bash
DRIVE_IDS=$(onecli secrets list | jq -r '[.data[] | select(.name | test("(?i)drive")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$DRIVE_IDS" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
onecli agents secrets --id <agent-id>
```

No container restart needed for secret-mode changes — the gateway looks up
secrets per request.

## Phase 3: Confirm the container skill is present

`gdrive-fetch` ships in trunk at `container/skills/gdrive-fetch/SKILL.md` and
is picked up automatically by any group whose container config `skills` field
is `'all'` (the default) — no DB write needed. Sanity-check:

```bash
test -f container/skills/gdrive-fetch/SKILL.md && echo "present"
ncl groups config get --id <group-id> | grep -A3 '"skills"'
```

If a target group has pinned `skills` to an explicit array instead of `'all'`,
that group must have `gdrive-fetch` added to the array. There is no dedicated
`--skills` flag on `ncl groups config update` today — read the current JSON
with `config get`, merge in `"gdrive-fetch"`, and check `ncl groups config
help` for whatever verb accepts a raw `skills` column write (mirrors how
`mcp_servers` is edited via `add-mcp-server`/`remove-mcp-server`). Flag this to
the user if the group is pinned rather than silently skipping it.

Restart the group's container so any skill-list change takes effect:

```bash
ncl groups restart --id <group-id>
```

## Phase 4: Verify

Tell the user:

> In your `<agent-name>` chat, send: **"search my Drive for anything with
> 'invoice' in the name"** or **"summarize the Google Doc titled X"**.
>
> The agent should call the Drive API directly via `curl` — no MCP tool name
> to look for, just a normal bash command in its transcript.

### Check logs if it isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'drive|onecli'
```

Common signals:
- Agent says "I don't have Drive access" or doesn't attempt the call at all →
  the `gdrive-fetch` skill isn't in that group's skill list (Phase 3) or the
  container hasn't restarted since it was added.
- `401`/`403` from `googleapis.com` → Drive isn't connected in OneCLI yet
  (Phase 1), or the agent's secret mode excludes it (Phase 2).
- `app_not_connected` in the gateway's error body → same as above; the error
  itself includes a `connect_url` the agent should surface to the user
  verbatim rather than guessing at one.

## Removal

See [REMOVE.md](REMOVE.md).

## Notes

- **This is read-only (fetch) by design.** `gdrive-fetch` only covers search,
  metadata, download, and export. If the user later wants write access
  (upload, share, delete), that's a separate, higher-privilege skill — don't
  silently expand scope here.
- **Why not an MCP server, unlike Gmail/Calendar:** those need a stdio MCP
  server because their upstream packages (`@gongrzhe/server-gmail-autoauth-mcp`,
  `@cocal/google-calendar-mcp`) speak MCP directly via a well-known stub-file
  auto-auth convention. For Drive there's no equivalently-trustworthy
  actively-maintained stdio package following that convention — the
  well-known options are either deprecated (`@modelcontextprotocol/server-gdrive`)
  or built as their own OAuth-proxy HTTP servers with a different trust model
  (e.g. `domdomegg/google-drive-mcp`, which runs its own auth server and needs
  a live browser consent flow through it). The gateway's direct-HTTPS path
  sidesteps the whole question: no third-party package to vet, no Docker
  rebuild, same OneCLI vault trust boundary as everything else.

## Credits & references

- **API:** [Google Drive API v3](https://developers.google.com/workspace/drive/api/reference/rest/v3) — reference for the endpoints and query syntax in `gdrive-fetch`.
- **Skill pattern:** sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md), but via the generic `onecli-gateway` HTTPS proxy instead of a dedicated MCP server.
