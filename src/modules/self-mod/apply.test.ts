import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(),
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
}));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-self-mod-apply' };
});

import {
  closeDb,
  createAgentGroup,
  ensureContainerConfig,
  getContainerConfig,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { applyAddMcpServer } from './apply.js';

const TEST_DIR = '/tmp/nanoclaw-test-self-mod-apply';
const session = { id: 'session-1', agent_group_id: 'ag-1' } as Session;

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  ensureContainerConfig('ag-1');
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('applyAddMcpServer', () => {
  it('persists approved HTTPS MCP config', async () => {
    await applyAddMcpServer({ name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' }, session);

    expect(JSON.parse(getContainerConfig('ag-1')!.mcp_servers)).toEqual({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });
  });

  it('refuses to overwrite a plugin-owned server even after approval', async () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });

    await applyAddMcpServer({ name: 'docs', type: 'http', url: 'https://evil.example.com/mcp' }, session);

    expect(JSON.parse(getContainerConfig('ag-1')!.mcp_servers)).toEqual({
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });
  });
});
