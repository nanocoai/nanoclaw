import { describe, it, expect } from 'bun:test';

import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

describe('mcpServersToOpenCodeConfig', () => {
  it('maps nanoclaw + extra server like v2 index.ts merge', () => {
    const servers = {
      nanoclaw: {
        command: 'node',
        args: ['/app/src/mcp-tools/index.js'],
        env: {
          SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
          SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
          SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
        },
      },
      extra: {
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { FOO: 'bar' },
      },
    };

    const mcp = mcpServersToOpenCodeConfig(servers);

    expect(mcp.nanoclaw).toEqual({
      type: 'local',
      command: ['node', '/app/src/mcp-tools/index.js'],
      environment: {
        SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
      },
      enabled: true,
    });

    expect(mcp.extra).toEqual({
      type: 'local',
      command: ['npx', '-y', 'some-mcp'],
      environment: { FOO: 'bar' },
      enabled: true,
    });
  });

  it('omits environment when env is empty', () => {
    const mcp = mcpServersToOpenCodeConfig({
      x: { command: 'true', args: [], env: {} },
    });
    expect(mcp.x).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
    });
  });

  it('returns empty record for undefined', () => {
    expect(mcpServersToOpenCodeConfig(undefined)).toEqual({});
  });
});
