import { describe, expect, it } from 'bun:test';

import { resolvePluginServer } from './plugin-mcp.js';

const ROOT = '/workspace/agent/plugins/sdr';
const DATA = '/workspace/agent/plugin-data/sdr';

describe('resolvePluginServer', () => {
  it('expands placeholders in args and env values and injects the two plugin vars', () => {
    const resolved = resolvePluginServer({
      command: 'node',
      args: ['${PLUGIN_ROOT}/server/index.js', '--cache', '${PLUGIN_DATA}/cache'],
      env: { CONFIG: '${PLUGIN_ROOT}/config.json', PLAIN: 'untouched' },
      pluginRoot: ROOT,
    });

    expect(resolved).toEqual({
      command: 'node',
      args: [`${ROOT}/server/index.js`, '--cache', `${DATA}/cache`],
      env: {
        CONFIG: `${ROOT}/config.json`,
        PLAIN: 'untouched',
        PLUGIN_ROOT: ROOT,
        PLUGIN_DATA: DATA,
      },
    });
  });

  it('resolves a ./-relative command against the plugin root and strips pluginRoot', () => {
    const resolved = resolvePluginServer({ command: './server/run.js', pluginRoot: ROOT });
    expect(resolved).toEqual({
      command: `${ROOT}/server/run.js`,
      args: [],
      env: { PLUGIN_ROOT: ROOT, PLUGIN_DATA: DATA },
    });
  });

  it('always sets PLUGIN_ROOT/PLUGIN_DATA last, over any configured value', () => {
    const resolved = resolvePluginServer({
      command: 'node',
      env: { PLUGIN_ROOT: '/spoofed' },
      pluginRoot: ROOT,
    });
    expect(resolved.type === 'http' ? undefined : resolved.env?.PLUGIN_ROOT).toBe(ROOT);
  });

  it('passes non-plugin stdio servers and http servers through untouched', () => {
    const stdio = { command: 'bun', args: ['run', 'x.ts'], env: {} };
    expect(resolvePluginServer(stdio)).toBe(stdio);

    const http = { type: 'http' as const, url: 'https://mcp.example.com/mcp', headers: { A: 'placeholder' } };
    expect(resolvePluginServer(http)).toBe(http);
  });

  it('resolves each cwd fixed form to an absolute path', () => {
    expect(resolvePluginServer({ command: 'server', cwd: './work', pluginRoot: ROOT })).toMatchObject({
      cwd: `${ROOT}/work`,
    });
    expect(resolvePluginServer({ command: 'server', cwd: '${PLUGIN_ROOT}/sub', pluginRoot: ROOT })).toMatchObject({
      cwd: `${ROOT}/sub`,
    });
    expect(resolvePluginServer({ command: 'server', cwd: '${PLUGIN_DATA}', pluginRoot: ROOT })).toMatchObject({
      cwd: DATA,
    });
  });

});
