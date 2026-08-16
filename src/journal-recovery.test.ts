import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { isReadonlyRollbackError } from './delivery.js';

describe('isReadonlyRollbackError (#2640 hot-journal race discriminator)', () => {
  const sqliteErr = (code: string) => Object.assign(new Error('attempt to write a readonly database'), { code });

  it('matches SQLITE_READONLY_ROLLBACK and the broader SQLITE_READONLY family', () => {
    expect(isReadonlyRollbackError(sqliteErr('SQLITE_READONLY_ROLLBACK'))).toBe(true);
    expect(isReadonlyRollbackError(sqliteErr('SQLITE_READONLY'))).toBe(true);
    expect(isReadonlyRollbackError(sqliteErr('SQLITE_READONLY_DBMOVED'))).toBe(true);
  });

  it('rejects unrelated SQLite codes, plain errors, and non-errors', () => {
    expect(isReadonlyRollbackError(sqliteErr('SQLITE_BUSY'))).toBe(false);
    expect(isReadonlyRollbackError(new Error('boom'))).toBe(false);
    expect(isReadonlyRollbackError(null)).toBe(false);
    expect(isReadonlyRollbackError('SQLITE_READONLY')).toBe(false);
  });
});

describe('stale outbound journal recovery (#2516)', () => {
  it('a read-write open rolls back and deletes a stranded DELETE-mode journal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    const dbPath = path.join(dir, 'outbound.db');

    // Simulate the kill: spill a big uncommitted transaction so the journal
    // gets a valid (hot) header and the main file is modified in place, then
    // capture both files mid-transaction and restore them after close —
    // byte-identical to what a SIGKILL mid-write leaves on disk.
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('cache_size = 2'); // force page spills during the txn
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t (v) VALUES ('committed')");
    db.exec('BEGIN IMMEDIATE');
    const big = 'x'.repeat(8192);
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 64; i++) ins.run(big);
    const journalPath = `${dbPath}-journal`;
    const journalBytes = fs.readFileSync(journalPath);
    const dbBytes = fs.readFileSync(dbPath);
    db.exec('ROLLBACK');
    db.close();
    fs.writeFileSync(dbPath, dbBytes);
    fs.writeFileSync(journalPath, journalBytes);
    expect(journalBytes.length).toBeGreaterThan(512); // header + pages = genuinely hot

    // Readonly handle cannot recover it.
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.prepare('SELECT count(*) c FROM t').get()).toThrowError(/readonly/i);
    ro.close();

    // The fix: a brief read-write open performs rollback + journal deletion.
    const rw = new Database(dbPath);
    rw.pragma('journal_mode = DELETE');
    const row = rw.prepare('SELECT count(*) c FROM t').get() as { c: number };
    rw.close();
    expect(row.c).toBe(1); // uncommitted insert rolled back
    expect(fs.existsSync(journalPath)).toBe(false);

    // And the readonly handle works again.
    const ro2 = new Database(dbPath, { readonly: true });
    expect((ro2.prepare('SELECT count(*) c FROM t').get() as { c: number }).c).toBe(1);
    ro2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
