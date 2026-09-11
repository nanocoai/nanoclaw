/**
 * The AuthorizedKeysCommand: asks the host over the door socket and prints
 * the landing line, the waiting-room line (with the key, so the room can
 * register it), or nothing.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAuthorizedKeys } from './authorized-keys.js';
import { parsePublicKey } from './keys.js';
import { doorFiles } from './paths.js';
import { writeDoorState, type DoorState } from './state.js';

const DIR = `/tmp/nanoclaw-door-ak-${process.pid}`;
const files = doorFiles(DIR);
const key = parsePublicKey(
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJcU4MBsyv98bPT4z2Ymq9wLqo52QUi0MKqgu7k5gfGV vector@test',
);
const args = [DIR, 'SHA256:ignored', key.type, key.base64];
const state: DoorState = {
  version: 1,
  enabled: true,
  name: 'alice',
  doorPort: 33022,
  approvalUrl: 'https://example.test/terminals',
  socketPath: '/srv/host/data/ncl.sock',
  hostSocketPath: files.hostSocket,
  path: '/usr/bin',
  updatedAt: 't',
};

const answering = (status: 'approved' | 'unknown' | 'disabled') => ({
  authorize: vi.fn(async () => status),
});

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  await writeDoorState(files.state, state);
});
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('runAuthorizedKeys', () => {
  it('prints the landing line for an approved key, asking by the recomputed fingerprint', async () => {
    const deps = answering('approved');
    const out: string[] = [];
    expect(await runAuthorizedKeys(args, (l) => out.push(l), deps)).toBe(0);
    expect(deps.authorize).toHaveBeenCalledWith(files.hostSocket, key.fingerprint);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^restrict,pty,command=".*landing.*" ssh-ed25519 /);
    expect(out[0]).not.toContain(key.base64.slice(0, 20) + "' ");
  });

  it('prints the waiting-room line carrying the key for an unknown one', async () => {
    const out: string[] = [];
    expect(await runAuthorizedKeys(args, (l) => out.push(l), answering('unknown'))).toBe(0);
    expect(out[0]).toContain('waiting-room');
    expect(out[0]).toContain(`'${key.fingerprint}' 'ssh-ed25519' '${key.base64}'`);
    expect(out[0].endsWith(` ${key.publicKey}`)).toBe(true);
  });

  it('prints nothing when the door is disabled, when the host says so, or when it does not answer', async () => {
    const out: string[] = [];
    expect(await runAuthorizedKeys(args, (l) => out.push(l), answering('disabled'))).toBe(0);
    const silent = { authorize: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) };
    expect(await runAuthorizedKeys(args, (l) => out.push(l), silent)).toBe(0);
    await writeDoorState(files.state, { ...state, enabled: false });
    const deps = answering('approved');
    expect(await runAuthorizedKeys(args, (l) => out.push(l), deps)).toBe(0);
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('exits non-zero for missing arguments or a key it cannot parse', async () => {
    expect(await runAuthorizedKeys([DIR], () => {})).toBe(2);
    expect(await runAuthorizedKeys([DIR, 'f', 'ssh-ed25519', '***'], () => {}, answering('approved'))).toBe(1);
  });
});
