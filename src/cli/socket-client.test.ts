import { mkdtemp, rm } from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { SocketTransport } from './socket-client.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ncl-socket-client-'));
  tempDirs.push(dir);
  return path.join(dir, 'ncl.sock');
}

describe('SocketTransport response cap', () => {
  it('caps by bytes, not decoded string length (a multibyte payload under the char cap still trips)', async () => {
    const sock = await socketPath();
    // `é` is 2 bytes in UTF-8 but length 1 in JS, so this payload's JS string
    // length is ~half the cap (well under it) while its byte length exceeds it.
    // A char-length cap would let it through; the byte cap must reject it.
    const payload = 'é'.repeat(Math.floor(MAX_RESPONSE_BYTES / 2) + 1);
    const conns = new Set<net.Socket>();
    const server = net.createServer((c) => {
      conns.add(c);
      // The client closes the connection the moment the byte cap trips.
      c.on('error', () => {});
      c.end(payload);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });

    try {
      await expect(
        new SocketTransport(sock).sendFrame({ id: 'req-1', command: 'groups:list', args: {} }),
      ).rejects.toThrow('host response exceeded maximum size');
    } finally {
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
