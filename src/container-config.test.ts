/**
 * Group-timezone resolution (agent-level timezone feature).
 *
 * The chain is: valid per-group override → install-global TIMEZONE. An
 * invalid stored value (hand-edited DB — the ncl write path validates) must
 * fall back to the global timezone, not silently become UTC, and must never
 * be materialized into container.json.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TIMEZONE } from './config.js';
import { configFromDb, parseMcpServerConfig, resolveGroupTimezone, validateMcpServerName } from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-tz',
  name: 'tz',
  folder: 'tz',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

describe('resolveGroupTimezone', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup(GROUP);
    ensureContainerConfig(GROUP.id);
  });
  afterEach(() => {
    closeDb();
  });

  it('returns the install-global timezone when no override is set', () => {
    expect(resolveGroupTimezone(GROUP.id)).toBe(TIMEZONE);
    expect(resolveGroupTimezone('ag-no-such-group')).toBe(TIMEZONE);
  });

  it('returns a valid override, and falls back to global on an invalid stored value', () => {
    updateContainerConfigScalars(GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(resolveGroupTimezone(GROUP.id)).toBe('Asia/Tokyo');

    updateContainerConfigScalars(GROUP.id, { timezone: 'Not/AZone' });
    expect(resolveGroupTimezone(GROUP.id)).toBe(TIMEZONE);
  });

  it('configFromDb ships a valid timezone to the container and drops an invalid one', () => {
    updateContainerConfigScalars(GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).timezone).toBe('Asia/Tokyo');

    updateContainerConfigScalars(GROUP.id, { timezone: 'Not/AZone' });
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).timezone).toBeUndefined();
  });
});

describe('parseMcpServerConfig', () => {
  it('preserves stdio config and accepts HTTPS Streamable HTTP config', () => {
    expect(parseMcpServerConfig({ command: 'pnpm', args: ['dlx', 'server'], env: { TOKEN: 'stub' } })).toEqual({
      command: 'pnpm',
      args: ['dlx', 'server'],
      env: { TOKEN: 'stub' },
    });
    expect(parseMcpServerConfig({ url: 'https://mcp.example.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
    // Non-secret query params (e.g. Datadog toolset selection) are legitimate endpoint config.
    expect(parseMcpServerConfig({ url: 'https://mcp.datadoghq.com/v1/mcp?toolsets=apm,llmobs' })).toEqual({
      type: 'http',
      url: 'https://mcp.datadoghq.com/v1/mcp?toolsets=apm,llmobs',
    });
    // Credential keys match as whole words: `author` is not `auth`.
    expect(parseMcpServerConfig({ url: 'https://mcp.example.com/mcp?author=jane' })).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp?author=jane',
    });
    // Plain HTTP is allowed only for loopback and the container->host gateway.
    for (const url of [
      'http://localhost:8080/mcp',
      'http://127.0.0.1:9000/mcp',
      'http://[::1]:9000/mcp',
      'http://host.docker.internal:8080/mcp',
    ]) {
      expect(parseMcpServerConfig({ url })).toEqual({ type: 'http', url });
    }
  });

  it.each([
    [{}, /exactly one/],
    [{ command: 'server', url: 'https://mcp.example.com/mcp' }, /exactly one/],
    [{ url: 'http://mcp.example.com/mcp' }, /HTTPS/],
    // The loopback exception is an exact-hostname match, not a suffix match.
    [{ url: 'http://localhost.evil.com/mcp' }, /HTTPS/],
    [{ url: 'https://token@mcp.example.com/mcp' }, /credentials/],
    [{ url: 'https://mcp.example.com/mcp?api_key=secret' }, /looks like a credential/],
    [{ url: 'https://mcp.example.com/mcp?authorization=x' }, /looks like a credential/],
    // camelCase keys are normalized before the word-boundary match.
    [{ url: 'https://mcp.example.com/mcp?authToken=x' }, /looks like a credential/],
    [{ url: 'https://mcp.example.com/mcp?privateKey=x' }, /looks like a credential/],
    [{ url: 'https://mcp.example.com/mcp#secret' }, /fragments/],
    [{ url: 'https://mcp.example.com/mcp', env: {} }, /only valid with command/],
    // Env keys reach codex's TOML writer as table keys — charset is allowlisted.
    [{ command: 'server', env: { 'BAD KEY': 'v' } }, /valid environment variable name/],
    [{ command: 'server', env: { 'X]\n[mcp_servers.evil]': 'v' } }, /valid environment variable name/],
  ])('rejects invalid transport config %#', (input, message) => {
    expect(() => parseMcpServerConfig(input)).toThrow(message);
  });
});

describe('validateMcpServerName', () => {
  it('accepts bare-key-safe names and rejects structural or oversized ones', () => {
    expect(() => validateMcpServerName('brave-search_2')).not.toThrow();
    for (const name of ['', 'docs]\n[mcp_servers.evil]', 'a b', 'a.b', '"quoted"', 'x'.repeat(65)]) {
      expect(() => validateMcpServerName(name)).toThrow(/1-64 characters/);
    }
  });
});

/**
 * The container cannot import host modules, so the MCP validation constants
 * are duplicated in container/agent-runner/src/mcp-tools/self-mod.ts. Pin
 * the copies byte-identical so drift fails a test instead of shipping.
 */
describe('host/container validation parity', () => {
  it('keeps the duplicated regex literals identical', () => {
    const read = (p: string): string => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
    const host = read('src/container-config.ts');
    const container = read('container/agent-runner/src/mcp-tools/self-mod.ts');
    for (const name of ['SECRET_QUERY_KEY_RE', 'CAMEL_SPLIT_RE', 'MCP_SERVER_NAME_RE', 'ENV_KEY_RE']) {
      const literal = (src: string): string | undefined =>
        src
          .match(new RegExp(`const ${name} =\\s*([^;]+);`))?.[1]
          .replace(/\s+/g, ' ')
          .trim();
      expect(literal(host), name).toBeDefined();
      expect(literal(container), name).toBe(literal(host));
    }
  });
});
