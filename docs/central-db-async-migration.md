# Central database async migration

NanoClaw's central database now sits behind the asynchronous `DbDriver`
interface. The built-in implementation still uses the existing SQLite
`data/v2.db`; this change does not move or rewrite stored data.

## Detect affected customizations

Search custom source, installed skills, and long-lived channel/provider
branches for direct central-database access and calls whose return type changed
from a value or `void` to a promise:

```bash
rg -n "getDb\(\)|initDb\(|initTestDb\(|runMigrations\(|hasTable\(" src setup scripts .claude/skills
rg -n "\.prepare\(|\.transaction\(" src setup scripts .claude/skills
rg -n "guard\(|gateCommand\(|canAccessAgentGroup\(|resolveSession\(" src setup scripts .claude/skills
```

Direct `better-sqlite3` access is still valid for the per-session
`inbound.db`/`outbound.db` mailboxes. For the central database, use the async
wrappers under `src/db/` or the `DbDriver` methods instead.

## Why the interface changed

The old central-database boundary exposed synchronous SQLite statements. That
made SQLite's connection and transaction behavior part of every caller. The
new boundary can support storage backends whose statements are naturally
asynchronous while preserving SQLite as the default.

These transaction rules are required for both backends:

- Issue database calls sequentially inside `transaction()`; do not use
  `Promise.all` for central-database work.
- Never await mailbox sessions, container operations, channel adapters, or
  network work while a central transaction is open. Run those effects after
  commit.
- Nested transactions are allowed in the same async scope and use savepoints.
  An unrelated statement waits for the outer transaction rather than silently
  joining it.
- A transaction that outlives the watchdog is rolled back and fails. Code that
  continues using a closed transaction scope trips an explicit error.

## Update custom modules

Await central-database initialization, migrations, wrappers, and driver calls,
then propagate `async` through their callers:

```ts
const db = await initDb(CENTRAL_DB_PATH);
await runMigrations(db);

const group = await getAgentGroup(groupId);
await db.transaction(async () => {
  await db.run('UPDATE agent_groups SET name = ? WHERE id = ?', name, groupId);
});
```

Do not use `getDb().prepare(...)`. The driver surface is `get`, `all`, `run`,
`exec`, `transaction`, `hasTable`, and `close`, and every operation returns a
promise.

The following extension seams now accept or return promises:

- `guard()` and guard `decide` callbacks
- `SenderResolverFn`, `AccessGateFn`, and `SenderScopeGateFn`
- `QuestionRenderResolver`
- `ProviderContainerConfigFn`
- `gateCommand()` and `canAccessAgentGroup()`
- `HostStartContext.db`, which is now a `DbDriver`
- resource `postCreate`
- `Migration.up()` and `runMigrations()`

Migration code receives a `DbDriver`. Frozen legacy migrations are explicitly
marked `sqliteOnly: true`; the migration runner supplies their raw SQLite
handle through `sqliteRaw(db)`. New migrations should use the portable async
driver API. Keep `sqliteRaw` limited to legacy SQLite-only migrations and tests
that intentionally inspect SQLite behavior.

## Known external updates

The matching public channel/provider branches must be updated in lockstep:

- `telegram.ts`: await messaging-group reads/writes and user upserts.
- `deltachat.ts`: make `isDcAdmin` async and await `hasTable` and its database
  lookups.
- `codex.ts`: await `getAgentGroup` from the async provider configuration
  callback.

The `groups-purge` and `nanoco-gateway-approvals` recipes also require async
updates. The latter includes its `QuestionRenderResolver` and migrations
`020`/`022`, which should use the portable async migration shape. Until those
branches and recipes are updated, applying them over this boundary may fail
type-checking or treat promises as values.

## Verify the migration

Run the host checks and repeat the searches above:

```bash
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm test
```

With the default SQLite composition, start NanoClaw and exercise a real
channel, an `ncl` command, and a scheduled or approval action. Confirm the
central `data/v2.db` is reused and the session mailbox files still receive the
message and response.

## Roll back

No stored-data migration occurs. Return NanoClaw and custom modules to the
previous revision, rebuild, and restart the service. The same central SQLite
file and session mailbox files remain usable after rollback.
