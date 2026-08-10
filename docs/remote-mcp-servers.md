# Adding MCP Servers and Host Mounts to an Agent Group

How to wire an extra MCP server into a NanoClaw agent group, and how to give that
server persistent state on the host (an OAuth token cache, a credential file, a
synced directory).

Most of this doc exists because **the failure modes here are silent**. A rejected
mount is a `log.warn` and nothing else; `ncl groups config get` will happily show
you a mount that never existed at runtime. Read the [verification](#verification)
section before you conclude something is broken.

## Where the config lives

Per-agent-group container config is a row in the `container_configs` table in the
central DB. At every container spawn, `materializeContainerJson()`
(`src/container-config.ts`) **overwrites** `groups/<folder>/container.json` from
that row.

> **Never hand-edit `groups/<folder>/container.json`.** Your edit is silently
> discarded at the next spawn. The DB is the source of truth.

```
container_configs (data/v2.db)
        │  materializeContainerJson() at spawn
        ▼
groups/<folder>/container.json  ──read by──▶  container-runner  ──▶  docker run
```

## Adding an MCP server

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name <server-name> \
  --command <cmd> \
  --args '["<arg>", "..."]' \
  --env '{"KEY":"value"}'

ncl groups config remove-mcp-server --id <group-id> --name <server-name>
ncl groups restart --id <group-id>          # config is read at spawn only
```

Three things to know (`src/cli/resources/groups.ts`):

- **`add-mcp-server` is an upsert.** Re-running it with an existing `--name`
  replaces that entry — that's how you "edit" a server.
- **It rebuilds the whole entry.** Omitting `--args` or `--env` writes `[]`/`{}`
  over whatever was there. Always pass the complete array/object.
- **`instructions` is unreachable from the CLI.** `McpServerConfig` supports an
  `instructions` string (composed into the group's CLAUDE.md by
  `claude-md-compose.ts`), but `add-mcp-server` never writes it — so an upsert
  *drops* an existing one. Set it with a direct DB write if you need it.

Values are passed to the Agent SDK verbatim (`container/agent-runner/src/index.ts`).
There is **no `${VAR}` interpolation** in `args` — a credential that must appear
inside a URL has to be literal in the config.

### Two different `env` layers

| Layer | Command | Applied as | Seen by |
|---|---|---|---|
| MCP server env | `add-mcp-server --env` | the MCP child process's env | that server only |
| Container env | `config update --env` | `docker run -e KEY=VALUE` | everything in the container |

Both are whole-object overwrites; `--env ""` clears the container one. Per-group
container env is applied *after* the provider's block, so it wins on conflicts
(`src/container-runner.ts`).

## Mounting host state into a container

Mounts are validated against an allowlist that lives **outside** the project root,
at `~/.config/nanoclaw/mount-allowlist.json`, so a container agent cannot edit the
rules that govern it. Validation is in `src/modules/mount-security/index.ts`.

There are four rules, and three of them will bite you.

### 1. The container path must be relative — and you don't choose it

Absolute paths fail `isValidContainerPath` ("must be relative, non-empty, and not
contain `..`"). Even when accepted, every mount is forced to:

```
/workspace/extra/<containerPath>
```

So `--container zoho-auth` lands at `/workspace/extra/zoho-auth`. Point your
server's config at *that* path, not at the one you asked for.

### 2. The allowlist must name an allowed root

With no allowlist file, or with `"allowedRoots": []`, **every** additional mount
is rejected. Configure it via the `/manage-mounts` skill or directly:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json \
  '{"allowedRoots":[{"path":"/home/<user>/mcp-auth","allowReadWrite":true}],"blockedPatterns":[]}'
```

Read-only is **per-root**. A root without `allowReadWrite` (or with
`readOnly: true`) forces every mount under it read-only. A top-level
`nonMainReadOnly` key is not supported — it is warned about and ignored.

### 3. Blocked patterns are absolute, and one of them is `.config/nanoclaw`

19 default patterns (`.ssh`, `.aws`, `.env`, `.npmrc`, `credentials`,
`.local/bin`, …) are merged with whatever the file lists. They are matched as
**substrings of the mount root's realpath**.

`.config/nanoclaw` is on that list, so nothing under it can ever be mounted — put
MCP token caches somewhere else (`~/mcp-auth/<service>` works well).

> **Security scope:** the pattern check runs once, against the mount *root*, and
> does not descend. Allowlisting `~` mounts every credential below it regardless
> of what the blocked list says. Do not read an entry there as "this file is safe."

### 4. `add-mount` cannot create a read-write mount

`validateMount` grants read-write only when the mount JSON has `readonly`
explicitly `false`. But `ncl groups config add-mount` writes `readonly: true` or
omits the key entirely — never `false`. A read-write mount needs a direct DB
write:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "update container_configs set additional_mounts = '[{\"hostPath\":\"/home/<user>/mcp-auth/<svc>\",\"containerPath\":\"<svc>-auth\",\"readonly\":false}]' where agent_group_id = '<group-id>'"
```

This matters for any MCP server that refreshes a token or writes a lockfile.

### Dry-run a mount without spawning a container

Rejections only appear in `logs/nanoclaw.error.log`. To check a mount before
restarting anything, call the validator directly from the repo root:

```bash
cat > mount-probe.ts <<'EOF'
import { validateAdditionalMounts } from './src/modules/mount-security/index.js';
console.log(JSON.stringify(validateAdditionalMounts(
  [{ hostPath: '/home/<user>/mcp-auth/<svc>', containerPath: '<svc>-auth', readonly: false }],
  'probe',
), null, 2));
EOF
pnpm exec tsx mount-probe.ts && rm mount-probe.ts
```

An accepted mount prints its resolved `/workspace/extra/...` path and effective
`readonly`. A rejected one prints nothing and logs the reason.

## OAuth-protected remote MCP servers

Many hosted MCP servers (Zoho, Notion, Linear, …) implement the MCP spec's OAuth
2.1 flow: dynamic client registration, PKCE, browser consent. Signs you are
looking at one:

```
HTTP/1.1 401
WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
```

Fetch that URL and the authorization-server metadata to see the grant types. If
they are only `authorization_code` + `refresh_token`, **there is no static token
and no machine-to-machine path** — a browser has to consent once. An ID that
appears in the server's URL path is a *resource identifier*, not a credential;
changing it will not fix a 401.

These servers are reached through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote),
a stdio↔HTTP proxy that performs the OAuth dance and caches tokens on disk. Inside
a NanoClaw container that fails twice over — no browser, and containers run
`--rm` — so **authorize once on the host and mount the token cache in**.

### ⚠️ Pin the version — the token directory is one patch behind

`mcp-remote` reads and writes `$MCP_REMOTE_CONFIG_DIR/mcp-remote-<version>/`,
where `<version>` is a constant embedded in the published bundle that **lags the
npm version by one patch**:

| `npx mcp-remote@X` | reads/writes |
|---|---|
| `@0.1.35` | `mcp-remote-0.1.34/` |
| `@0.1.36` | `mcp-remote-0.1.35/` |
| `@0.1.37` | `mcp-remote-0.1.36/` |
| `@0.1.38` | `mcp-remote-0.1.37/` |

Two consequences:

- **Always pin the version in `--args`.** Unpinned `npx -y mcp-remote` starts
  reading a different directory the day a new version ships.
- **Do not infer the package version from the directory name.** Tokens in
  `mcp-remote-0.1.35/` were written by package `0.1.36`.

When the directory doesn't match, mcp-remote finds no tokens and falls through to
a full browser re-auth **with no error message** — `readJsonFile` swallows ENOENT.
Valid tokens on disk plus an authorization prompt is the signature of this bug.

### Authorizing from a headless host

Run the flow on the host with a fixed callback port:

```bash
mkdir -p ~/mcp-auth/<svc> && chmod 700 ~/mcp-auth/<svc>
SERVER_URL='https://<host>/mcp/<id>/message'
MCP_REMOTE_CONFIG_DIR=~/mcp-auth/<svc> \
  npx -y mcp-remote@<pinned> "$SERVER_URL" 3334 --transport http-only
```

It prints an authorization URL and waits. From a machine with a browser, forward
the callback port and open that URL:

```bash
ssh -L 3334:localhost:3334 <user>@<host>
```

The redirect targets `http://localhost:3334/oauth/callback`, which the tunnel
carries back to the server. Confirm `*_tokens.json` exists, then `Ctrl-C`.

> Set long URLs via a shell variable first. A newline injected mid-URL by a
> terminal paste produces confusing server-side errors (a 404
> `INVALID_URL_PATTERN` rather than anything auth-related).

### Wiring it up

```bash
# 1. mount the cache read-write (see rule 4 — needs the DB write)
# 2. point the server at where the mount actually lands
ncl groups config add-mcp-server --id <group-id> --name <name> --command npx \
  --args '["-y","mcp-remote@<pinned>","https://<host>/mcp/<id>/message","--transport","http-only"]' \
  --env '{"MCP_REMOTE_CONFIG_DIR":"/workspace/extra/<svc>-auth"}'
# 3. restart
ncl groups restart --id <group-id>
```

The mount must be read-write: mcp-remote rewrites `_tokens.json` on every refresh
and writes a `lock.json` at startup.

## Adding a second OAuth server

Once one OAuth server is working, additional ones are much cheaper. `mcp-remote`
namespaces every file by `md5(serverUrl)` — `<hash>_tokens.json`,
`<hash>_client_info.json`, `<hash>_lock.json` — so **multiple servers share a
single `MCP_REMOTE_CONFIG_DIR` with no collision**.

That means a second server needs **no new mount and no new allowlist root**. Only:

1. Its own authorization (a distinct resource, distinct consent).
2. A distinct `--name` in `add-mcp-server`.

Reuse the same `MCP_REMOTE_CONFIG_DIR` and the same pinned version. Authorize one
at a time — concurrent flows would contend for the same callback port.

### Verify the URL by its hash

Because the cache filename *is* the md5 of the server URL, you can prove a URL is
byte-perfect and belongs to a given token set without connecting to anything:

```bash
printf '%s' "$SERVER_URL" | md5sum      # must equal the <hash> prefix in the cache dir
```

This catches the most common setup failure — a terminal paste that injects a
newline mid-URL, which otherwise surfaces as a confusing server-side 404 rather
than anything auth-shaped. Run it before writing any config.

### Handling a secret-bearing URL

When the server URL embeds a key you would rather not put in shell history or
paste into a chat transcript, capture it once into a file and build the config
from that file:

```bash
read -rp 'MCP server URL: ' U && printf '%s' "$U" > ~/.<svc>-url && chmod 600 ~/.<svc>-url && printf '%s' "$U" | md5sum
```

`read` keeps the value out of history. Then build the `--args` JSON from the file
rather than retyping the URL:

```bash
ARGS=$(python3 -c "import json;u=open('$HOME/.<svc>-url').read().strip();print(json.dumps(['-y','mcp-remote@<pinned>',u,'--transport','http-only']))")
ncl groups config add-mcp-server --id <group-id> --name <Name> --command npx --args "$ARGS" --env '{"MCP_REMOTE_CONFIG_DIR":"/workspace/extra/<svc>-auth"}'
```

Pipe command output through `sed -E 's#/mcp/[a-f0-9]+/message#/mcp/<redacted>/message#g'`
if you are sharing a terminal or transcript.

### Splitting one server into several

Providers that expose a very wide tool surface are often better split into
narrower servers — one per capability, each with its own key and its own OAuth
grant. The benefit is scope isolation: each token carries only the scopes its
tools need, so a compromised or over-permissive grant has a smaller blast radius.

The cost is one authorization flow per server, and one `npx` process per server
inside the container. Note that on a cold container every server downloads the
pinned package in parallel — with several servers this is the most likely cause of
a timeout on the first message after a restart. Bake the package into a per-group
image (see [Notes](#notes)) once you have more than one or two.

## Refreshing after a tool or scope change

The tool list is fetched **once, at MCP session initialization** — which happens
when the agent-runner spawns the server, i.e. at container start. Refreshing
therefore always means respawning the container. Whether that is *sufficient*
depends on what changed.

**Tools changed, scopes unchanged** (the common case, and always true when tools
are *removed*):

```bash
ncl groups restart --id <group-id>    # then message the agent to respawn it
```

**New tools need new OAuth scopes** — a restart will not help. The granted scope
set is frozen into the token at authorization time, and a refresh returns the
same set, so a tool needing an unconsented scope 403s forever. Compare what you
hold against what the server offers:

```bash
python3 -c "import json;print(json.load(open('<cache>/<hash>_tokens.json'))['scope'])" \
  | tr ' ' '\n' | sort > /tmp/have.txt
curl -s https://<host>/.well-known/oauth-protected-resource \
  | python3 -c "import json,sys;print('\n'.join(sorted(json.load(sys.stdin)['scopes_supported'])))" > /tmp/offered.txt
diff /tmp/have.txt /tmp/offered.txt
```

An empty diff means you always fall in the restart-only case. To pick up new
scopes, back up the cache, delete the **whole** version directory (not just
`_tokens.json`, so the client re-registers), and redo the authorization flow with
the same pinned version.

### Diffing the tool list without a container

Queries the server directly, so it shows what the agent will see on its next
spawn. Handles both plain-JSON and SSE (`data: `) responses — the same server may
return either:

```bash
TOK=$(python3 -c "import json;print(json.load(open('<cache>/<hash>_tokens.json'))['access_token'])")
curl -s -X POST "<server-url>" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | python3 -c "
import sys, json
raw = sys.stdin.read()
for line in raw.splitlines():
    if line.startswith('data: '): raw = line[6:]
print('\n'.join(sorted(t['name'] for t in json.loads(raw)['result']['tools'])))"
```

> **No per-tool filtering.** NanoClaw allows MCP tools by wildcard per server
> (`mcp__<server>__*`, `container/agent-runner/src/providers/claude.ts`), so every
> tool the server exposes reaches the agent. Narrowing the surface has to happen
> on the provider's side.

## Using the cached token outside MCP

The file `mcp-remote` caches is an ordinary OAuth access token carrying the scopes
you consented to — and it is frequently **not** audience-bound to the MCP endpoint,
even when the authorization request included a `resource` parameter. Where that
holds, the same bearer works against the provider's regular REST API.

This matters because **MCP tool surfaces are usually narrower than the API behind
them**. Zoho's WorkDrive MCP server, for example, exposes 17 tools and no file
upload at all (`createNativeDocument` creates an *empty* native document with no
content parameter) — but the REST upload endpoint accepts the MCP-issued token
directly.

Probe it with a harmless GET before relying on it. Note the auth header form is
provider-specific — Zoho uses `Zoho-oauthtoken`, most use `Bearer`:

```bash
TOK=$(python3 -c "import json;print(json.load(open('<cache>/<hash>_tokens.json'))['access_token'])")
curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://<api-host>/<probe-path>" \
  -H "Authorization: <scheme> $TOK"
```

A `200` means the whole API is reachable within your granted scopes. A `401`
means the provider does bind tokens to the resource, and you are limited to what
the MCP server exposes.

> **Security: this is a full provider credential, not "just an MCP token."**
> Anything that can read the cache directory holds every scope in the grant — and
> that includes every agent container the directory is mounted into, read-write.
> A cache holding `files.CREATE` is write access to the user's drive regardless of
> how read-only the MCP tool list looks. Two consequences:
>
> - Mount a cache only into groups that should have the whole grant.
> - Prefer several narrow servers over one wide one (see
>   [Splitting one server into several](#splitting-one-server-into-several)) —
>   scope isolation at the grant is the only isolation there is here, since
>   NanoClaw does no per-tool filtering.

## Verification

Some obvious checks do not work here. In rough order of trustworthiness:

```bash
# 1. Is the mount actually there? (authoritative)
docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'

# 2. Can the container see the files?
docker exec <container> ls /workspace/extra/<svc>-auth/mcp-remote-<dir-version>/

# 3. Did the runner load the server and the mount?
docker logs <container> 2>&1 | grep -E "Additional (MCP server|directories)"

# 4. Was a mount rejected?
grep "Additional mount REJECTED" logs/nanoclaw.error.log | tail

# 5. Does the server actually connect? (run it inside the container)
docker exec -e MCP_REMOTE_CONFIG_DIR=/workspace/extra/<svc>-auth <container> \
  sh -c 'timeout 60 npx -y mcp-remote@<pinned> "<url>" --transport http-only < /dev/null 2>&1 | head'
# want: "Connected to remote server using StreamableHTTPClientTransport"
```

**What does not work:**

- `ncl groups config get` shows the *requested* mount, not whether it was accepted.
- The OneCLI `request_logs` table is not a reliable signal — `mcp-remote` traffic
  did not appear there across known-working runs.
- `ncl groups restart` **without `--message` does not respawn** the container; it
  comes back on the next user message. `docker ps` returning nothing right after a
  restart is expected, not a failure.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Mount missing from `docker inspect`, no CLI error | Rejected — check `logs/nanoclaw.error.log` |
| "Invalid container path" | `--container` was absolute; must be relative |
| "not under any allowed root" | Allowlist empty or missing the root |
| "matches blocked pattern" | Path is under `.config/nanoclaw`, `.ssh`, `.env`, … |
| Mount present but `rw=false` | `readonly` is absent/`true`; needs explicit `false` in the DB |
| Browser auth prompt despite valid tokens on disk | Version/dir mismatch — see the pin table |
| Server times out ~30s on first message after restart | `npx` cold download; bake it in with `config add-package --npm <pkg>@<ver>` + `restart --rebuild` |
| Agent insists the integration "can't work" after a fix | Stale resumed session — say the fix landed explicitly, or clear the session |
| `md5` of the URL doesn't match the cache filename prefix | Paste mangled the URL (usually an injected newline) |
| `ncl groups restart` reports `restarted: 0` | Nothing was running — expected; it respawns on the next message |

## Notes

- **npm cache is not persisted.** Each new container re-downloads the pinned
  package before the server can connect. If that pushes past the SDK's startup
  timeout, bake it into a per-group image with
  `ncl groups config add-package --id <group-id> --npm <pkg>@<version>` and
  `ncl groups restart --id <group-id> --rebuild`.
- **The OneCLI gateway is not in the way.** It passes a client-supplied
  `Authorization` header through untouched (verified against a proxied request),
  so an OAuth MCP server needs no `NO_PROXY` entry.
- **Refresh tokens eventually expire.** There is no unattended re-auth path for
  `authorization_code`-only servers — budget for repeating the tunnel flow, using
  the *same pinned version*.
