---
name: add-clidash
description: Add clidash — a zero-dependency, read-only web dashboard that derives its tabs and tables at runtime from any CLI that lists resources as JSON. Ships pre-wired for NanoClaw's ncl CLI (agent groups, sessions, channels, users, roles), plus message-activity charts, a log tail, and a read-only file viewer for group skills/CLAUDE.md/profiles.
---

# /add-clidash — CLI-derived read-only dashboard

clidash is a small, read-only web dashboard. You point it at any CLI that can
list resources as JSON (NanoClaw's `ncl`, `docker`, `kubectl`, …) and it builds
the dashboard at runtime: one tab per resource, a generic table over whatever
columns the rows have. A new `ncl` resource becomes a new tab and a new column
becomes a new table column with **zero code changes**.

It ships pre-wired for NanoClaw's `ncl` CLI and adds three NanoClaw-aware
panels driven entirely by config:

- **Agents overview** — status cards joining groups + sessions + messaging
  groups + wirings (green <15m / amber <2h / red older).
- **Activity** — per-session inbound/outbound message totals and a daily series,
  read directly from the session DBs (`ncl` has no messages resource).
- **Logs** — last N lines of allowlisted host log files.
- **Files** — a read-only viewer for group skills, `CLAUDE.md`, and profiles.

## Why it's safe

clidash is **read-only by construction**: the server can only `execFile` the
argv templates in its config. `{resource}` is the sole substitution and is
allowlist-validated against the discovered/static resource set before exec —
never a shell, no free-form input reaches argv. There is no auth; **the network
is the auth boundary** — it binds `127.0.0.1` by default. Only ever bind a
private interface (e.g. a tailnet IP), never a public one.

It's distinct from `/add-dashboard` (which pushes JSON snapshots to a separate
`@nanoco/nanoclaw-dashboard` npm package): clidash has **zero dependencies**, no
build step, no push pipeline, and no edits to NanoClaw source — it just reads
`ncl` and the session DBs.

## Prerequisites

**The NanoClaw host must be running.** clidash shells out to `ncl`, and `ncl`
reaches the host over a Unix socket at `data/ncl.sock` — with the host stopped
every panel reports `cannot reach NanoClaw host`. Confirm before you start:

```bash
bin/ncl groups list
```

If that errors, start the host (`systemctl --user start nanoclaw`,
`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`, or `pnpm run dev`) and retry.

Node ≥ 22.5 is required (clidash reads the session DBs via `node:sqlite`).

## Steps

### 1. Copy the tool into place

clidash is fully self-contained — copy the whole directory in:

`tools/` is not a standard NanoClaw directory and `cp -R` won't create it, so
make it first:

```bash
mkdir -p tools
cp -R .claude/skills/add-clidash/add/tools/clidash tools/clidash
```

That is the only file change this skill makes. Nothing in NanoClaw `src/` is
touched, no dependency is added.

### 2. Create the config

The example config is pre-wired for NanoClaw with paths relative to the repo
root, so it works as-is when you run clidash from `tools/clidash/`:

```bash
cd tools/clidash
cp clidash.config.example.json clidash.config.json
```

`clidash.config.json` is your local config — add it to `.gitignore` if you
don't want to commit install-specific paths:

```bash
echo 'tools/clidash/clidash.config.json' >> ../../.gitignore
```

`bin/ncl` ships with NanoClaw (a shell wrapper around
`pnpm exec tsx src/cli/client.ts`) — there is nothing to build. If your checkout
layout differs, point `clis.ncl.bin` at your `ncl` launcher and `clis.ncl.cwd` at
the repo root.

### 3. Test

Tests use a stub CLI — no real `ncl` or `docker` needed:

```bash
npm test
```

All tests should pass (Node ≥ 22.5, `node:test`, zero dependencies).

### 4. Run and verify

```bash
node server.js          # serves http://127.0.0.1:4690
```

In another shell, run the bundled smoke test. It checks discovery, two real
`ncl` resource tables, the three filesystem-backed panels, and the static UI —
the same endpoints the dashboard's own refresh cycle drives:

```bash
./test/smoke.sh                             # defaults to http://127.0.0.1:4690
./test/smoke.sh http://127.0.0.1:4690       # or name the base URL
```

