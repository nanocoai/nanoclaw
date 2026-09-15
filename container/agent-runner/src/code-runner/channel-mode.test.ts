import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { channelArgs, ensureChannelMcpConfig, resolveChannelMode } from './channel-mode.js';

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
  it('names the private registration file in both live modes and the development bypass in dev only', () => {
    expect(channelArgs('dev', '/tmp/x/mcp.json')).toEqual([
      '--mcp-config',
      '/tmp/x/mcp.json',
      '--dangerously-load-development-channels',
      'server:nanoclaw-mailbox',
    ]);
    expect(channelArgs('org', '/tmp/x/mcp.json')).toEqual(['--mcp-config', '/tmp/x/mcp.json']);
    expect(channelArgs('off')).toEqual([]);
    expect(channelArgs('org')[1]).toBe('/tmp/code-runner/mcp.json');
  });
});

describe('ensureChannelMcpConfig', () => {
  it('writes exactly our server to the private file and is idempotent', () => {
    const file = path.join(tempDir(), 'nested', 'mcp.json');
    expect(ensureChannelMcpConfig(file)).toBe(true);
    expect(ensureChannelMcpConfig(file)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { 'nanoclaw-mailbox': { command: 'bun', args: ['/app/src/code-runner/mailbox-channel.ts'] } },
    });
  });

  it('never touches a workspace .mcp.json', () => {
    const workspace = tempDir();
    fs.writeFileSync(path.join(workspace, '.mcp.json'), '{"mcpServers":{"theirs":{}}}');
    ensureChannelMcpConfig(path.join(workspace, 'private', 'mcp.json'));
    expect(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{"theirs":{}}}');
  });
});
