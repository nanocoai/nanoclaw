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
import {
  CONTAINER_PLUGINS_DIR,
  configFromDb,
  parseMcpServerConfig,
  resolveGroupTimezone,
  sanitizeStoredMcpServers,
  validateMcpServerName,
} from './container-config.js';
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

  it('honors a declared type and maps streamable-http onto the internal http', () => {
    expect(parseMcpServerConfig({ type: 'stdio', command: 'server' })).toEqual({
      command: 'server',
      args: [],
      env: {},
    });
    expect(parseMcpServerConfig({ type: 'streamable-http', url: 'https://mcp.example.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it.each([
    [{ type: 'sse', url: 'https://mcp.example.com/mcp' }, /unsupported transport "sse"/],
    [{ type: 'websocket', url: 'https://mcp.example.com/mcp' }, /type must be/],
    [{ type: 'stdio', url: 'https://mcp.example.com/mcp' }, /requires command/],
    [{ type: 'http', command: 'server' }, /requires url/],
  ])('rejects a mismatched or unsupported declared type %#', (input, message) => {
    expect(() => parseMcpServerConfig(input)).toThrow(message);
  });

  it('accepts headers on http entries and rejects them on stdio entries', () => {
    expect(parseMcpServerConfig({ url: 'https://mcp.example.com/mcp', headers: { 'X-Client': 'nanoclaw' } })).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Client': 'nanoclaw' },
    });
    expect(() => parseMcpServerConfig({ command: 'server', headers: { A: 'b' } })).toThrow(/only valid with url/);
    expect(() => parseMcpServerConfig({ url: 'https://mcp.example.com/mcp', headers: { A: 1 } })).toThrow(
      /string values/,
    );
  });

  it.each(['./sub', '${PLUGIN_ROOT}', '${PLUGIN_ROOT}/srv', '${PLUGIN_DATA}', '${PLUGIN_DATA}/cache'])(
    'accepts the fixed cwd form %s',
    (cwd) => {
      expect(parseMcpServerConfig({ command: 'server', cwd })).toMatchObject({ cwd });
    },
  );

  it.each([
    ['sub', /cwd must be/],
    ['/abs', /cwd must be/],
    ['../up', /cwd must be/],
    ['./a/../b', /escapes the plugin root/],
    ['${PLUGIN_ROOT}/../up', /escapes the plugin root/],
    ['${PLUGIN_DATA}/a/${PLUGIN_ROOT}', /escapes the plugin root/],
    ['${PLUGIN_DATA}//x', /escapes the plugin root/],
    ['./a//b', /escapes the plugin root/],
    [7, /cwd must be/],
  ])('rejects cwd %s', (cwd, message) => {
    expect(() => parseMcpServerConfig({ command: 'server', cwd })).toThrow(message);
  });
});

describe('sanitizeStoredMcpServers', () => {
  it('keeps valid entries, preserves a well-formed pluginRoot, and drops the rest', () => {
    const sanitized = sanitizeStoredMcpServers(
      {
        good: { command: 'server', args: [], env: {}, pluginRoot: `${CONTAINER_PLUGINS_DIR}/sdr` },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
        badRoot: { command: 'server', pluginRoot: '/etc' },
        broken: { url: 'http://insecure.example.com' },
        notAnObject: 42,
        'bad.name': { command: 'server' },
      },
      'test-group',
    );
    expect(Object.keys(sanitized).sort()).toEqual(['badRoot', 'good', 'remote']);
    expect(sanitized.good).toMatchObject({ pluginRoot: `${CONTAINER_PLUGINS_DIR}/sdr` });
    expect(sanitized.badRoot).not.toHaveProperty('pluginRoot');
  });

  it('strips cwd from entries without plugin provenance, keeps it with', () => {
    const sanitized = sanitizeStoredMcpServers(
      {
        planted: { command: 'server', cwd: '${PLUGIN_DATA}/x' },
        plugin: { command: 'server', cwd: '${PLUGIN_DATA}/x', pluginRoot: `${CONTAINER_PLUGINS_DIR}/sdr` },
      },
      'test-group',
    );
    expect(sanitized.planted).not.toHaveProperty('cwd');
    expect(sanitized.plugin).toMatchObject({ cwd: '${PLUGIN_DATA}/x' });
  });

  it('returns empty on a non-object blob', () => {
    expect(sanitizeStoredMcpServers('garbage', 'test-group')).toEqual({});
  });
});

describe('validateMcpServerName', () => {
  it('accepts bare-key-safe names and rejects structural or oversized ones', () => {
    expect(() => validateMcpServerName('brave-search_2')).not.toThrow();
    // __proto__ matches the regex but would set the record's prototype
    // instead of an own key on assignment — rejected by name.
    for (const name of ['', 'docs]\n[mcp_servers.evil]', 'a b', 'a.b', '"quoted"', 'x'.repeat(65), '__proto__']) {
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
