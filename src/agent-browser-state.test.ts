import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { agentBrowserEncryptionKey, agentBrowserStateMount } from './agent-browser-state.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-agent-browser-state-'));
}

describe('agentBrowserStateMount', () => {
  it('mounts under the group-state data root, read-write', () => {
    const dataRoot = tmpDir();
    const mount = agentBrowserStateMount('agent-1', dataRoot);
    expect(mount.class).toBe('group-state');
    expect(mount.mode).toBe('rw');
    expect(mount.groupScope).toBe('agent-1');
    expect(mount.hostPath).toBe(path.join(dataRoot, 'v2-sessions', 'agent-1', 'agent-browser-state'));
    expect(mount.containerPath).toBe('/home/node/.agent-browser');
  });

  it('creates the host directory if missing', () => {
    const dataRoot = tmpDir();
    agentBrowserStateMount('agent-1', dataRoot);
    expect(fs.existsSync(path.join(dataRoot, 'v2-sessions', 'agent-1', 'agent-browser-state'))).toBe(true);
  });
});

describe('agentBrowserEncryptionKey', () => {
  it('generates a 64-char hex key on first call and persists it', () => {
    const hostDir = tmpDir();
    const key1 = agentBrowserEncryptionKey('agent-1', hostDir);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    const key2 = agentBrowserEncryptionKey('agent-1', hostDir);
    expect(key2).toBe(key1);
  });

  it('gives different groups different keys', () => {
    const hostDir = tmpDir();
    const keyA = agentBrowserEncryptionKey('agent-a', hostDir);
    const keyB = agentBrowserEncryptionKey('agent-b', hostDir);
    expect(keyA).not.toBe(keyB);
  });
});
