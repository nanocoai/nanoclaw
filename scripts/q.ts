/**
 * scripts/q.ts — sqlite3 CLI replacement for skill SQL invocations.
 *
 * Usage:
 *   pnpm exec tsx scripts/q.ts <db-path> "<sql>"
 *
 * Uses better-sqlite3's stmt.reader property to distinguish queries
 * (SELECT / WITH...SELECT) from mutations. Queries print rows in
 * sqlite3 CLI default ("list") format — pipe-separated, no header —
 * so existing skill text reads identically. Mutations run via
 * stmt.run() (single statement) or db.exec() (compound).
 *
 * Why this exists: setup/verify.ts:5 codifies that NanoClaw avoids
 * depending on the sqlite3 CLI binary; setup never installs or probes
 * for it. Skills that shell out to `sqlite3` therefore fail on hosts
 * where it isn't preinstalled (common on fresh Ubuntu — see #2191).
 * This wrapper preserves the skill-text shape (path then SQL string)
 * while routing through the better-sqlite3 dep that setup already
 * installs and verifies.
 */
import Database from 'better-sqlite3';

const [, , dbPath, sql, ...params] = process.argv;

if (!dbPath || sql === undefined) {
  console.error('Usage: pnpm exec tsx scripts/q.ts <db-path> "<sql>" [param1] [param2] ...');
  process.exit(2);
}

const db = new Database(dbPath);
try {
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all(...params) as Record<string, unknown>[];
      for (const row of rows) {
        console.log(
          Object.values(row)
            .map((v) => (v === null ? '' : String(v)))
            .join('|'),
        );
      }
    } else {
      stmt.run(...params);
    }
  } catch (e: unknown) {
    // better-sqlite3 throws on compound statements ("contains more than
    // one statement"). Compound SQL in skills is always mutations
    // (e.g. "DELETE ...; INSERT ...;"), so fall back to db.exec().
    if (e instanceof Error && /more than one statement/i.test(e.message)) {
      db.exec(sql);
    } else {
      throw e;
    }
  }
} finally {
  db.close();
}
