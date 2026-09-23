/**
 * scripts/delete-cli-agent.ts stops and removes the agent's container before
 * its group folder is deleted.
 *
 * Drives the real entry point in a child process against a temp cwd
 * (PROJECT_ROOT = cwd, so data/v2.db is temp), with a fake runtime binary
 * via CONTAINER_RUNTIME that records every call together with whether the
 * group folder still existed at that moment.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, 'delete-cli-agent.ts');
const MIGRATE = path.resolve(import.meta.dirname, 'migrate.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');
const FOLDER = 'ping_test';
const AGENT_GROUP_ID = 'ag-ping-test';
/** Pinned: the cwd-derived slug depends on tmpdir symlink resolution (macOS /var → /private/var). */
const INSTALL_ID = 'dcatest';

describe('scripts/delete-cli-agent.ts', () => {
  let cwd: string;
  let runtime: string;
  let log: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dca-'));
    fs.mkdirSync(path.join(cwd, 'groups', FOLDER), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'data'));
    const migrated = spawnSync(process.execPath, ['--import', TSX_LOADER, MIGRATE], { cwd, encoding: 'utf8' });
    expect(migrated.status, migrated.stderr).toBe(0);
    const db = new Database(path.join(cwd, 'data', 'v2.db'));
    db.prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      AGENT_GROUP_ID,
      'Terminal Agent',
      FOLDER,
      'claude',
      new Date().toISOString(),
    );
    db.close();

    // A fake runtime: `ps` lists one container, every call is logged with the
    // folder's existence at call time so ordering against the rm is provable.
    log = path.join(cwd, 'runtime-calls.log');
    runtime = path.join(cwd, 'fake-docker');
    fs.writeFileSync(
      runtime,
      [
        '#!/bin/sh',
        `if [ -d "${path.join(cwd, 'groups', FOLDER)}" ]; then folder=present; else folder=gone; fi`,
        `printf '%s folder=%s\\n' "$*" "$folder" >> "${log}"`,
        'case "$1" in ps) echo abc123 ;; esac',
        'exit 0',
      ].join('\n'),
    );
    fs.chmodSync(runtime, 0o755);
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function run(env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--import', TSX_LOADER, SCRIPT, '--folder', FOLDER], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CONTAINER_RUNTIME: runtime, NANOCLAW_INSTALL_ID: INSTALL_ID, ...env },
    });
  }

  it('stops and removes the group container while its folder still exists, then deletes the folder', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopped container(s) for ping_test: abc123');
    expect(result.stdout).toContain(`Deleted agent group ${AGENT_GROUP_ID} (${FOLDER}).`);

    const filters = `--filter label=nanoclaw-install=${INSTALL_ID} --filter label=nanoclaw-group=${AGENT_GROUP_ID}`;
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `ps -aq ${filters} folder=present`,
      'stop -t 10 abc123 folder=present',
      'rm --force abc123 folder=present',
    ]);
    expect(fs.existsSync(path.join(cwd, 'groups', FOLDER))).toBe(false);

    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS count FROM agent_groups WHERE folder = ?').get(FOLDER) as {
      count: number;
    };
    db.close();
    expect(row.count).toBe(0);
  });

  it('still deletes the group when the runtime cannot be reached', () => {
    fs.writeFileSync(runtime, '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Could not clean up container(s) for ping_test');
    expect(fs.existsSync(path.join(cwd, 'groups', FOLDER))).toBe(false);
  });
});
