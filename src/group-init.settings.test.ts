import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-group-init-settings-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-group-init-settings-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-group-init-settings-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

async function makeGroup(id: string): Promise<AgentGroup> {
  const ag = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  await createAgentGroup(ag);
  return ag;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('group filesystem scaffold', () => {
  it('creates plugins/ so the read-only plugins mount is unconditional', async () => {
    const ag = await makeGroup('ag-plugins');
    await initGroupFilesystem(ag, {});
    expect(fs.statSync(path.join(TEST_ROOT, 'groups', ag.folder, 'plugins')).isDirectory()).toBe(true);
  });
});

describe('default settings.json for new groups', () => {
  it('is lean: no agent-teams env key, unmanaged keys intact', async () => {
    const ag = await makeGroup('ag-lean');
    await initGroupFilesystem(ag, {});

    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));

    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(JSON.stringify(settings.hooks.PreCompact)).toContain('compact-instructions');
  });

  it('never rewrites an existing settings.json — a hand-edited re-enable sticks', async () => {
    const ag = await makeGroup('ag-reenable');
    await initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');

    // Operator re-enables both features by editing the file (the documented path).
    const edited = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete edited.disableWorkflows;
    edited.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');

    await initGroupFilesystem(ag, {}); // next spawn

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.disableWorkflows).toBeUndefined();
    expect(after.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});

describe('settings.json planted by the container', () => {
  // `.claude-shared` is the container's read-write mount: any name under it
  // may be a symlink or FIFO by the time the host prepares the next spawn.
  const hostile = JSON.stringify({ autoMemoryEnabled: true, env: {}, hooks: {} }, null, 2) + '\n';

  it('refuses a symlink to a host file: nothing read, nothing written through it', async () => {
    const ag = await makeGroup('ag-settings-link');
    await initGroupFilesystem(ag, {});
    const claudeDir = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared');
    const settingsFile = path.join(claudeDir, 'settings.json');
    const hostFile = path.join(TEST_ROOT, 'host-settings.json');
    fs.writeFileSync(hostFile, hostile);
    fs.rmSync(settingsFile);
    fs.symlinkSync(hostFile, settingsFile);

    await initGroupFilesystem(ag, {}); // next spawn

    expect(fs.readFileSync(hostFile, 'utf-8')).toBe(hostile);
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Claude settings'),
      expect.objectContaining({ settingsFile }),
    );
  });

  it('does not create a host file through a dangling symlink', async () => {
    const ag = await makeGroup('ag-settings-dangling');
    await initGroupFilesystem(ag, {});
    const settingsFile = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const hostFile = path.join(TEST_ROOT, 'never-created.json');
    fs.rmSync(settingsFile);
    fs.symlinkSync(hostFile, settingsFile);

    await initGroupFilesystem(ag, {});

    expect(fs.existsSync(hostFile)).toBe(false);
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
  });

  it('refuses a FIFO without blocking the spawn', async () => {
    const ag = await makeGroup('ag-settings-fifo');
    await initGroupFilesystem(ag, {});
    const settingsFile = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    fs.rmSync(settingsFile);
    execFileSync('mkfifo', [settingsFile]);

    await initGroupFilesystem(ag, {});

    expect(fs.lstatSync(settingsFile).isFIFO()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Claude settings'),
      expect.objectContaining({ settingsFile }),
    );
  });
});
