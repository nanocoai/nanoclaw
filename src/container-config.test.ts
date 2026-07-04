/**
 * materializeContainerJson must not depend on the group's creation path.
 *
 * A bare `ncl groups create` (no template) inserts only the agent_groups
 * row. The spawn path calls materializeContainerJson before
 * initGroupFilesystem gets a chance to backfill the config row, so a hard
 * throw here means a bare-created group can never spawn a container.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-container-config',
    GROUPS_DIR: '/tmp/nanoclaw-test-container-config/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-container-config';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { getContainerConfig } from './db/container-configs.js';
import { materializeContainerJson } from './container-config.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('materializeContainerJson — bare group without a config row', () => {
  it('creates the default config row instead of throwing', () => {
    createAgentGroup({
      id: 'ag-bare',
      name: 'Bare Group',
      folder: 'bare-group',
      agent_provider: null,
      created_at: now(),
    });
    expect(getContainerConfig('ag-bare')).toBeFalsy();

    const config = materializeContainerJson('ag-bare');

    expect(config).toBeTruthy();
    expect(getContainerConfig('ag-bare')).toBeTruthy();
    expect(fs.existsSync(`${TEST_DIR}/groups/bare-group/container.json`)).toBe(true);
  });

  it('still materializes normally when the row already exists', () => {
    createAgentGroup({
      id: 'ag-cfg',
      name: 'Configured Group',
      folder: 'configured-group',
      agent_provider: null,
      created_at: now(),
    });
    // First call creates the row; second call exercises the normal path.
    materializeContainerJson('ag-cfg');
    const config = materializeContainerJson('ag-cfg');
    expect(config).toBeTruthy();
  });
});
