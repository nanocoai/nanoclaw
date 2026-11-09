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

  it('preserves local defaults when args and env are omitted', () => {
    const mcp = mcpServersToOpenCodeConfig({
      x: { command: 'true' },
    });
    expect(mcp.x).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
    });
  });

  it('wraps a cwd-declaring server in the cd-then-exec argv', () => {
    const mcp = mcpServersToOpenCodeConfig({
      probe: { command: './run.js', args: ['--flag'], cwd: '/workspace/agent/plugin-data/sdr' },
    });
    expect(mcp.probe).toEqual({
      type: 'local',
      command: ['/bin/sh', '-c', 'cd "$0" && exec "$@"', '/workspace/agent/plugin-data/sdr', './run.js', '--flag'],
      enabled: true,
    });
  });

  it('maps Streamable HTTP servers to remote entries', () => {
    expect(
      mcpServersToOpenCodeConfig({
        docs: { type: 'http', url: 'https://mcp.example.com/mcp' },
      }).docs,
    ).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
    });
  });

  it('passes remote headers through', () => {
    expect(
      mcpServersToOpenCodeConfig({
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { 'X-Api-Version': '2024-06' },
        },
      }).docs,
    ).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Api-Version': '2024-06' },
      enabled: true,
    });
  });

  it('returns empty record for undefined', () => {
    expect(mcpServersToOpenCodeConfig(undefined)).toEqual({});
  });
});
