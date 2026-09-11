import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshChannel, SshOpen } from '../../community-portal/link.js';
import type { ChannelHandler, Frame } from '../../community-portal/mux.js';
import type { DoorStream } from '../door/index.js';
import type { Door } from './door.js';
import { CHUNK_BYTES, WINDOW_BYTES, decodeChunk, openStream } from './stream.js';

/**
 * The pipe against a loopback TCP server standing in for the door and a
 * hand-driven channel standing in for the link. Nothing here leaves the
 * machine; the servers listen on 127.0.0.1:0.
 */
type Sent = { t: string } & Record<string, unknown>;

class FakeChannel implements SshChannel {
  readonly ch = 2;
  sent: Sent[] = [];
  released = 0;
  allowance = 24_000;
  private seq = 0;
  send(t: 'data' | 'credit' | 'end' | 'close', fields: Record<string, unknown> = {}): boolean {
    const raw = JSON.stringify({ ...fields, v: 1, ch: this.ch, seq: ++this.seq, t });
    if (raw.length > this.allowance) return false;
    this.sent.push({ t, ...fields });
    return true;
  }
  release(): void {
    this.released++;
  }
  types(): string[] {
    return this.sent.map((f) => f.t);
  }
  bytesOut(): number {
    return this.sent
      .filter((f) => f.t === 'data')
      .reduce((n, f) => n + Buffer.from(f.b64 as string, 'base64').length, 0);
  }
}

const OPEN: SshOpen = {
  stream: 'q7Xk1m2n3o4p5r6s7t8u9v',
  target: { account: 'alice' },
  source: { ip: '2001:db8::1', port: 4242 },
};
const frame = (t: string, fields: Record<string, unknown> = {}): Frame => ({ v: 1, ch: 2, seq: 1, t, ...fields });
const data = (off: number, bytes: Buffer): Frame => frame('data', { off, b64: bytes.toString('base64') });
async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(5);
  }
}

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
const handlers: ChannelHandler[] = [];
let door: Door;
let registrations: string[];

