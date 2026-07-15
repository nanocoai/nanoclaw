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
import type { AgentGroup } from './types.js';

function makeGroup(id: string): AgentGroup {
  const ag = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  createAgentGroup(ag);
  return ag;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('default settings.json for new groups', () => {
  it('is lean: no agent-teams env key, unmanaged keys intact', () => {
    const ag = makeGroup('ag-lean');
    initGroupFilesystem(ag, {});

    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));

    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(JSON.stringify(settings.hooks.PreCompact)).toContain('compact-instructions');
  });

  it('never rewrites an existing settings.json — a hand-edited re-enable sticks', () => {
    const ag = makeGroup('ag-reenable');
    initGroupFilesystem(ag, {});
    const file = path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');

    // Operator re-enables both features by editing the file (the documented path).
    const edited = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete edited.disableWorkflows;
    edited.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');

    initGroupFilesystem(ag, {}); // next spawn

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.disableWorkflows).toBeUndefined();
    expect(after.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});
