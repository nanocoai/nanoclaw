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

The example assumes `ncl` is built at `bin/ncl`. If `bin/ncl` doesn't exist,
build it first (`pnpm run build`) or point `clis.ncl.bin` at the right path.

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

In another shell, confirm it's live and that `ncl` discovery worked:

```bash
curl -s http://127.0.0.1:4690/api/clis | head -c 400      # CLIs + discovered resources
curl -s http://127.0.0.1:4690/api/r/ncl/groups | head -c 400   # a real resource table
```

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

Adding a second CLI is config-only — e.g. `docker` is included as a `jsonlines`
example. View plugins (`views/<cli>-<view>.js`) are the only per-CLI code and
are optional.

## Troubleshooting

- **`ENOENT` / config not found** — run from `tools/clidash/` and make sure you
  copied `clidash.config.example.json` to `clidash.config.json` (step 2), or set
  `CLIDASH_CONFIG=/abs/path.json`.
- **No `ncl` resources / discovery empty** — `bin/ncl` isn't built or the path
  is wrong. Build it (`pnpm run build`) or fix `clis.ncl.bin`.
- **docker tab errors** — the docker daemon isn't running, or remove the
  `docker` CLI from config if you don't need it.
- **Can't reach it from another device** — it binds `127.0.0.1`; set
  `BIND=<private-ip>` (tailnet), never a public interface.
- **Empty Activity/Logs/Files** — check that `activity.sessionsRoot`,
  `logs.dir`, and `docs.root` resolve to your NanoClaw root (relative to where
  you launch `node server.js`).

## Removal

See [REMOVE.md](REMOVE.md).