function listen(onConnection: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    onConnection(socket);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function start(doorPort: number, options: Partial<Parameters<typeof openStream>[0]> = {}) {
  const channel = new FakeChannel();
  const log = vi.fn();
  const handler = openStream({ open: OPEN, channel, doorPort, door, log, ...options });
  handlers.push(handler);
  return { channel, handler, log };
}

beforeEach(() => {
  // A door as the link sees it, with its targets in memory and every registration recorded in order.
  const targets = new Map<number, DoorStream>();
  registrations = [];
  door = {
    status: async () => ({ enabled: true, authorizedFingerprints: [] }),
    registerTarget: (port, entry) => {
      registrations.push(`register:${port}`);
      targets.set(port, { ...entry, openedAt: entry.openedAt ?? 'now' });
    },
    unregisterTarget: (port) => {
      registrations.push(`unregister:${port}`);
      targets.delete(port);
    },
    lookupTarget: (port) => targets.get(port),
    applyTerminalSnapshot: async () => {},
  };
});

afterEach(async () => {
  for (const handler of handlers.splice(0)) handler.onTeardown();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('openStream', () => {
  it('registers the target before the first byte reaches the door, then echoes both ways with credit', async () => {
    let registeredAtFirstByte: boolean | undefined;
    let doorSaw = Buffer.alloc(0);
    const port = await listen((socket) => {
      socket.once('data', () => {
        registeredAtFirstByte = door.lookupTarget(socket.remotePort ?? -1) !== undefined;
      });
      socket.on('data', (chunk: Buffer) => {
        doorSaw = Buffer.concat([doorSaw, chunk]);
      });
      socket.pipe(socket);
    });
    const { channel, handler, log } = start(port);
    // Bytes that arrive before the connection is up wait for it.
    handler.onFrame(data(0, Buffer.from('SSH-2.0-terminal\r\n')));
    await until(() => channel.sent.some((f) => f.t === 'credit'));
    expect(registeredAtFirstByte).toBe(true);
    expect(registrations).toHaveLength(1);
    const sourcePort = Number(registrations[0].split(':')[1]);
    expect(door.lookupTarget(sourcePort)).toEqual({
      stream: OPEN.stream,
      target: { account: 'alice' },
      source: { ip: '2001:db8::1', port: 4242 },
      openedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(log).toHaveBeenCalledWith({ event: 'stream_open', stream: OPEN.stream, account: 'alice', sourcePort });
    expect(channel.sent).toContainEqual({ t: 'credit', ack: 18 });
    await until(() => channel.bytesOut() === 18);
    expect(channel.sent.find((f) => f.t === 'data')).toEqual({
      t: 'data',
      off: 0,
      b64: Buffer.from('SSH-2.0-terminal\r\n').toString('base64'),
    });
    expect(doorSaw.toString()).toBe('SSH-2.0-terminal\r\n');
    // More bytes after the connection: contiguous offsets, credit per delivered chunk.
    handler.onFrame(data(18, Buffer.from('more')));
    await until(() => channel.sent.some((f) => f.t === 'credit' && f.ack === 22));
    await until(() => channel.bytesOut() === 22);
    expect(channel.sent.filter((f) => f.t === 'data').map((f) => f.off)).toEqual([0, 18]);
    handler.onFrame(frame('credit', { ack: 22 }));
    // The far end finishes: our half-close reaches the door, whose echo ends, and close follows once acknowledged.
    handler.onFrame(frame('end'));
    await until(() => channel.types().includes('close'));
    expect(channel.types().slice(-2)).toEqual(['end', 'close']);
    expect(channel.sent.at(-1)).toEqual({ t: 'close' });
    expect(channel.released).toBe(1);
    expect(registrations).toEqual([`register:${sourcePort}`, `unregister:${sourcePort}`]);
    expect(door.lookupTarget(sourcePort)).toBeUndefined();
    expect(log).toHaveBeenCalledWith({
      event: 'stream_closed',
      stream: OPEN.stream,
      by: 'host',
      bytesIn: 22,
      bytesOut: 22,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('terminal');
  });

  it('drains the final bytes: end goes out with the data, close waits for the far end and the credit', async () => {
    const goodbye = Buffer.alloc(100, 7);
    let doorClosed = false;
    const port = await listen((socket) => {
      socket.on('close', () => {
        doorClosed = true;
      });
      socket.end(goodbye);
    });
    const { channel, handler } = start(port);
    await until(() => channel.types().includes('end'));
    expect(channel.types()).toEqual(['data', 'end']);
    expect(channel.sent[0]).toMatchObject({ off: 0, b64: goodbye.toString('base64') });
    // The door only half-closed: the stream still carries the far end's bytes to it.
    await sleep(50);
    expect(channel.types()).toEqual(['data', 'end']);
    expect(doorClosed).toBe(false);
    // The far end ends too; the socket closes, but close waits for the credit on the goodbye.
    handler.onFrame(frame('end'));
    await until(() => doorClosed);
    await sleep(50);
    expect(channel.types()).toEqual(['data', 'end']);
    expect(channel.released).toBe(0);
    handler.onFrame(frame('credit', { ack: 100 }));
    await until(() => channel.types().includes('close'));
    expect(channel.sent.at(-1)).toEqual({ t: 'close' });
    expect(channel.released).toBe(1);
  });

  it('gives up the drain after the timeout with close timeout', async () => {
    const port = await listen((socket) => socket.end(Buffer.alloc(10, 1)));
    const { channel, handler } = start(port, { drainTimeoutMs: 50 });
    await until(() => channel.types().includes('end'));
    handler.onFrame(frame('end'));
    await until(() => channel.types().includes('close'));
    expect(channel.sent.at(-1)).toEqual({ t: 'close', reason: 'timeout' });
  });

  it('holds door output to 16 KiB chunks and 64 KiB in flight until credit arrives', async () => {
    const total = 200_000;
    const port = await listen((socket) => {
      socket.write(Buffer.alloc(total, 3));
    });
    const { channel, handler } = start(port);
    await until(() => channel.bytesOut() === WINDOW_BYTES);
    await sleep(50);
    expect(channel.bytesOut()).toBe(WINDOW_BYTES);
    const sizes = () =>
      channel.sent.filter((f) => f.t === 'data').map((f) => Buffer.from(f.b64 as string, 'base64').length);
    expect(sizes()).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES]);
    handler.onFrame(frame('credit', { ack: CHUNK_BYTES }));
    await until(() => channel.bytesOut() === WINDOW_BYTES + CHUNK_BYTES);
    await sleep(20);
    expect(channel.bytesOut()).toBe(WINDOW_BYTES + CHUNK_BYTES);
    handler.onFrame(frame('credit', { ack: WINDOW_BYTES + CHUNK_BYTES }));
    await until(() => channel.bytesOut() === 2 * WINDOW_BYTES + CHUNK_BYTES);
    let acked = 2 * WINDOW_BYTES + CHUNK_BYTES;
    while (channel.bytesOut() < total) {
      handler.onFrame(frame('credit', { ack: acked }));
      await until(() => channel.bytesOut() > acked || channel.bytesOut() === total);
      acked = channel.bytesOut();
    }
    const offs = channel.sent.filter((f) => f.t === 'data').map((f) => f.off as number);
    for (const [i, size] of sizes().entries()) {
      expect(size).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(offs[i]).toBe(
        sizes()
          .slice(0, i)
          .reduce((n, s) => n + s, 0),
      );
    }
    expect(channel.bytesOut()).toBe(total);
  });

  it('closes with protocol on a window overrun, a wrong offset, a bad chunk, a bad credit or data after end', async () => {
    const port = await listen((socket) => socket.pipe(socket));
    {
      const { channel, handler } = start(port);
      const chunk = Buffer.alloc(CHUNK_BYTES, 1);
      for (let i = 0; i < 4; i++) handler.onFrame(data(i * CHUNK_BYTES, chunk));
      expect(channel.types()).toEqual([]);
      handler.onFrame(data(4 * CHUNK_BYTES, chunk));
      expect(channel.sent.at(-1)).toEqual({ t: 'close', reason: 'protocol' });
      expect(channel.released).toBe(1);
    }
    const cases: [string, Frame][] = [
      ['offset', data(1, Buffer.from('x'))],
      ['not base64', frame('data', { off: 0, b64: '!!!!' })],
      ['empty', frame('data', { off: 0, b64: '' })],
      ['oversize', data(0, Buffer.alloc(CHUNK_BYTES + 1, 1))],
      ['credit beyond sent', frame('credit', { ack: 1 })],
      ['credit not an integer', frame('credit', { ack: 0.5 })],
      ['unknown type', frame('open', { kind: 'ssh' })],
    ];
    for (const [, bad] of cases) {
      const { channel, handler } = start(port);
      await until(() => registrations.length > 0);
      handler.onFrame(bad);
      expect(channel.sent.at(-1)).toEqual({ t: 'close', reason: 'protocol' });
      expect(channel.released).toBe(1);
      registrations.length = 0;
    }
    {
      const { channel, handler } = start(port);
      await until(() => registrations.length > 0);
      handler.onFrame(frame('end'));
      handler.onFrame(data(0, Buffer.from('late')));
      expect(channel.sent.at(-1)).toEqual({ t: 'close', reason: 'protocol' });
    }
  });

  it('answers a door that does not accept with close unavailable and registers nothing', async () => {
    const port = await listen(() => {});
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    const { channel, handler, log } = start(port);
    handler.onFrame(data(0, Buffer.from('hello')));
    await until(() => channel.types().includes('close'));
    expect(channel.sent).toEqual([{ t: 'close', reason: 'unavailable' }]);
    expect(channel.released).toBe(1);
    expect(registrations).toEqual([]);
    expect(log).toHaveBeenCalledWith({
      event: 'stream_closed',
      stream: OPEN.stream,
      by: 'host',
      reason: 'unavailable',
      bytesIn: 5,
      bytesOut: 0,
    });
  });

  it('answers a door that resets an established connection with close peer', async () => {
    // The reset follows the first byte, so it cannot race the connection itself (that would be unavailable).
    const port = await listen((socket) => socket.once('data', () => socket.resetAndDestroy()));
    const { channel, handler } = start(port);
    await until(() => registrations.length === 1);
    handler.onFrame(data(0, Buffer.from('x')));
    await until(() => channel.types().includes('close'));
    expect(channel.sent.at(-1)).toEqual({ t: 'close', reason: 'peer' });
  });

  it('destroys the door socket on a close from the far end and on a link teardown, sending nothing more', async () => {
    const closed: number[] = [];
    const port = await listen((socket) => {
      const from = socket.remotePort ?? -1;
      socket.on('close', () => closed.push(from));
      socket.pipe(socket);
    });
    const a = start(port);
    const b = start(port);
    await until(() => registrations.length === 2);
    const ports = registrations.map((r) => Number(r.split(':')[1]));
    expect(new Set(ports).size).toBe(2);
    a.handler.onFrame(frame('close', { reason: 'peer' }));
    await until(() => closed.includes(ports[0]));
    expect(a.channel.sent).toEqual([]);
    expect(a.channel.released).toBe(1);
    expect(door.lookupTarget(ports[0])).toBeUndefined();
    expect(door.lookupTarget(ports[1])).toBeDefined();
    b.handler.onTeardown();
    await until(() => closed.includes(ports[1]));
    expect(b.channel.sent).toEqual([]);
    expect(b.channel.released).toBe(1);
    expect(door.lookupTarget(ports[1])).toBeUndefined();
    expect(b.log).toHaveBeenCalledWith({
      event: 'stream_closed',
      stream: OPEN.stream,
      by: 'link',
      bytesIn: 0,
      bytesOut: 0,
    });
    // Idempotent: a late close from the socket or the link changes nothing.
    b.handler.onTeardown();
    b.handler.onFrame(frame('close'));
    expect(b.channel.released).toBe(1);
  });

  it('half-closes the door on end while still relaying its output', async () => {
    const port = await listen((socket) => {
      socket.on('end', () => {
        socket.write('bye');
        socket.end();
      });
    });
    const { channel, handler } = start(port);
    await until(() => registrations.length === 1);
    handler.onFrame(frame('end'));
    await until(() => channel.types().includes('end'));
    expect(channel.sent[0]).toEqual({ t: 'data', off: 0, b64: Buffer.from('bye').toString('base64') });
    handler.onFrame(frame('credit', { ack: 3 }));
    await until(() => channel.types().includes('close'));
    expect(channel.sent.at(-1)).toEqual({ t: 'close' });
  });

  it('decodes only canonical base64 of 1..16 384 bytes', () => {
    expect(decodeChunk('AAECAw==')).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(decodeChunk(Buffer.alloc(CHUNK_BYTES, 9).toString('base64'))?.length).toBe(CHUNK_BYTES);
    expect(decodeChunk(Buffer.alloc(CHUNK_BYTES + 1, 9).toString('base64'))).toBeNull();
    expect(decodeChunk('')).toBeNull();
    expect(decodeChunk('AAECAw')).toBeNull();
    expect(decodeChunk('AAEC_w==')).toBeNull();
    expect(decodeChunk(42)).toBeNull();
  });
});
