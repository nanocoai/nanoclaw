import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readInbound } from './connection.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-inbound-'));
const dbPath = path.join(dir, 'inbound.db');
const seed = new Database(dbPath);
seed.exec('CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER)');
seed.exec("INSERT INTO messages_in VALUES ('m1', 2)");
seed.close();

// A writer killed mid-transaction leaves a hot journal and no lock: the state
// a container reader sees when it cannot see the host's live write lock.
const hotPath = path.join(dir, 'hot.db');
const hot = new Database(hotPath);
hot.exec('PRAGMA journal_mode = DELETE');
hot.exec('CREATE TABLE messages_in (id TEXT, seq INTEGER)');
hot.close();
Bun.spawnSync([
  process.execPath,
  '-e',
  `const { Database } = require('bun:sqlite');
   const db = new Database(${JSON.stringify(hotPath)});
   db.exec('PRAGMA cache_size = 1');
   db.exec('BEGIN');
   const insert = db.prepare('INSERT INTO messages_in VALUES (?, ?)');
   for (let i = 0; i < 2000; i++) insert.run('x'.repeat(200) + i, i);
   process.kill(process.pid, 'SIGKILL');`,
]);
// Bun on macOS uses the system SQLite, which reads past a hot journal; Linux
// Bun (the agent image, CI) bundles one that refuses, which is the case under test.
const reportsHotJournal = (() => {
  const db = new Database(hotPath, { readonly: true });
  try {
    db.prepare('SELECT count(*) FROM messages_in').get();
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
})();

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function sqliteError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A read that fails with `code` for its first `failures` attempts, then reads the real row count. */
function flakyRead(code: string, failures: number) {
  let attempts = 0;
  const read = (db: Database) => {
    attempts++;
    if (attempts <= failures) throw sqliteError(code);
    return (db.prepare('SELECT count(*) AS c FROM messages_in').get() as { c: number }).c;
  };
  return { read, attempts: () => attempts };
}

describe('readInbound', () => {
  test('retries a read caught mid host write (hot journal) and returns the real rows', () => {
    const flaky = flakyRead('SQLITE_READONLY_ROLLBACK', 2);
    expect(readInbound(flaky.read, dbPath)).toBe(1);
    expect(flaky.attempts()).toBe(3);
  });

  test('retries a torn page read', () => {
    const flaky = flakyRead('SQLITE_CORRUPT', 1);
    expect(readInbound(flaky.read, dbPath)).toBe(1);
    expect(flaky.attempts()).toBe(2);
  });

  test('throws any other error at once', () => {
    const flaky = flakyRead('SQLITE_ERROR', 1);
    expect(() => readInbound(flaky.read, dbPath)).toThrow('SQLITE_ERROR');
    expect(flaky.attempts()).toBe(1);
  });

  test('gives up on a mid-write error that does not clear', () => {
    const flaky = flakyRead('SQLITE_READONLY_ROLLBACK', Number.POSITIVE_INFINITY);
    const started = Date.now();
    expect(() => readInbound(flaky.read, dbPath)).toThrow('SQLITE_READONLY_ROLLBACK');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(flaky.attempts()).toBeGreaterThan(1);
  });

  test.skipIf(!reportsHotJournal)('retries the real hot-journal error by its extended code', () => {
    let attempts = 0;
    let thrown: unknown;
    try {
      readInbound((db) => {
        attempts++;
        return db.prepare('SELECT count(*) FROM messages_in').get();
      }, hotPath);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('SQLITE_READONLY_ROLLBACK');
    expect(attempts).toBeGreaterThan(1);
  });

  test('opens the file read-only', () => {
    expect(() => readInbound((db) => db.exec("INSERT INTO messages_in VALUES ('m2', 4)"), dbPath)).toThrow(/readonly/);
  });
});
