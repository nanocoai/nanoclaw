---
name: add-caldav-tool
description: Add a generic CalDAV calendar (Nextcloud / Fastmail / iCloud / Radicale / etc.) as an MCP tool — list calendars, list/create/update/delete events with RRULE support — using OneCLI-managed Basic-auth injection. Mirrors /add-gcal-tool's stub pattern; no raw passwords ever reach the container.
---

# Add CalDAV Tool (OneCLI-native)

This skill wires [`caldav-mcp`](https://github.com/dominik1001/caldav-mcp) into selected agent groups. The MCP server reads `CALDAV_BASE_URL` / `CALDAV_USERNAME` / `CALDAV_PASSWORD` from env; we set the password to the literal string `onecli-managed`. The OneCLI gateway intercepts outbound HTTPS to the CalDAV host and **replaces the `Authorization` header** with the real `Basic <base64(user:password)>` value from its vault.

**Why this pattern:** v2's invariant is that containers never receive raw API keys (CHANGELOG 2.0.0). CalDAV's `Authorization: Basic <…>` header is exactly the kind of credential OneCLI's `--header-name Authorization --value-format 'Basic {value}'` rule is designed to inject. Same shape as `/add-gcal-tool`, just simpler — no on-disk stub file because `caldav-mcp` is env-var-only.

**Why this package** (and not the alternatives): `caldav-mcp@0.8.x` is MIT, semantic-release-driven, lean (`@modelcontextprotocol/sdk` + `ts-caldav` + `zod`), and exposes the standard CRUD surface with RRULE support. `@miguelarios/cal-mcp` adds free/busy but pulls in a single-maintainer monorepo (`@miguelarios/pim-core`). `@wyattjoh/caldav-mcp` ships its own OAuth 2.1 layer that fights OneCLI's injection.

Tools exposed (surfaced as `mcp__caldav__<name>`):

- `list-calendars` — returns name + URL for each calendar
- `list-events` — events between two ISO-8601 timestamps on a given calendar URL
- `create-event` — summary / start / end / optional description, location, RRULE
- `update-event` — partial update by UID + calendar URL
- `delete-event` — by UID + calendar URL

Search and free/busy are not in this package. The agent can substitute by widening the `list-events` window and filtering client-side.

## Phase 1: Pre-flight

### 1a. Get a CalDAV password from your provider

Most providers require an **app-specific password** (not your account password) because CalDAV uses plain Basic auth and your account login likely has 2FA / SSO / OAuth attached.

| Provider | Where to generate | URL hint |
|----------|-------------------|----------|
| **Nextcloud** | Settings → Security → Devices & sessions → "Create new app password" | `https://<your-host>` (server auto-discovers `/remote.php/dav`) |
| **Fastmail** | Settings → Privacy & Security → App passwords → New (scope: Calendars) | `https://caldav.fastmail.com` |
| **iCloud** | appleid.apple.com → Sign-In & Security → App-Specific Passwords | `https://caldav.icloud.com` |
| **Radicale** | Whatever you put in your `htpasswd` file | `https://<your-host>:5232` |
| **Google** | Not supported — Google deprecated CalDAV Basic auth in 2024. Use `/add-gcal-tool` instead. | — |

If the provider requires the username in a specific form (e.g. iCloud wants the full Apple ID; **Nextcloud sometimes wants the full email `user@domain` rather than the short login** — check what your iPhone calendar setup uses if you already have one working), note it now. You'll need both the URL and the username for the OneCLI rule and the container env.

### 1b. Register the secret with OneCLI

OneCLI stores the base64-encoded `user:password` pair and injects it into the `Authorization` header on every outbound request matching the host pattern.

Tell the user to run this in their own shell — `read -s` keeps the password out of the transcript:

```bash
read -s -p "CalDAV app password: " CALDAV_PASS && echo && \
onecli secrets create \
  --name "CalDAV: ${CALDAV_HOST}" \
  --type generic \
  --value "$(printf '%s:%s' "$CALDAV_USER" "$CALDAV_PASS" | base64 -w0)" \
  --host-pattern "${CALDAV_HOST}" \
  --header-name "Authorization" \
  --value-format "Basic {value}" && \
unset CALDAV_PASS
```

Where `CALDAV_HOST` is the bare hostname (no scheme, no path — e.g. `nextcloud.example.com`) and `CALDAV_USER` is the form your provider expects.

Notes:
- `base64 -w0` (GNU) suppresses line wrapping. On macOS BSD `base64`, drop `-w0` — it doesn't wrap by default.
- The `Basic {value}` template prefixes the stored base64 string with `Basic ` at injection time.

Verify it landed:

```bash
onecli secrets list 2>&1 | grep -i caldav
```

You should see the secret name and `hostPattern`. The `preview` field shows the first 4 chars of the base64 value, which is enough to confirm it's not empty without exposing the credential.

### 1c. Check agent secret-mode

For each target agent group, confirm OneCLI will inject the CalDAV secret. Auto-created agents start in `selective` mode (no secrets assigned by default — see the CLAUDE.md "Gotcha: auto-created agents start in `selective` secret mode" section).

```bash
onecli agents list
```

Find the entry for your target agent group. Note that OneCLI tracks **two ids** per agent:

- `id` — OneCLI's internal UUID (e.g. `6a0ee60d-f4ab-4469-ac82-8dd4d11f436e`)
- `identifier` — the nanoclaw `agent_group_id` (e.g. `ag-1777523248247-cqaeej`)

**OneCLI CLI flags expect the UUID `id`, not the `identifier`.** Mixing them up returns `Agent not found`.

If `secretMode` is `all`, the new CalDAV secret will be auto-injected on the next request — nothing else to do.

If `selective`, flip to `all` (simplest, only widens within the host pattern) or assign just this one:

```bash
# Option A: every vault secret with a matching host pattern
onecli agents set-secret-mode --id <onecli-uuid> --mode all

# Option B: stay selective, assign just this one
onecli secrets list --quiet --fields id,name | grep -i caldav      # grab secret id
onecli agents set-secrets --id <onecli-uuid> --secret-ids <secret-id>
```

**Scope decision** (per-agent vs all agents): if only one agent needs the calendar, leave the others alone — option B is fine. If multiple agents in this install should share calendar access, option A is less fiddly. The OneCLI host-pattern already constrains where the secret can leak to, so option A doesn't widen the blast radius beyond the CalDAV host.

No container restart needed after changing secret mode — the gateway looks up secrets per request.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'CALDAV_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block (near the top — look for the other `*_VERSION` ARGs) and add:

```dockerfile
ARG CALDAV_MCP_VERSION=0.8.0
```

Then in the pnpm global-install section, add a new `RUN` block (or append to an existing one if `/add-gmail-tool` or `/add-gcal-tool` is already wired):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "caldav-mcp@${CALDAV_MCP_VERSION}"
```

The package binary is `caldav-mcp` — that's what you'll reference as `command` in Phase 3.

**No `TOOL_ALLOWLIST` edit needed.** `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`...Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `caldav` in Phase 3 automatically allows `mcp__caldav__*`. Earlier versions of this skill instructed a static `TOOL_ALLOWLIST` edit — that's redundant now.

### Rebuild the container image

```bash
./container/build.sh
```

(Image is tagged with the install slug, e.g. `nanoclaw-agent-v2-1fdd17c0:latest`. `build.sh` reads the slug from setup — no need to override.)

## Phase 3: Wire Per-Agent-Group

`groups/<folder>/container.json` is **regenerated from the central DB at every spawn** (via `materializeContainerJson` in `src/container-config.ts`). Hand-editing it doesn't stick. Use `ncl groups config add-mcp-server` to update the DB instead:

```bash
pnpm run ncl groups list      # find the target agent group id
```

For each chosen `<group-id>`:

```bash
pnpm run ncl groups config add-mcp-server \
  --id <group-id> \
  --name caldav \
  --command caldav-mcp \
  --args '[]' \
  --env '{"CALDAV_BASE_URL":"https://your-server.example.com","CALDAV_USERNAME":"your-username","CALDAV_PASSWORD":"onecli-managed"}'
```

The verb prints back the updated `mcpServers` block for the group. From inside an agent's container this command is approval-gated; from a host operator shell it executes immediately.

Notes:
- **`CALDAV_BASE_URL`** is the bare server URL — `ts-caldav` does DAV discovery from there. If discovery fails for your provider, try the full DAV root (e.g. `https://your-server.example.com/remote.php/dav` for Nextcloud, `https://caldav.fastmail.com/dav` for Fastmail).
- **`CALDAV_USERNAME`** must match what your provider expects (Nextcloud sometimes wants the full email, sometimes the short login — match your iPhone calendar setup if you have one).
- **`CALDAV_PASSWORD=onecli-managed`** is a stub. `caldav-mcp` will build `Authorization: Basic <base64(user:onecli-managed)>` and send it to the CalDAV host; OneCLI replaces the entire header with the rule's value before the request leaves the host.
- **No `additionalMounts` entry is needed** — unlike `/add-gcal-tool`, this skill has no on-disk credentials file. Everything is env vars + OneCLI injection.

**Same-group-as-gmail/gcal tip:** if this group already has other MCP servers wired, `add-mcp-server` only touches the named entry — existing servers coexist.

## Phase 4: Build and Restart

```bash
pnpm run build
```

Restart the host so any pending migrations + the new dist take effect:

```bash
# Linux (systemd-user)
systemctl --user restart nanoclaw

# macOS (launchd)
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Kill any running agent containers so they respawn with the new `mcpServers` config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

The next message routed to any target agent will spawn a fresh container with `caldav-mcp` mounted in.

## Phase 5: Verify

### Test from a wired agent

> Send: **"list my calendars"** or **"what's on my calendar this week?"**.
>
> First call takes 1–2s while the MCP server starts and OneCLI does the header swap.

### Check logs if it's not working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'caldav|mcp'
docker logs $(docker ps --filter 'name=nanoclaw-v2-' --format '{{.Names}}' | head -1) 2>&1 | tail -50
```

Common signals:

- `command not found: caldav-mcp` → image not rebuilt, or the pin failed to resolve. Re-run `./container/build.sh`.
- `401 Unauthorized` → OneCLI isn't injecting. Verify `onecli secrets list` shows the rule, the `host-pattern` matches your `CALDAV_BASE_URL` host **exactly** (bare hostname, no path), and the base64 value is correct. You can regenerate `printf '%s:%s' "$CALDAV_USER" "$CALDAV_PASS" | base64 -w0` and compare its first 4 chars against the `preview` shown by `secrets list`.
- `ENOTFOUND` / connection refused → wrong `CALDAV_BASE_URL`, or the CalDAV host isn't reachable from inside the container (check `host.docker.internal` resolution on Linux if pointing at a local server).
- `Discovery failed` → try the explicit DAV root path in `CALDAV_BASE_URL` (see Phase 3 notes).
- Agent says "I don't have calendar tools" → the `caldav` MCP server isn't registered in this group's `mcpServers` (re-run `pnpm run ncl groups config add-mcp-server` from Phase 3 and restart the agent's container), or the agent-runner image is stale (`./container/build.sh` again).

### Probe OneCLI injection directly

If you want to confirm the proxy is swapping the header without involving the agent, attach to a running container's network and PROPFIND the CalDAV root with a placeholder Authorization:

```bash
CONTAINER=$(docker ps --filter 'name=nanoclaw-v2-' --format '{{.Names}}' | head -1)
docker run --rm --network=container:$CONTAINER \
  curlimages/curl:latest \
  -sv -H 'Authorization: Basic placeholder' \
  -X PROPFIND \
  "https://${CALDAV_HOST}/" 2>&1 | grep -iE 'authorization|HTTP/'
```

A `207 Multi-Status` response means OneCLI replaced the placeholder with real creds and the server accepted them. `401` means the rule isn't matching, the stored creds are wrong, or the agent's secret mode is `selective` and the secret isn't assigned to this agent.

## Removal

1. For each group that had Calendar wired, remove the MCP server from the DB:
   ```bash
   pnpm run ncl groups config remove-mcp-server --id <group-id> --name caldav
   ```
2. Remove `CALDAV_MCP_VERSION` ARG and the install line from the Dockerfile.
3. `pnpm run build && ./container/build.sh && systemctl --user restart nanoclaw`.
4. Kill running containers so they respawn without the wiring:
   ```bash
   docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
   ```
5. Optional: revoke the OneCLI secret (and the Nextcloud app password):
   ```bash
   onecli secrets list --quiet --fields id,name | grep -i caldav   # grab id
   onecli secrets delete --id <secret-id>
   ```

No `TOOL_ALLOWLIST` removal step — Phase 2 no longer edits it.

## Credits & references

- **MCP server:** [`caldav-mcp`](https://github.com/dominik1001/caldav-mcp) — MIT, by Dominik Münch. Built on [`ts-caldav`](https://github.com/dominik1001/ts-caldav).
- **Skill pattern:** sibling of [`/add-gcal-tool`](../add-gcal-tool/SKILL.md) and [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) — same OneCLI header-injection mechanism, applied to generic Basic auth instead of OAuth Bearer.
- **OneCLI secret semantics:** `--header-name Authorization --value-format 'Basic {value}'` causes the gateway to **replace** the request's `Authorization` header. Whatever the MCP server sends (in our case `Basic <base64(user:onecli-managed)>`) is discarded before the request leaves the host.
- **Tested live** against Nextcloud with the full `user@domain` username form. The `list-calendars` round trip is the canonical smoke test.
