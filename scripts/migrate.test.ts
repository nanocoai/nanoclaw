import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATE = path.resolve(import.meta.dirname, 'migrate.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');

describe('scripts/migrate.ts', () => {
  it('refuses an explicit SQLite central database with the PostgreSQL-only audit module', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migrate-script-'));
    try {
      const result = spawnSync(process.execPath, ['--import', TSX_LOADER, MIGRATE], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          NANOCLAW_DB_URL: '',
          NANOCLAW_DB_PASSWORD_FILE: '',
          NANOCLAW_DB_MIGRATE_URL: '',
          NANOCLAW_DB_MIGRATE_PASSWORD_FILE: '',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Host audit requires the composed central PostgreSQL driver');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
