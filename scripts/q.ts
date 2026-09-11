/**
 * scripts/q.ts — central DB query wrapper for skill SQL invocations.
 *
 * Usage:
 *   pnpm exec tsx scripts/q.ts <db-path> "<sql>"
 *
 * Routes only the canonical central DB path through the configured driver.
 * Explicit session paths remain local SQLite files and retain their journal
 * mode. Queries print rows in
 * sqlite3 CLI default ("list") format — pipe-separated, no header —
 * so existing skill text reads identically. Mutations use the driver's
 * parameterless `exec()` operation, including compound statements.
 *
 * Why this exists: setup/verify.ts:5 codifies that NanoClaw avoids
 * depending on the sqlite3 CLI binary; setup never installs or probes
 * for it. Skills that shell out to `sqlite3` therefore fail on hosts
 * where it isn't preinstalled (common on fresh Ubuntu — see #2191).
 * This wrapper preserves the skill-text shape (path then SQL string). A
 * remote composition may redirect the canonical data/v2.db path, but never
 * an explicit inbound.db or outbound.db path.
 */
import path from 'node:path';

import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';
import { SqliteDriver } from '../src/db/drivers/sqlite.js';

const [, , dbPath, sql] = process.argv;

if (!dbPath || sql === undefined) {
  console.error('Usage: pnpm exec tsx scripts/q.ts <db-path> "<sql>"');
  process.exit(2);
}

/**
 * Replace quoted values, quoted identifiers, and comments with whitespace
 * before looking for statement keywords. A word such as "UPDATE" in a CTE's
 * string literal or comment says nothing about whether the outer statement
 * returns rows.
 */
function maskSqlNonCode(statement: string): string {
  let masked = '';
  let i = 0;
  const blank = (value: string): string => value.replace(/[^\n]/g, ' ');

  while (i < statement.length) {
    const rest = statement.slice(i);

    if (rest.startsWith('--')) {
      const end = statement.indexOf('\n', i + 2);
      const next = end === -1 ? statement.length : end + 1;
      masked += blank(statement.slice(i, next));
      i = next;
      continue;
    }

    if (rest.startsWith('/*')) {
      const end = statement.indexOf('*/', i + 2);
      const next = end === -1 ? statement.length : end + 2;
      masked += blank(statement.slice(i, next));
      i = next;
      continue;
    }

    const dollarTag = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
    if (dollarTag) {
      const end = statement.indexOf(dollarTag, i + dollarTag.length);
      const next = end === -1 ? statement.length : end + dollarTag.length;
      masked += blank(statement.slice(i, next));
      i = next;
      continue;
    }

    const quote = statement[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      let next = i + 1;
      while (next < statement.length) {
        if (statement[next] !== quote) {
          next++;
          continue;
        }
        if (statement[next + 1] === quote) {
          next += 2;
          continue;
        }
        next++;
        break;
      }
      masked += blank(statement.slice(i, next));
      i = next;
      continue;
    }

    if (quote === '[') {
      const end = statement.indexOf(']', i + 1);
      const next = end === -1 ? statement.length : end + 1;
      masked += blank(statement.slice(i, next));
      i = next;
      continue;
    }

    masked += quote;
    i++;
  }

  return masked;
}

function isQuery(statement: string): boolean {
  const normalized = maskSqlNonCode(statement).trim().toUpperCase();
  if (/^(?:SELECT|PRAGMA|EXPLAIN|VALUES)\b/.test(normalized)) return true;
  if (!normalized.startsWith('WITH')) return false;
  return !/\b(?:INSERT|UPDATE|DELETE)\b/.test(normalized);
}

let db: DbDriver;
let close: () => Promise<void>;
if (path.resolve(dbPath) === path.resolve(CENTRAL_DB_PATH)) {
  db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
  close = closeDb;
} else {
  db = new SqliteDriver(new Database(dbPath));
  close = () => db.close();
}
try {
  if (isQuery(sql)) {
    const rows = await db.all<Record<string, unknown>>(sql);
    for (const row of rows) {
      console.log(
        Object.values(row)
          .map((value) => (value === null ? '' : String(value)))
          .join('|'),
      );
    }
  } else await db.exec(sql);
} finally {
  await close();
}
