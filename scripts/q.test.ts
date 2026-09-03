import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import Database from 'better-sqlite3';

/**
 * Smoke tests for the q.ts sqlite-CLI replacement wrapper.
 *
 * Verifies the two modes (SELECT prints rows in sqlite3 default "list"
 * format; mutation runs via db.exec) and a few edge cases that real
 * skill invocations rely on.
 */

const Q = path.resolve(__dirname, 'q.ts');

describe('scripts/q.ts', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-test-'));
    dbPath = path.join(tempDir, 'test.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE t (id INTEGER, name TEXT, note TEXT);
      INSERT INTO t (id, name, note) VALUES (1, 'alice', 'hi'), (2, 'bob', NULL);
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(sql: string): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('pnpm', ['exec', 'tsx', Q, dbPath, sql], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
  }

  it('preserves DELETE journaling for explicit session-style paths', () => {
    const before = new Database(dbPath);
    expect(before.pragma('journal_mode = DELETE', { simple: true })).toBe('delete');
    before.close();

    const result = run('SELECT COUNT(*) FROM t');
    expect(result.status, result.stderr).toBe(0);

    const after = new Database(dbPath, { readonly: true });
    expect(after.pragma('journal_mode', { simple: true })).toBe('delete');
    after.close();
  });

  it('SELECT prints pipe-separated rows in default order', () => {
    const r = run('SELECT id, name FROM t ORDER BY id');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1|alice\n2|bob');
  });

  it('SELECT renders NULL as empty string (matches sqlite3 default mode)', () => {
    const r = run('SELECT id, note FROM t ORDER BY id');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1|hi\n2|');
  });

  it('SELECT with no rows prints nothing', () => {
    const r = run("SELECT id FROM t WHERE name = 'nobody'");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('PRAGMA prints its result rows', () => {
    const r = run('PRAGMA journal_mode');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('delete');
  });

  it('EXPLAIN prints its result rows', () => {
    const r = run('EXPLAIN SELECT 1');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).not.toBe('');
  });

  it('VALUES prints its result rows', () => {
    const r = run('VALUES (1), (2)');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('1\n2');
  });

  it('INSERT runs via db.exec and persists', () => {
    const r = run("INSERT INTO t (id, name) VALUES (3, 'carol')");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT name FROM t WHERE id = 3').get() as { name: string };
    db.close();
    expect(row.name).toBe('carol');
  });

  it('compound mutation statements execute together', () => {
    const r = run("DELETE FROM t WHERE id = 1; INSERT INTO t (id, name) VALUES (9, 'zed');");
    expect(r.status).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const ids = (db.prepare('SELECT id FROM t ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    db.close();
    expect(ids).toEqual([2, 9]);
  });

  it('WITH...DELETE is treated as a mutation, not a query', () => {
    const r = run(
      "WITH stale AS (SELECT id FROM t WHERE name = 'alice') DELETE FROM t WHERE id IN (SELECT id FROM stale)",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT name FROM t').all() as { name: string }[];
    db.close();
    expect(rows).toEqual([{ name: 'bob' }]);
  });

  it('does not mistake mutation words inside WITH query string literals for statements', () => {
    const r = run("WITH words AS (SELECT 'UPDATE' AS word) SELECT word FROM words");

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('UPDATE');
  });

  it('does not mistake mutation words inside WITH query comments for statements', () => {
    const r = run('WITH rows AS (SELECT id FROM t /* DELETE */) SELECT COUNT(*) FROM rows -- INSERT');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('2');
  });

  it('exits 2 with usage when args are missing', () => {
    const r = spawnSync('pnpm', ['exec', 'tsx', Q], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage/);
  });
});
