---
name: add-fxmacrodata-tool
description: Add FXMacroData as a keyless remote MCP server for selected NanoClaw agent groups. Use when an agent needs macroeconomic release data, release calendars, central-bank data, or FX market context, with an optional API key stored in the credential gateway.
---

# Add FXMacroData Tool

Register FXMacroData's hosted MCP server (Streamable HTTP,
`https://mcp.fxmacrodata.com`) for each selected agent group. The server
supplies its tool descriptions and input schemas at runtime (about 50 tools,
for example `latest_announcements`, `release_calendar`, `data_catalogue`,
`indicator_query`, `forex`, `cot_data`, `commodities`). They appear as
`mcp__fxmacrodata__<tool>`.

The registration uses core's native remote MCP support (`--url`), so nothing
is added to the agent image and no bridge process runs. Any provider with
remote MCP support picks it up (Claude, OpenCode, and Codex all do).

## Keyless scope

Without a key (free, no account, fair use 100 requests per day):

- USD announcement data for the most recent 90 days; each release is readable
  15 minutes after publication
- USD release calendar, USD press releases, and the USD data catalogue
- For every currency: forecast coverage and market sessions

Everything else (other currencies, FX rates, commodities, real-time releases,
full history) needs an API key. Those tools return `subscription_required`
without one; the data exists, it is behind the key.

Two things the agent should know when reading results: a calendar row's `date`
is the reference period, not the release date (release timing is
`announcement_datetime`), and list tools return 20 rows by default (`limit` up
to 100; follow `pagination.next_offset` while `pagination.has_more`).

## Phase 1: Pre-flight

List the groups and check for an existing registration:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

Ask which agent groups should receive FXMacroData. Skip any group that already
has an `fxmacrodata` MCP entry.

## Phase 2: Install the registration guard

Copy the guard into the host test tree and run it:

```bash
cp .claude/skills/add-fxmacrodata-tool/fxmacrodata-mcp.test.ts src/fxmacrodata-mcp.test.ts
pnpm exec vitest run src/fxmacrodata-mcp.test.ts
```

The guard runs the exact registration below through core's MCP config parser
and the `container.json` materializer. Per-group registration itself is
runtime state stored through `ncl`, so it has no in-tree line for a
registration test to guard.

## Phase 3: Register FXMacroData

`config add-mcp-server` and `groups restart` are approval-gated. Run from
inside a container they return `approval-pending` immediately; that is not an
error. Wait for the admin's approval and the follow-up system message before
moving on to Phase 4.

For each selected `<group-id>`, register one server named `fxmacrodata`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name fxmacrodata \
  --url https://mcp.fxmacrodata.com
```

Do not pass `--headers`. A wrong or placeholder `Authorization` value is
rejected with HTTP 401 `invalid_api_key`, so a header with no real key breaks
the keyless tier. The key, when there is one, comes from the gateway (Phase 5).

Restart each selected group:

```bash
ncl groups restart \
  --id <group-id> \
  --message "FXMacroData is installed. Call the FXMacroData release_calendar tool for USD and report whether it succeeds."
```

## Phase 4: Verify

Confirm the stored configuration contains one `fxmacrodata` server of type
`http` with the URL above and no `headers`:

```bash
ncl groups config get --id <group-id>
```

Then check the selected agent's test response. The call must use
`mcp__fxmacrodata__release_calendar` and return USD calendar rows.

## Phase 5: Optional API key

Skip this phase to stay on the keyless tier. To unlock everything else, the
user gets a key at https://fxmacrodata.com/subscribe and the operator stores
it in the credential gateway, never in `--headers`, the URL, `.env`, or chat.
The gateway then injects it into requests to `mcp.fxmacrodata.com` as
`Authorization: Bearer <key>`; with no stored key no header is sent, so the
keyless tier keeps working. The registration from Phase 3 does not change.

Store it with the gateway this copy runs (`NANOCLAW_GATEWAY_PROVIDER` in
`.env`):

- **OneCLI**: write the key to a `0600` temp file, then run on the host:

  ```bash
  onecli secrets create --name FXMacroData --type generic \
    --host-pattern mcp.fxmacrodata.com \
    --header-name Authorization --value-format 'Bearer {value}' \
    --file <key-file>
  ```

  Delete the temp file. Agents in `all` secret mode pick it up. For an agent
  in `selective` mode, merge the new secret ID into its existing list with
  `onecli agents set-secrets` (read `onecli agents secrets --id <agent-id>`
  first; never call `set-secrets` on an `all`-mode agent, it would switch the
  agent to `selective` and cut it off from its other secrets).
- **Iron Proxy**: in the Iron Control console, create a secret for host
  `mcp.fxmacrodata.com` that sets `Authorization: Bearer <key>`, then grant
  it to this copy:

  ```bash
  pnpm exec tsx .claude/skills/add-iron-proxy/scripts/control.ts grant static <secret-id>
  ```

Restart each selected group, then ask the agent for a non-USD release (for
example the latest EUR inflation print) to confirm the key is used.

## Phase 6: Install the upgrade path

Keyless groups hit `subscription_required` as soon as a user asks for another
currency or FX rates. Install standing instructions so the agent explains the
keyless scope and offers the key path at that moment instead of dead-ending.
For each selected group, write the block from
[upgrade-instructions.md](upgrade-instructions.md) into
`groups/<group-folder>/instructions.prepend.md`: replace an existing
`<!-- fxmacrodata-upgrade:start -->` to `<!-- fxmacrodata-upgrade:end -->`
block in place, append otherwise. Do not write into
`groups/<group-folder>/CLAUDE.md`; it is regenerated at spawn and appended
blocks are lost. Restart each selected group:
`ncl groups restart --id <group-id>`.

## Troubleshooting

- FXMacroData tools are absent: verify the group has an `fxmacrodata` MCP
  entry of type `http`, then restart it.
- `add-mcp-server` fails with `looks like a credential`: the URL carries a key
  (`?api_key=`). Register the bare URL and store the key in the gateway.
- HTTP `401` `invalid_api_key`: a header reached the server without a valid
  key. Remove any `--headers` from the registration, and replace or delete the
  stored gateway secret for `mcp.fxmacrodata.com`.
- `subscription_required`: the request is outside the keyless scope. Store a
  key (Phase 5) or stay on USD and the all-currency discovery tools.
- On Iron Proxy, requests to `mcp.fxmacrodata.com` are refused or wait for
  approval: Iron checks its local egress allowlist and asks a human to
  approve non-model destinations. Allow the host with
  `pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host mcp.fxmacrodata.com`
  and approve the request card.
- The agent hits `subscription_required` but never explains the key path:
  check that `groups/<group-folder>/instructions.prepend.md` contains the
  `fxmacrodata-upgrade` block (Phase 6) and restart the group.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- FXMacroData MCP and API documentation: https://fxmacrodata.com/documentation
- Machine-readable summary: https://fxmacrodata.com/llms.txt
