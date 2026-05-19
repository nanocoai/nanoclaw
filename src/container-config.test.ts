import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

describe('container config materialization', () => {
  it('carries model provider and auth mode from the DB row', () => {
    const group: AgentGroup = {
      id: 'ag-1',
      name: 'Terminal Agent',
      folder: 'terminal-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    const row: ContainerConfigRow = {
      agent_group_id: 'ag-1',
      provider: 'codex',
      model_provider: 'openai',
      auth_mode: 'api_key',
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
      cli_scope: 'group',
      updated_at: new Date().toISOString(),
    };

    expect(configFromDb(row, group)).toMatchObject({
      provider: 'codex',
      modelProvider: 'openai',
      authMode: 'api_key',
    });
  });
});
