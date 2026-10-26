---
name: add-google-contacts-tool
description: Add Google Contacts (People API) as an MCP tool — list, search, get, create, update, and delete contacts plus "other contacts" — using OneCLI-managed OAuth. Ships a small bundled stdio MCP server (no maintained, Linux-friendly People-API server exists on npm); the OneCLI gateway injects the real bearer for people.googleapis.com, so no raw credentials ever reach the container. Mirrors /add-gmail-tool and /add-gcal-tool's credential model and /add-atomic-chat-tool's bundled-server pattern.
---

# Add Google Contacts Tool (OneCLI-native)

This skill wires a small **bundled** stdio MCP server (`google-contacts-mcp-stdio.ts`, shipped in this folder) into the agent-runner. The server calls the [Google People API](https://developers.google.com/people) (`people.googleapis.com`); the OneCLI gateway intercepts those calls and swaps the placeholder bearer for the real OAuth token from its vault. Same credential model as `/add-gmail-tool` and `/add-gcal-tool` — **no raw credentials reach the container.**

**Why a bundled server (not an npm package):** unlike Calendar (`@cocal/google-calendar-mcp`), there is no well-maintained, Linux-friendly People-API MCP server that runs against stub credentials. The "Google Workspace" kitchen-sink servers expose 90+ unrelated tools (Gmail/Drive/Sheets/…) that would 401, since the gateway only injects for `people.googleapis.com`. So this skill ships its own minimal server — the same approach as `/add-atomic-chat-tool`.

Tools exposed (surfaced as `mcp__google_contacts__<name>`):
- `list_contacts` — list saved contacts (connections)
- `search_contacts` — search saved contacts by name/email/phone
- `search_other_contacts` — search auto-saved "other contacts" (emailed but not added)
- `get_contact` — full details for one contact by `resourceName`
- `create_contact`, `update_contact`, `delete_contact`

## Phase 1: Pre-flight

### Verify OneCLI has Google Contacts connected

```bash
onecli apps get --provider google-contacts
```

Expected: `"connection": { "status": "connected" }` with People-API scopes (`contacts.readonly`, and `contacts` if you want write). If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Contacts, and click Connect. Sign in with the Google account the agent should act as. `contacts` (read/write) + `contacts.other.readonly` are the most useful scopes.

### Check if already applied

```bash
test -f container/agent-runner/src/google-contacts-mcp-stdio.ts && echo "ALREADY APPLIED — skip to Phase 3"
```

## Phase 2: Apply code changes

### Copy the MCP server source into the agent-runner tree

```bash
cp .claude/skills/add-google-contacts-tool/google-contacts-mcp-stdio.ts \
   container/agent-runner/src/google-contacts-mcp-stdio.ts
```

It imports `@modelcontextprotocol/sdk` and `zod`, both already in `container/agent-runner/package.json`.

### Register the MCP server in the agent-runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` object:

```ts
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };
```

Add a `google_contacts` entry alongside `nanoclaw`:

```ts
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    google_contacts: {
      command: 'bun',
      args: ['run', path.join(__dirname, 'google-contacts-mcp-stdio.ts')],
      env: {},
    },
  };
```

`env: {}` is correct — the server needs no host env. The OneCLI gateway injects `HTTPS_PROXY` + CA trust + the real bearer at the container level (`src/container-runner.ts`, `applyContainerConfig`), so the server's `fetch()` to `people.googleapis.com` is intercepted and authenticated automatically.

**No `TOOL_ALLOWLIST` / `claude.ts` edit needed.** The Claude provider derives MCP allow-patterns dynamically from the registered servers — `container/agent-runner/src/providers/claude.ts` does `...Object.keys(this.mcpServers).map(mcpAllowPattern)` — so registering `google_contacts` above automatically allows `mcp__google_contacts__*`. (Older skills edited a static allowlist; that's redundant now.)

### Validate code changes

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

All three must be clean before proceeding.

## Phase 3: Configure

### Confirm the agent's secret mode covers Google Contacts

```bash
onecli agents list
```

`secretMode: all` is sufficient — the gateway injects the matching `google-contacts` credential per request. If an agent is `selective`, assign the secret explicitly:

```bash
onecli agents set-secret-mode --id <agent-id> --mode all
# or stay selective and: onecli agents set-secrets --id <agent-id> --secret-ids <google-contacts-secret-id>
```

### Restart so the new image is used

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart "$(systemd_unit)"            # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill   # respawn agents on new image
```

## Phase 4: Verify

> Send a message like: **"list my contacts"**, **"search my contacts for Alice"**, or **"add a contact: Bob Lee, bob@example.com"**.
>
> The first call takes a couple seconds while the MCP server starts and OneCLI does the token exchange.

If it isn't working:

```bash
tail -100 logs/nanoclaw.log | grep -iE 'GCONTACTS|mcp|google_contacts'
```

- `401`/`403` from `people.googleapis.com` → OneCLI isn't injecting: verify the `google-contacts` provider is connected and the agent's secret mode includes it.
- Agent says "I don't have contact tools" → image not rebuilt (`./container/build.sh`) or the `google_contacts` entry wasn't added to `index.ts`.
- Empty `search_contacts` on the very first call → the People API search cache is warming; retry once (the server already issues a warmup request).

## Removal

1. Remove the `google_contacts` entry from the `mcpServers` object in `container/agent-runner/src/index.ts`.
2. `rm container/agent-runner/src/google-contacts-mcp-stdio.ts`
3. `pnpm run build && ./container/build.sh && systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"`
4. Optional: `onecli apps disconnect --provider google-contacts`.

## Credits & references

- **MCP server:** bundled in this folder (`google-contacts-mcp-stdio.ts`) — a minimal stdio server over the Google People API v1, built with `@modelcontextprotocol/sdk`.
- **Bundled-server pattern:** sibling of [`/add-atomic-chat-tool`](../add-atomic-chat-tool/SKILL.md).
- **OneCLI credential model:** same stub-bearer + gateway-injection pattern as [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md).
- **Why not a Workspace MCP server:** those bundle 90+ tools across Gmail/Drive/Calendar; only the contacts subset would work here (the gateway injects for `people.googleapis.com` only), so a focused server is the right fit.
