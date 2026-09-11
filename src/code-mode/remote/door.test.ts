import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writePrivate } from '../../community-portal/index.js';
import { localDoor } from './door.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-door-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

it('reads enabled and the port from the journal and reports the honoured keys from the last snapshot', async () => {
  const log = vi.fn();
  const door = localDoor({ root, log });
  expect(await door.status()).toEqual({ enabled: false, authorizedFingerprints: [] });
  const file = path.join(root, 'data/community-portal.json');
  await writePrivate(file, { origin: 'https://portal.example.test', terminal: { enabled: true, updatedAt: 'x' } });
  expect(await door.status()).toEqual({ enabled: false, authorizedFingerprints: [] });
  await writePrivate(file, { terminal: { enabled: true, doorPort: 33022, name: 'alice', updatedAt: 'x' } });
  expect(await door.status()).toEqual({ enabled: true, port: 33022, authorizedFingerprints: [] });
  const snapshot = {
    enabled: true,
    keys: [{ fingerprint: 'SHA256:a' }, { fingerprint: 'SHA256:b' }],
    pending: [],
    sandboxes: [],
  };
  door.applyTerminalSnapshot(snapshot);
  door.applyTerminalSnapshot({ ...snapshot, keys: [...snapshot.keys] });
  expect(log).toHaveBeenCalledExactlyOnceWith({ event: 'terminal_snapshot', enabled: true, keys: 2, pending: 0 });
  expect((await door.status()).authorizedFingerprints).toEqual(['SHA256:a', 'SHA256:b']);
  door.applyTerminalSnapshot(undefined);
  expect(log).toHaveBeenCalledWith({ event: 'terminal_snapshot', enabled: false, keys: 0, pending: 0 });
  expect((await door.status()).authorizedFingerprints).toEqual([]);
  await writePrivate(file, { terminal: { enabled: false, doorPort: 33022, updatedAt: 'x' } });
  expect(await door.status()).toEqual({ enabled: false, authorizedFingerprints: [] });
});

it('keeps stream records by source port as copies until they are unregistered', () => {
  const door = localDoor({ root });
  const record = {
    stream: 's',
    target: { account: 'alice', sandbox: 'api' },
    source: { ip: '::1', port: 1 },
    openedAt: 'now',
  };
  door.registerTarget(40001, record);
  record.target.sandbox = 'changed';
  expect(door.lookupTarget(40001)).toEqual({ ...record, target: { account: 'alice', sandbox: 'api' } });
  expect(door.lookupTarget(40002)).toBeUndefined();
  door.registerTarget(40002, { ...record, stream: 't' });
  door.unregisterTarget(40001);
  expect(door.lookupTarget(40001)).toBeUndefined();
  expect(door.lookupTarget(40002)?.stream).toBe('t');
});
