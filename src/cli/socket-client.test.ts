import { mkdtemp, rm } from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { SocketTransport } from './socket-client.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const tempDirs: string[] = [];

async function makeSocketPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nanoclaw-socket-client-'));
  tempDirs.push(dir);
  return path.join(dir, 'ncl.sock');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SocketTransport', () => {
  it('caps host responses by bytes, not decoded string length', async () => {
    const socketPath = await makeSocketPath();
    const oversizedUtf8Payload = 'é'.repeat(Math.floor(MAX_RESPONSE_BYTES / 2) + 1);
    const sockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {
        // The client intentionally closes as soon as the byte cap is exceeded.
      });
      socket.end(oversizedUtf8Payload);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(
        new SocketTransport(socketPath).sendFrame({ id: 'req-1', command: 'groups:list', args: {} }),
      ).rejects.toThrow('host response exceeded maximum size');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
