# Central DB — SeekDB backend

NanoClaw v2 uses **three** database kinds. This document covers optional **SeekDB** for the **central admin DB only** (`data/v2.db` equivalent).

| DB | Default | SeekDB backend |
|----|---------|----------------|
| Central (`agent_groups`, `sessions`, wiring, …) | SQLite `data/v2.db` | Official [`seekdb`](https://www.npmjs.com/package/seekdb) npm SDK |
| Session `inbound.db` / `outbound.db` | SQLite files (host ↔ container) | **Always SQLite** — cross-mount invariants require file DB + `journal_mode=DELETE` |

## Why session DBs stay on SQLite

The container agent reads `inbound.db` read-only across a Docker/virtiofs mount. WAL mode does not propagate reliably; the design is documented in [db-session.md](db-session.md) and `container/agent-runner/src/db/connection.ts`. SeekDB cannot replace those per-session files without a full architecture change.

## Embedded mode (recommended)

No Docker required. Embedded data defaults to `./seekdb.db` in the project root.

```bash
# .env — embedded is the default (omit SEEKDB_HOST / SEEKDB_PORT)
NANOCLAW_CENTRAL_DB_BACKEND=seekdb
# SEEKDB_PATH=seekdb.db   # optional override (resolved from project root)
SEEKDB_DATABASE=test
```

On first boot the host uses `AdminClient` to create the logical database, then `SeekdbClient` runs migrations (MySQL dialect: `ENGINE=InnoDB`, etc.).

**Native bindings:** embedded mode needs `@seekdb/js-bindings` (optional dependency of `seekdb`). First `pnpm install` may compile native code; if install fails on your platform, use `NANOCLAW_CENTRAL_DB_BACKEND=sqlite` or server mode below.

## Server mode (optional)

Connect to a running SeekDB instance (MySQL protocol on port 2881):

```bash
docker run -d \
  --name seekdb \
  -p 2881:2881 \
  -p 2886:2886 \
  -v ./seekdb-data:/var/lib/oceanbase \
  oceanbase/seekdb:latest
```

```bash
# .env — server when SEEKDB_HOST and/or SEEKDB_PORT is set
NANOCLAW_CENTRAL_DB_BACKEND=seekdb
SEEKDB_HOST=127.0.0.1
SEEKDB_PORT=2881
SEEKDB_USER=root
SEEKDB_PASSWORD=
SEEKDB_DATABASE=test
```

Default central backend remains `NANOCLAW_CENTRAL_DB_BACKEND=sqlite`.

## Adapter layout

```
src/db/central/
  types.ts       — ICentralDb / SeekDbCentralDbOptions
  sqlite.ts      — better-sqlite3 (default)
  seekdb.ts           — SeekDB via worker-thread sync RPC, MySQL dialect
  seekdb-worker.ts    — async SeekdbClient / AdminClient in worker
  sql-params.ts       — @name → ? binding; splits multi-statement exec
  factory.ts          — createCentralDb(backend, options)
src/db/connection.ts — initDb / getDb / ensureCentralDatabaseExists
```

All `src/db/*.ts` CRUD modules call `getDb()` and do not import `better-sqlite3` directly.

## Manual verification (optional)

Not run by default `pnpm test` (native bindings, ~10–15s). Uses the same defaults as production: `SEEKDB_PATH=./seekdb.db`, `SEEKDB_DATABASE=test`. Requires `@seekdb/js-bindings` for embedded.

```bash
pnpm test:seekdb
# Server (set SEEKDB_HOST / SEEKDB_PORT in .env or env, e.g. port 2882):
pnpm test:seekdb:server
```

## Troubleshooting

| Symptom | Action |
|---------|--------|
| `@seekdb/js-bindings` install fails | Use `sqlite` backend or set `SEEKDB_HOST` / `SEEKDB_PORT` for server mode |
| Connection refused (server) | Check Docker / port 2881 |
| Migration errors | Compare `src/db/migrations/*-mysql.ts` with SeekDB version |

## Future: vector / hybrid search

SeekDB vector and full-text APIs (`@seekdb/default-embed`, Collection API) are not wired into NanoClaw yet. A follow-up could add optional memory/RAG while keeping the entity model in relational tables.
