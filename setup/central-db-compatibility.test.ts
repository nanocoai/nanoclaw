import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('standalone central DB composition', () => {
  it('initializes the SQLite composition in a fresh process', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-compose-'));
    const dbPath = path.join(tempDir, 'central.db');
    const source = `
      const { initDb, closeDb } = await import('./src/db/connection.ts');
      const db = await initDb(process.argv[1], { role: 'tool' });
      await db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');
      await db.run('INSERT INTO probe (id) VALUES (?)', 'ok');
      const row = await db.get('SELECT COUNT(*) AS n FROM probe');
      console.log(db.dialect + '|' + row.n);
      await closeDb();
    `;

    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, dbPath], {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('sqlite|1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
