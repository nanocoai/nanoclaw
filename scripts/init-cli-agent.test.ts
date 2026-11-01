/**
 * scripts/init-cli-agent.ts: a folder that can't be a group folder is refused
 * in one line, before anything is written.
 *
 * What breaks without it: cli-with- is 9 characters, so a 55-character display
 * name makes a 64-character folder; the group is created and can never spawn.
 * Kill condition: drop the assertValidGroupFolder call before createAgentGroup,
 * or write the cli:local user before the group.
 *
 * Drives the real entry point in a child process against a temp cwd
 * (PROJECT_ROOT = cwd, so data/v2.db and groups/ are temp). Same shape as
 * scripts/init-first-agent.test.ts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, 'init-cli-agent.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');

describe('scripts/init-cli-agent.ts', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ica-'));
    fs.mkdirSync(path.join(cwd, 'data'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function run(displayName: string): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const args = ['--import', TSX_LOADER, SCRIPT, '--display-name', displayName];
      const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }

  function column(sql: string): unknown[] {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    try {
      return db.prepare(sql).pluck().all();
    } finally {
      db.close();
    }
  }

  it('creates the group for a display name whose folder is exactly 63 characters', async () => {
    const name = 'a'.repeat(54);
    const r = await run(name);
    expect(r.status, r.stderr).toBe(0);
    expect(column('SELECT folder FROM agent_groups')).toEqual([`cli-with-${name}`]);
  }, 60_000);

  it('refuses a display name one character longer, in one line, before writing anything', async () => {
    const name = 'a'.repeat(55);
    const r = await run(name);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`Invalid group folder "cli-with-${name}" — too long: 64 characters, at most 63\n`);
    expect(column('SELECT folder FROM agent_groups')).toEqual([]);
    expect(column('SELECT id FROM users')).toEqual([]);
  }, 60_000);
});