Every line should read `OK`. A failure on `/api/clis` or `/api/r/...` almost
always means the host isn't running (see Prerequisites).

Then open `http://127.0.0.1:4690/` in a browser. You should see the Agents
overview plus a tab per `ncl` resource.

### 5. (Optional) Run as a service

clidash binds `127.0.0.1` by default. To reach it from other devices, bind a
private (e.g. tailnet) IP via the `BIND` env var or `bind` in config — never a
public interface.

```ini
# ~/.config/systemd/user/clidash.service   (Linux)
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

```bash
systemctl --user enable --now clidash
```

On macOS, wrap `node server.js` (with `WorkingDirectory` = `tools/clidash`) in a
launchd plist the same way the main NanoClaw service is configured.

## Configuration reference

`clidash.config.json` keys (see `tools/clidash/README.md` and
`clidash.config.example.json` for the full shape):

| Key | Purpose |
|-----|---------|
| `port`, `bind`, `refreshSeconds` | server bind + UI auto-refresh cadence |
| `clis.<name>.bin` / `cwd` / `env` | how to invoke the CLI (`bin` is relative to `cwd`) |
| `clis.<name>.discover` or `resources` | runtime discovery (`ncl help`) vs a static resource list |
| `clis.<name>.list` | argv template; `{resource}` is the only substitution |
| `clis.<name>.output` | `json` or `jsonlines` (docker/kubectl style) |
| `clis.<name>.unwrap` | dot-path into a response envelope (e.g. `data`) |
| `clis.<name>.enrich`/`badges`/`summary` | table decorations (ID→name joins, status colors, summary cards) |
| `activity` | `sessionsRoot` + `days` for the message-activity charts |
| `logs` | `dir`, `tailLines`, and an allowlist of `files` to tail |
| `docs` | file viewer: `root`, a `deny` glob list, and `collections` of glob patterns |
| `execTimeoutMs` | per-exec timeout, measured from spawn (default `30000`) |
| `maxConcurrentExecs` | how many CLI processes may run at once (default: this host's parallelism, clamped to 2–6) |

The last two matter because `bin/ncl` is a script, not a compiled binary — each
call pays a pnpm resolve plus a TypeScript transpile (~0.7s of CPU on an idle
2-vCPU host). A dashboard refresh asks for every resource at once, so clidash
queues those execs a few at a time; unqueued they would fight over the same
cores and all trip the timeout together. Lower `maxConcurrentExecs` on a busy or
single-core host, raise it on a big one.

Adding a second CLI is config-only — e.g. `docker` is included as a `jsonlines`
example. The only per-CLI *code* is a discovery parser in `parsers.js`, and only
for CLIs that need runtime discovery instead of a static `resources` list.

## Troubleshooting

- **`ENOENT` / config not found** — run from `tools/clidash/` and make sure you
  copied `clidash.config.example.json` to `clidash.config.json` (step 2), or set
  `CLIDASH_CONFIG=/abs/path.json`.
- **No `ncl` resources / discovery empty** — most often the host isn't running,
  and `ncl` is printing `cannot reach NanoClaw host`. Start it (see
  Prerequisites), then check `clis.ncl.bin` / `clis.ncl.cwd`.
- **Every tab reports a timeout** — the host is CPU-starved and the exec queue
  can't drain inside `execTimeoutMs`. Lower `maxConcurrentExecs` to 2, or raise
  `execTimeoutMs`.
- **docker tab errors** — the docker daemon isn't running, or remove the
  `docker` CLI from config if you don't need it.
- **Can't reach it from another device** — it binds `127.0.0.1`; set
  `BIND=<private-ip>` (tailnet), never a public interface.
- **Empty Activity/Logs/Files** — check that `activity.sessionsRoot`,
  `logs.dir`, and `docs.root` resolve to your NanoClaw root (relative to where
  you launch `node server.js`).
- **A Logs tab says "this log file does not exist"** — expected, not a
  misconfiguration. `logs/nanoclaw.log` and `logs/nanoclaw.error.log` exist only
  because the service redirects the host's stdout/stderr into them, so an
  install running via `pnpm run dev` has neither, and a healthy service install
  has no error log until something errors.

## Removal

See [REMOVE.md](REMOVE.md).
