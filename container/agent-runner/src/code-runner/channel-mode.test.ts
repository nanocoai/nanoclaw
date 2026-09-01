import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import {
  channelArgs,
  ensureChannelMcpConfig,
  ensureProjectMcpConsent,
  resolveChannelMode,
} from './channel-mode.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-channel-mode-'));
}

describe('resolveChannelMode', () => {
  it('recognizes dev and org; everything else degrades to off — never half-configured', () => {
    expect(resolveChannelMode('dev')).toBe('dev');
    expect(resolveChannelMode('org')).toBe('org');
    expect(resolveChannelMode('on')).toBe('off');
    expect(resolveChannelMode(undefined)).toBe('off');
    expect(resolveChannelMode('')).toBe('off');
  });
});

describe('channelArgs', () => {
  it('adds the development bypass for exactly our entry in dev mode only', () => {
    expect(channelArgs('dev')).toEqual(['--dangerously-load-development-channels', 'server:nanoclaw-mailbox']);
    expect(channelArgs('org')).toEqual([]); // the org allowlist carries it — no dangling dev flag
    expect(channelArgs('off')).toEqual([]);
  });
});

describe('ensureChannelMcpConfig', () => {
  it('creates .mcp.json with the server and is idempotent', () => {
    const dir = tempDir();
    expect(ensureChannelMcpConfig(dir)).toBe(true);
    expect(ensureChannelMcpConfig(dir)).toBe(false);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(config.mcpServers['nanoclaw-mailbox']).toEqual({
      command: 'bun',
      args: ['/app/src/code-runner/mailbox-channel.ts'],
    });
  });

  it("merges into a developer's existing config without clobbering their servers", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { theirs: { command: 'node', args: ['x.js'] } } }),
    );
    ensureChannelMcpConfig(dir);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(config.mcpServers.theirs).toEqual({ command: 'node', args: ['x.js'] });
    expect(config.mcpServers['nanoclaw-mailbox']).toBeDefined();
  });
});

describe('ensureProjectMcpConsent', () => {
  it('sets the consent key preserving existing settings, idempotently', () => {
    const settingsPath = path.join(tempDir(), 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [] } }));
    expect(ensureProjectMcpConsent(settingsPath)).toBe(true);
    expect(ensureProjectMcpConsent(settingsPath)).toBe(false);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.hooks).toEqual({ Stop: [] });
  });
});
