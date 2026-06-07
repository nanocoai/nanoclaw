import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { configFromDb } from '../container-config.js';
import type { AgentGroup, ContainerConfigRow } from '../types.js';
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  getAgentGroup,
  ensureContainerConfig,
  getContainerConfig,
  createContainerConfig,
  updateContainerConfigJson,
} from './index.js';

function now() {
  return new Date().toISOString();
}

const GROUP = {
  id: 'ag-1',
  name: 'Test Agent',
  folder: 'test-agent',
  agent_provider: null,
  created_at: now(),
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup(GROUP);
});

afterEach(() => {
  closeDb();
});

describe('container_configs env / blocked_hosts', () => {
  it('defaults to empty object / array for new rows', () => {
    ensureContainerConfig('ag-1');
    const row = getContainerConfig('ag-1')!;
    expect(row.env).toBe('{}');
    expect(row.blocked_hosts).toBe('[]');
  });

  it('round-trips env + blocked_hosts and configFromDb parses them', () => {
    ensureContainerConfig('ag-1');
    updateContainerConfigJson('ag-1', 'env', {
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      NO_PROXY: 'host.docker.internal',
    });
    updateContainerConfigJson('ag-1', 'blocked_hosts', ['api.anthropic.com']);

    const row = getContainerConfig('ag-1')!;
    const group = getAgentGroup('ag-1') as AgentGroup;
    const config = configFromDb(row, group);

    expect(config.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      NO_PROXY: 'host.docker.internal',
    });
    expect(config.blockedHosts).toEqual(['api.anthropic.com']);
  });

  it('createContainerConfig persists supplied env + blocked_hosts', () => {
    const row: ContainerConfigRow = {
      agent_group_id: 'ag-1',
      provider: null,
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: '"all"',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      env: JSON.stringify({ FOO: 'bar' }),
      blocked_hosts: JSON.stringify(['blocked.example']),
      cli_scope: 'group',
      updated_at: now(),
    };
    createContainerConfig(row);

    const stored = getContainerConfig('ag-1')!;
    expect(JSON.parse(stored.env)).toEqual({ FOO: 'bar' });
    expect(JSON.parse(stored.blocked_hosts)).toEqual(['blocked.example']);
  });
});
