import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { startCliServer, stopCliServer } from './socket-server.js';

// Unix socket paths have a small OS limit — keep them short.
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-'));
  return path.join(dir, 's.sock');
}

afterEach(async () => {
  await stopCliServer();
});

describe('startCliServer single-bind', () => {
  it('refuses to take over a socket a live server is accepting on', async () => {
    const socketPath = tmpSocketPath();
    // Another host instance, simulated by a raw listener on the same path.
    const other = net.createServer(() => {});
    await new Promise<void>((resolve) => other.listen(socketPath, resolve));
    try {
      await expect(startCliServer(socketPath)).rejects.toThrow(/already serving ncl/);
      // The live socket file must still be there — nothing was unlinked.
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('cleans up a stale socket file nobody answers and binds', async () => {
    const socketPath = tmpSocketPath();
    // A crashed run's leftover: the file exists but no listener answers.
    fs.writeFileSync(socketPath, '');
    await startCliServer(socketPath);
    // Bound and accepting: a client connect succeeds.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve();
      });
      probe.once('error', reject);
    });
  });

  it('binds normally when no socket file exists', async () => {
    const socketPath = tmpSocketPath();
    await startCliServer(socketPath);
    expect(fs.existsSync(socketPath)).toBe(true);
  });
});
