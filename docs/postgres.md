# PostgreSQL central database

The `add-central-postgresql` skill stores NanoClaw's central system state in PostgreSQL 15 or newer. It does not replace the per-session mailboxes: `inbound.db` and `outbound.db` remain direct SQLite files with `journal_mode=DELETE` for cross-mount visibility.

The PostgreSQL database must use the libc locale provider and `C` collation. An ICU-provider database whose `datcollate` happens to say `C` is not compatible. Startup checks the server version, locale provider, collation, and schema accessibility before accepting traffic.

## Configuration

Use a DML-only runtime role and a separate schema-owner migration role. Neither URL may contain a password.

| Variable | Process | Purpose |
| --- | --- | --- |
| `NANOCLAW_DB_URL` | host, tools | Passwordless runtime PostgreSQL URL. |
| `NANOCLAW_DB_PASSWORD_FILE` | host, tools | Runtime password file; mode `0400` or `0600`. |
| `NANOCLAW_DB_MIGRATE_URL` | migration/import only | Passwordless schema-owner URL. |
| `NANOCLAW_DB_MIGRATE_PASSWORD_FILE` | migration/import only | Owner password file; mode `0400` or `0600`. |
| `NANOCLAW_DB_SCHEMA` | all | Lowercase application schema; default `nanoclaw`. |

`NANOCLAW_TEST_DB_URL` is test-only. It may contain a password because it names a disposable database, and its database name must begin with `nanoclaw_test`.

Mount the owner password file only into the one-shot migration/import process. Do not mount it into the long-running host. The host reads only the runtime URL and runtime password file for its `host` role. A missing, empty, or over-permissive password file fails loudly.

There is no host-lock switch. A PostgreSQL-backed host always takes the singleton advisory lock. Tooling and migration roles never take that host lock.

## Provision and migrate

Create the database with the libc provider and `C` collation. Create a schema-owner login and a separate runtime login. With the five variables above present, run:

```bash
pnpm exec tsx scripts/pg-preflight.ts
pnpm run migrate
```

The first migration installs the generated PostgreSQL baseline and seeds the ledger for the frozen SQLite-only migrations. Portable migrations then run under a schema-scoped transaction advisory lock. Lock acquisition waits for another migrator outside the normal transaction watchdog and lock timeout. Repeating the migration command is a no-op. Runtime startup validates the ledger and tells the operator to run the migration command if anything is pending.

After migration, apply [`deploy/postgres/runtime-grants.sql`](../deploy/postgres/runtime-grants.sql) as the owner and run [`deploy/postgres/verify-runtime.sql`](../deploy/postgres/verify-runtime.sql) while connected as the runtime role. [`deploy/postgres/harness-ro-grants.sql`](../deploy/postgres/harness-ro-grants.sql) configures an optional inspection role. Render the role and schema identifiers if your deployment does not use the defaults in those templates.

## Import an existing SQLite central database

The importer is dry-run by default and never modifies the source SQLite file:

```bash
pnpm exec tsx scripts/sqlite-to-postgres.ts --source data/v2.db --dry-run
pnpm exec tsx scripts/sqlite-to-postgres.ts --source data/v2.db --commit
```

It requires an exact, recognized migration ledger, reports SQLite foreign-key orphans, computes a foreign-key-safe table order, inserts parameterized 500-row chunks, reconciles `schema_version`, and verifies every table's row count. It refuses a non-empty PostgreSQL target. `--truncate` is an explicit destructive override; `--skip-orphans` is an explicit data-quality override. Review the dry-run output before using either.

Keep the SQLite source as the rollback point. Switching back to SQLite does not copy newer writes from PostgreSQL.

## Queries and setup inspection

The canonical query remains:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT COUNT(*) AS n FROM schema_version"
```

With this skill configured, only that canonical central path routes to PostgreSQL. Explicit paths such as `data/v2-sessions/.../inbound.db` and `outbound.db` always open the named local SQLite file and do not change its journal mode. Setup inspection also uses a read-only PostgreSQL connection and propagates connection/authentication failures instead of reporting an empty install.

## Development tests

Run PostgreSQL tests only against a disposable database:

```bash
docker run --rm --name nanoclaw-pg17 \
  -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=nanoclaw_test \
  -e 'POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8' \
  -p 5432:5432 postgres:17

NANOCLAW_TEST_DB_URL=postgres://postgres:x@127.0.0.1:5432/nanoclaw_test \
  pnpm exec vitest run src/db/drivers/postgres scripts/q.pg.test.ts \
  setup/central-db-compatibility.pg.test.ts setup/central-db-inspection.pg.test.ts
```

Vitest workers use isolated schemas. Run `pnpm exec tsx scripts/pg-baseline-from-sqlite.ts` after migration changes; it exits nonzero if the checked-in SQL and embedded TypeScript baseline are stale.

## Availability, backup, and restore

Exactly one host may deliver from a NanoClaw schema. The host reserves a PostgreSQL advisory lock on a dedicated pooled connection, retries for up to 60 seconds at boot, pauses DB access during lock recovery, and exits if it cannot recover. Deploy with a recreate strategy; overlapping hosts are intentionally rejected.

Quiesce the host before a logically consistent `pg_dump -Fc` backup. Restore into a libc-provider database with `C` collation, run migration, verify the runtime grants, and then start the host. The central database and session-mailbox files can have different recovery points, so restore drills should include a queued-message round trip.
