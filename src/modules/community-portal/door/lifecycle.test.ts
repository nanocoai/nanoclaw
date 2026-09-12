/**
 * The door's journal and lifecycle without a client: inert until enabled
 * (no files for an enrolled host that never opted in), the journal says
 * enabled only once the door listens, the journaled port is reused only
 * while it is free, and a rename from the account recomposes the host name
 * for the status line and the hook.
 */
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-door-lifecycle-${process.pid}`);

vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>();
  return { ...actual, DATA_DIR: `${ROOT}/data`, GROUPS_DIR: `${ROOT}/groups` };
});

import {
  onRemoteAccessChanged,
  resetSandboxHooksForTesting,
  SANDBOX_HOOKS_SEAM,
  type RemoteAccessState,
} from '../../../code-mode/hooks.js';
import { writePrivate } from '../../../community-portal/private-file.js';
import { getHostStartCallbacks } from '../../../host-lifecycle.js';
import type { DbDriver } from '../../../db/driver.js';
import { applyTerminalMirror, disableDoor, doorStatus, enableDoor, setTerminalSeam } from './index.js';
import { DoorServer } from './server.js';

const heard: RemoteAccessState[] = [];

/** Hold a port; one already held by another process (a parallel door test) is just as taken. */
async function occupy(port: number): Promise<net.Server | null> {
  const server = net.createServer();
  return new Promise<net.Server | null>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      error.code === 'EADDRINUSE' ? resolve(null) : reject(error),
    );
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${ROOT}/data`, { recursive: true });
  await writePrivate(`${ROOT}/data/community-portal.json`, {
    origin: 'https://portal.example.test',
    deviceId: 'dev_1',
  });
  heard.length = 0;
  resetSandboxHooksForTesting();
  onRemoteAccessChanged('test', (state) => void heard.push(state), { seam: SANDBOX_HOOKS_SEAM });
  setTerminalSeam({
    enable: async (request) => ({ name: request.name ?? 'alice', host: `${request.name ?? 'alice'}.example.test` }),
    report: async () => {},
  });
});

afterEach(async () => {
  await disableDoor().catch(() => {});
  setTerminalSeam({});
  resetSandboxHooksForTesting();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('inert until enabled', () => {
  it('creates no door files on an enrolled host that never enabled remote access', async () => {
    const start = getHostStartCallbacks();
    for (const cb of start) await cb({ db: {} as DbDriver, signal: new AbortController().signal });
    expect((await doorStatus()).enabled).toBe(false);
    await applyTerminalMirror(undefined);
    await applyTerminalMirror({ enabled: false, keys: [] });
    expect(fs.existsSync(`${ROOT}/data/door`)).toBe(false);
  });
});

describe('enable', () => {
  it('journals enabled only once the door listens, and reuses the journaled port only while it is free', async () => {
    const first = await enableDoor({ name: 'alice' });
    expect(first.door.running).toBe(true);
    const port = first.doorPort!;
    expect(JSON.parse(fs.readFileSync(`${ROOT}/data/door/state.json`, 'utf8'))).toMatchObject({
      enabled: true,
      doorPort: port,
    });
    expect(heard.at(-1)).toEqual({ enabled: true, name: 'alice', host: 'alice.example.test' });
    await disableDoor();
    expect(heard.at(-1)).toEqual({ enabled: false, name: 'alice', host: 'alice.example.test' });

    // The journaled port is taken by someone else: the door moves on.
    const squatter = await occupy(port);
    try {
      const again = await enableDoor({ name: 'alice' });
      expect(again.doorPort).not.toBe(port);
      expect(again.door.running).toBe(true);
    } finally {
      squatter?.close();
    }
    await disableDoor();

    // A second enable while the door runs keeps the listener and its port:
    // the journal, the report and the summary all name the live one.
    const reported: number[] = [];
    setTerminalSeam({
      enable: async (request) => ({ name: request.name ?? 'alice', host: `${request.name ?? 'alice'}.example.test` }),
      report: async (state) => {
        if (state.doorPort) reported.push(state.doorPort);
      },
    });
    const running = await enableDoor({ name: 'alice' });
    const repeated = await enableDoor({ name: 'alice' });
    expect(repeated.doorPort).toBe(running.doorPort);
    expect(repeated.door).toMatchObject({ running: true, port: running.doorPort });
    expect(JSON.parse(fs.readFileSync(`${ROOT}/data/door/state.json`, 'utf8')).doorPort).toBe(running.doorPort);
    expect(reported.at(-1)).toBe(running.doorPort);
    await disableDoor();

    // The listen fails: the journal never says enabled.
    const start = vi.spyOn(DoorServer.prototype, 'start').mockRejectedValueOnce(new Error('listen failed'));
    try {
      await expect(enableDoor({ name: 'alice' })).rejects.toThrow(/listen failed/);
      expect(JSON.parse(fs.readFileSync(`${ROOT}/data/door/state.json`, 'utf8')).enabled).toBe(false);
    } finally {
      start.mockRestore();
    }
  });
});

describe('a rename from the account', () => {
  it('recomposes the host name from the new name and the old zone, for the status and the hook', async () => {
    await enableDoor({ name: 'alice' });
    heard.length = 0;
    await applyTerminalMirror({ enabled: true, name: 'bob', previousName: 'alice', keys: [] });
    const status = await doorStatus();
    expect(status).toMatchObject({ name: 'bob', previousName: 'alice', host: 'bob.example.test' });
    expect(heard).toEqual([{ enabled: true, name: 'bob', host: 'bob.example.test' }]);
  });
});
