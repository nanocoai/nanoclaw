import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { POSTGRES_BASELINE_SQL } from './baseline.js';

describe('PostgreSQL generated baseline', () => {
  it('matches the frozen SQLite migration result and its embedded runtime copy', () => {
    const checkedIn = fs.readFileSync(new URL('./baseline.sql', import.meta.url), 'utf8');
    const projectRoot = path.resolve(import.meta.dirname, '../../../..');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/pg-baseline-from-sqlite.ts'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    expect(POSTGRES_BASELINE_SQL).toBe(checkedIn);
  });

  it('keeps 64-bit integer columns and leaves existing role duplicates untouched', () => {
    expect(POSTGRES_BASELINE_SQL).toContain('expires_at bigint');
    expect(POSTGRES_BASELINE_SQL).toContain('is_group bigint DEFAULT 0');
    expect(POSTGRES_BASELINE_SQL).toContain('threads bigint');
    const userRoles = POSTGRES_BASELINE_SQL.slice(
      POSTGRES_BASELINE_SQL.indexOf('CREATE TABLE "user_roles"'),
      POSTGRES_BASELINE_SQL.indexOf('CREATE TABLE "users"'),
    );
    expect(userRoles).not.toContain('PRIMARY KEY');
    expect(POSTGRES_BASELINE_SQL).not.toContain('idx_user_roles_global_unique');
    expect(POSTGRES_BASELINE_SQL).not.toContain('idx_user_roles_scoped_unique');
    expect(POSTGRES_BASELINE_SQL).not.toContain('user-roles-unique');
  });

  it('stores SQL-generated timestamps in ISO-8601 UTC form', () => {
    expect(POSTGRES_BASELINE_SQL).not.toContain("'YYYY-MM-DD HH24:MI:SS'");
    expect(POSTGRES_BASELINE_SQL).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
  });
});
