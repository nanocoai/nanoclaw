/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has one writing side while a container runs, so host and
 * container do not contend for its write lock. Inside the container, the
 * runner, the MCP server and each `ncl` call all write outbound.db, so its
 * opener must wait for the lock.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _testMode = false;

// A VM file share such as Docker Desktop's does not carry the host's SQLite
// locks into the container, so a read can land mid host write: the host's live
// journal then looks like one needing rollback, or a page reads torn. Both
// clear once the host commits; anything else, or a lasting one, throws.
const MID_WRITE_ERRORS = new Set(['SQLITE_READONLY_ROLLBACK', 'SQLITE_CORRUPT']);
const MID_WRITE_RETRY_MS = 1000;
const MID_WRITE_BACKOFF_MS = 10;

/**
 * Run `read` against a fresh read-only inbound.db connection, closed after.
 *
 * Fresh every time because host writes don't reliably invalidate SQLite's
 * caches across virtiofs/NFS mounts; opening costs microseconds. `read` must
 * return materialized rows (`.get()`/`.all()`), and may run more than once.
 */
export function readInbound<T>(read: (db: Database) => T, path = DEFAULT_INBOUND_PATH): T {
  if (_testMode && _inbound && path === DEFAULT_INBOUND_PATH) return read(_inbound);
  const deadline = Date.now() + MID_WRITE_RETRY_MS;
  for (;;) {
    const db = new Database(path, { readonly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA mmap_size = 0');
      return read(db);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== 'string' || !MID_WRITE_ERRORS.has(code) || Date.now() >= deadline) throw error;
    } finally {
      db.close();
    }
    Bun.sleepSync(MID_WRITE_BACKOFF_MS);
  }
}

/**
 * Tests only: the in-memory inbound DB from `initTestSessionDb()`, for seeding rows.
 * Keep it exported: provider test files already installed from older payloads import it.
 */
export function getInboundDb(): Database {
  if (!_testMode || !_inbound) throw new Error('getInboundDb() is test-only; read through readInbound()');
  return _inbound;
}

/**
 * Outbound DB, written by several container processes: the runner, the MCP
 * server and each `ncl` call. `path` (tests only) applies to the first open.
 */
export function getOutboundDb(path = DEFAULT_OUTBOUND_PATH): Database {
  if (!_outbound) {
    _outbound = new Database(path);
    // busy_timeout first: bun:sqlite defaults it to 0, and the first schema
    // read (journal_mode) fails at once while one of those writers holds the lock.
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA foreign_keys = ON');
    // Lightweight forward-compat: session_state was added after the initial
    // v2 schema, so older session DBs don't have it. Create it on demand
    // instead of requiring a formal migration pass. Also handle the case
    // where an earlier revision of this table existed without updated_at —
    // ALTER TABLE to add any missing columns.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (_outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('updated_at')) {
      _outbound.exec(
        `ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`,
      );
    }
    _outbound.exec(`UPDATE session_state SET updated_at = '1970-01-01T00:00:00.000Z' WHERE updated_at = ''`);
    // container_state: tracks the current tool in flight (if any) so the host
    // sweep can widen its stuck tolerance when Bash is running with a user-
    // declared long timeout. Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
  }
  return _outbound;
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function sqliteSetContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool, declaredTimeoutMs, now, now);
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function sqliteClearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function sqliteClearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      on_wake        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL
    );
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}
