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
  its own repo. The NanoClaw-specific knowledge lives in the config, the
  `ncl-help` discovery parser, and `public/overview.js`.

## Run

Prerequisite: whatever CLI you point it at has to work. For `ncl` that means the
NanoClaw host must be running — `ncl` talks to `data/ncl.sock`, so with the host
stopped every clidash panel reports "cannot reach NanoClaw host". Check with
`ncl groups list` before starting clidash.

```bash
cp clidash.config.example.json clidash.config.json   # then edit paths if needed
node server.js                                        # uses ./clidash.config.json
CLIDASH_CONFIG=/path/to.json node server.js
PORT=4690 BIND=127.0.0.1 node server.js               # env overrides
```

Run it from `tools/clidash/`; the example config uses paths relative to the
NanoClaw root two levels up, so it works out of the box (`bin/ncl` ships with
NanoClaw — there is nothing to build).

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

Two top-level knobs govern how hard clidash drives the CLI. Both are optional:

| Key | Default | Purpose |
|---|---|---|
| `execTimeoutMs` | `30000` | per-exec timeout, measured from spawn |
| `maxConcurrentExecs` | `availableParallelism()`, clamped to 2–6 | how many CLI processes may run at once |

They matter because the CLIs clidash drives are usually scripts, not compiled
binaries: NanoClaw's `bin/ncl` execs `pnpm exec tsx src/cli/client.ts`, ~0.7s of
CPU per call on an idle 2-vCPU host. A refresh asks for every resource at once,
so without a cap those processes fight over the same cores and all trip the
timeout together. Queueing them keeps each call near its idle cost; a queued
call is never killed for waiting its turn.

## API

| Route | Returns |
|---|---|
| `GET /api/clis` | configured CLIs + discovered/static resources (discovery cached 60s) |
| `GET /api/r/<cli>/<resource>` | `{ok, rows, command, fetchedAt}` — coalesced per cli+resource |
| `GET /api/cmd/<cli>/<cmd>?resource=&id=` | one drill-down command (`get`, `config-get`, …) |
| `GET /api/help/<cli>/<resource>` | raw `<cli> <resource> help` text, cached for the process lifetime |
| `GET /api/activity` | per-session inbound/outbound totals + a daily series, read from the session DBs |
| `GET /api/logs`, `GET /api/log/<name>` | the allowlist, and a tail of one entry (`missing:true` when it does not exist yet) |
| `GET /api/docs`, `GET /api/doc?c=&p=` | file-viewer collections, and one file's contents |

The only derived page is the Agents overview, and it is derived in the browser:
`public/overview.js` joins the groups / sessions / wirings / messaging-groups
rows the UI already holds with the activity totals and per-group container
config into status cards (green <15m / amber <2h / red older). It is a pure
function, unit-tested in `test/overview.test.js`, so the tested code and the
rendered code are the same code — and it costs no extra CLI execs, which a
server-side join would.

## Test

```bash
npm test            # unit + integration (node:test, stub CLI — no real CLI needed)
./test/smoke.sh     # against a running instance
```

`test/fixtures/ncl-help.txt` is a captured snapshot of `ncl help`. Nothing
asserts an exact resource list against it, so it only needs refreshing when you
want the fixture to look current: `ncl help > test/fixtures/ncl-help.txt`.

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
