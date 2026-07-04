# clidash

CLI-agnostic **read-only** web dashboard. Point it at any CLI that can list
resources as JSON and it derives the dashboard at runtime: one tab per
resource, a generic table over whatever columns the rows have. New resource →
new tab; new column → new table column; **zero code changes**.

It ships pre-wired for NanoClaw's `ncl` CLI (agent groups, sessions, messaging
groups, wirings, users, roles, …) plus `docker`, but the same config shape
works for any list-as-JSON CLI.

- **Zero dependencies** — Node built-ins only (Node ≥ 22.5, for `node:sqlite`),
  no build step,
  vanilla-JS frontend.
- **Read-only by construction** — the server can only `execFile` the configured
  argv templates; `{resource}` is the sole substitution and is validated
  against the discovered/static resource allowlist. Never a shell.
- **Standalone** — no imports from NanoClaw source; the core is extractable to
  its own repo. The NanoClaw-specific knowledge lives entirely in the config
  and in the `views/ncl-overview.js` view plugin.

## Run

```bash
cp clidash.config.example.json clidash.config.json   # then edit paths if needed
node server.js                                        # uses ./clidash.config.json
CLIDASH_CONFIG=/path/to.json node server.js
PORT=4690 BIND=127.0.0.1 node server.js               # env overrides
```

Run it from `tools/clidash/`; the example config uses paths relative to the
NanoClaw root two levels up, so it works out of the box once `ncl` is built.

## Configure (`clidash.config.json`)

```jsonc
{
  "port": 4690,
  "bind": "127.0.0.1",          // never a public interface; a tailnet IP at most
  "refreshSeconds": 60,
  "clis": {
    "ncl": {
      "bin": "bin/ncl",                                        // relative to cwd below
      "cwd": "../..",                                           // the NanoClaw root
      "discover": { "args": ["help"], "parser": "ncl-help" },   // runtime resource discovery
      "list": ["{resource}", "list", "--json"],                 // argv template
      "output": "json",          // or "jsonlines" (docker/kubectl style)
      "unwrap": "data"           // dot-path into a response envelope
    },
    "docker": {
      "bin": "docker",
      "resources": ["ps", "images"],          // static alternative to discover
      "list": ["{resource}", "--format", "{{json .}}"],
      "output": "jsonlines"
    }
  }
}
```

`{resource}` may appear as a whole argv element or inside one — e.g. a remote
CLI via ssh: `"list": ["-i", "key.pem", "user@host", "ncl {resource} list --json"]`.

Per-CLI `env` (merged over the server's env) and `cwd` are supported. See
`clidash.config.example.json` for the full NanoClaw config, including the
`enrich`/`badges`/`summary` table decorations and the `activity`/`logs`/`docs`
sections.

## API

| Route | Returns |
|---|---|
| `GET /api/clis` | configured CLIs + discovered/static resources (discovery cached 60s) |
| `GET /api/r/<cli>/<resource>` | `{ok, rows, fetchedAt}` — coalesced, 10s exec timeout |
| `GET /api/view/<cli>/<view>` | curated view plugin from `views/<cli>-<view>.js` |

View plugins are the only per-CLI *code*, and optional: a default-exported
async function receiving `{ fetch }` (bound to that CLI) returning JSON.
`views/ncl-overview.js` joins groups + sessions + messaging-groups + wirings
into per-agent status cards (green <15m / amber <2h / red older).

## Test

```bash
npm test            # unit + integration (node:test, stub CLI — no real CLI needed)
./test/smoke.sh     # against a running instance
```

## Deploy as a service

clidash binds `127.0.0.1` by default. To reach it from other devices, bind a
private (e.g. tailnet) IP — **never a public interface**; the network is the
auth boundary. Example systemd user service:

```ini
# ~/.config/systemd/user/clidash.service
[Unit]
Description=clidash read-only CLI dashboard

[Service]
WorkingDirectory=%h/nanoclaw/tools/clidash
ExecStart=/usr/bin/node %h/nanoclaw/tools/clidash/server.js
Environment=BIND=127.0.0.1
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now clidash`.
