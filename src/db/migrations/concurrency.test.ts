import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import { SqliteDriver } from '../drivers/sqlite.js';
import { migrations, runMigrations } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('concurrent SQLite migrations', () => {
  it.each([
    ['fresh database', 0],
    ['existing database with pending migrations', migrations.length - 1],
  ])(
    'does not reapply a migration completed by another process: %s',
    async (_name, appliedCount) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migrations-'));
      const databasePath = path.join(directory, 'central.db');
      const raw = new Database(databasePath);
      raw.pragma('journal_mode = WAL');
      const db = new SqliteDriver(raw);

      try {
        await runMigrations(db, migrations.slice(0, appliedCount));
        const info = vi.spyOn(log, 'info');
        const all = db.all.bind(db);
        let otherProcessRan = false;

        vi.spyOn(db, 'all').mockImplementation(async <T>(sql: string, ...params: unknown[]): Promise<T[]> => {
          const rows = await all<T>(sql, ...params);
          if (sql === 'SELECT name FROM schema_version' && !otherProcessRan) {
            // Freeze this caller's applied-migration snapshot while another
            // process completes the pending work, then resume with stale rows.
            otherProcessRan = true;
            const result = await migrateInOtherProcess(databasePath);
            expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
          }
          return rows;
        });

        await runMigrations(db);

        expect(otherProcessRan).toBe(true);
        expect(await db.all('SELECT name FROM schema_version ORDER BY version')).toEqual(
          migrations.map(({ name }) => ({ name })),
        );
        expect(info.mock.calls.filter(([message]) => message === 'Migration applied')).toEqual([]);
        expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      } finally {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

function migrateInOtherProcess(
  databasePath: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./fixtures/migrate.ts', import.meta.url)),
      databasePath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}
