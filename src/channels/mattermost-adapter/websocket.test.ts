import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import { MattermostSocket } from './websocket.js';

const silentLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  pings = 0;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  on(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.readyState = 3;
    this.emit('close', 1006);
  }
}

/** Connect a socket through the fake transport and complete the auth handshake. */
async function connectSocket(overrides: { heartbeatIntervalMs?: number | undefined }): Promise<{
  socket: MattermostSocket;
  transport: FakeWebSocket;
}> {
  const socket = new MattermostSocket({
    baseUrl: 'http://mattermost.test',
    logger: silentLogger,
    onEvent: () => {},
    token: 'test-token',
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ...overrides,
  });
  const connected = socket.connect();
  const transport = FakeWebSocket.instances.at(-1)!;
  transport.readyState = 1;
  transport.emit('open');
  const auth = JSON.parse(transport.sent.at(-1)!) as { seq: number };
  transport.emit('message', JSON.stringify({ status: 'OK', seq_reply: auth.seq }));
  await connected;
  return { socket, transport };
}

describe('MattermostSocket heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the 30s default when heartbeatIntervalMs is passed as an explicit undefined', async () => {
    // Regression: the adapter forwards its optional config verbatim, so the
    // socket receives `heartbeatIntervalMs: undefined` as an own key. Before
    // the constructor guarded its defaults, that clobbered the 30s interval
    // and `setInterval(cb, undefined)` pinged the server every ~1ms.
    const { socket, transport } = await connectSocket({ heartbeatIntervalMs: undefined });

    vi.advanceTimersByTime(29_000);
    expect(transport.pings).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(transport.pings).toBe(1);

    await socket.disconnect();
  });

  it('honors an explicit heartbeat interval', async () => {
    const { socket, transport } = await connectSocket({ heartbeatIntervalMs: 5_000 });

    vi.advanceTimersByTime(4_999);
    expect(transport.pings).toBe(0);

    vi.advanceTimersByTime(1);
    expect(transport.pings).toBe(1);

    await socket.disconnect();
  });

  it('disables the heartbeat when the interval is 0', async () => {
    const { socket, transport } = await connectSocket({ heartbeatIntervalMs: 0 });

    vi.advanceTimersByTime(120_000);
    expect(transport.pings).toBe(0);

    await socket.disconnect();
  });
});

// The host's setup retry (channel-registry) matches on `name === 'NetworkError'`.
describe('MattermostSocket connect failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startConnect(): { connected: Promise<unknown>; socket: MattermostSocket; transport: FakeWebSocket } {
    const socket = new MattermostSocket({
      baseUrl: 'http://mattermost.test',
      logger: silentLogger,
      onEvent: () => {},
      token: 'test-token',
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connected = socket.connect().then(
      () => undefined,
      (err: unknown) => err,
    );
    return { connected, socket, transport: FakeWebSocket.instances.at(-1)! };
  }

  function open(transport: FakeWebSocket): void {
    transport.readyState = 1;
    transport.emit('open');
  }

  it.each([
    ['a refused connection', new Error('connect ECONNREFUSED 10.0.0.5:443')],
    ['a 502 upgrade reply', new Error('Unexpected server response: 502')],
  ])('tags %s as a NetworkError', async (_label, cause) => {
    const { connected, transport } = startConnect();
    transport.emit('error', cause);
    expect(await connected).toMatchObject({ name: 'NetworkError', cause });
  });

  it('tags a close before authentication as a NetworkError', async () => {
    const { connected, transport } = startConnect();
    open(transport);
    transport.emit('close', 1006);
    expect(await connected).toMatchObject({ name: 'NetworkError' });
  });

  it('tags an authentication timeout as a NetworkError', async () => {
    const { connected, transport } = startConnect();
    open(transport);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await connected).toMatchObject({ name: 'NetworkError' });
  });

  it('gives a slow upgrade and a slow token reply a deadline each', async () => {
    // 6 s to open, then 6 s to accept the token: 12 s in all, each step under 10 s.
    const { connected, socket, transport } = startConnect();
    await vi.advanceTimersByTimeAsync(6_000);
    open(transport);
    await vi.advanceTimersByTimeAsync(6_000);
    const auth = JSON.parse(transport.sent.at(-1)!) as { seq: number };
    transport.emit('message', JSON.stringify({ status: 'OK', seq_reply: auth.seq }));
    expect(await connected).toBeUndefined();
    await socket.disconnect();
  });

  it('fails fast on a 4xx upgrade reply', async () => {
    const { connected, transport } = startConnect();
    transport.emit('error', new Error('Unexpected server response: 400'));
    expect(await connected).toMatchObject({ name: 'Error', message: 'Unexpected server response: 400' });
  });

  it('fails fast when the server rejects the token', async () => {
    const { connected, transport } = startConnect();
    open(transport);
    const auth = JSON.parse(transport.sent.at(-1)!) as { seq: number };
    transport.emit(
      'message',
      JSON.stringify({ status: 'FAIL', seq_reply: auth.seq, error: { message: 'invalid token' } }),
    );
    expect(await connected).toMatchObject({ name: 'Error', message: expect.stringContaining('authentication failed') });
  });
});

describe('MattermostSocket opening handshake', () => {
  // A real server that takes the upgrade and never completes it: `silent`
  // sends nothing; `trickle` sends a header line every 20 ms, which an idle
  // timeout alone never catches.
  it.each(['silent', 'trickle'] as const)('rejects a %s upgrade as a retryable network error', async (mode) => {
    const server = createServer();
    const peers = new Set<Socket>();
    server.on('connection', (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.on('close', () => peers.delete(peer));
    });
    server.on('upgrade', (_request, peer: Socket) => {
      if (mode === 'silent') return;
      peer.write('HTTP/1.1 101 Switching Protocols\r\n');
      const trickle = setInterval(() => {
        if (!peer.destroyed) peer.write('X-Pad: 1\r\n');
      }, 20);
      peer.on('close', () => clearInterval(trickle));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const socket = new MattermostSocket({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'test-token',
      logger: silentLogger,
      onEvent: () => {},
      authTimeoutMs: 250,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        socket.connect().then(
          () => 'unexpected success',
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) => {
          watchdog = setTimeout(() => resolve('opening handshake remained pending'), 3000);
        }),
      ]);
      expect(result).toMatchObject({ name: 'NetworkError', message: expect.stringMatching(/handshake/i) });
      expect(socket.connected).toBe(false);
    } finally {
      clearTimeout(watchdog);
      await socket.disconnect();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('MattermostSocket after the opening deadline', () => {
  it('closes the socket, so a late upgrade never gets the token', async () => {
    // The server holds the upgrade until connect() has rejected, then finishes
    // it and accepts any token. A socket left open would send its token there
    // and later reconnect; a closed one ends its TCP connection instead.
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const peers = new Set<Socket>();
    let connections = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let report!: (outcome: 'token sent' | 'connection ended') => void;
    const outcome = new Promise<string>((resolve) => (report = resolve));
    server.on('connection', (peer) => {
      connections += 1;
      peers.add(peer);
      peer.on('error', () => {});
      peer.on('end', () => report('connection ended'));
      peer.on('close', () => {
        peers.delete(peer);
        report('connection ended');
      });
    });
    server.on('upgrade', (request, peer: Socket, head: Buffer) => {
      void released.then(() => {
        if (peer.destroyed) return;
        wss.handleUpgrade(request, peer, head, (ws) => {
          ws.on('message', (raw) => {
            report('token sent');
            const { seq } = JSON.parse(String(raw)) as { seq: number };
            ws.send(JSON.stringify({ status: 'OK', seq_reply: seq }), () => ws.close());
          });
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const socket = new MattermostSocket({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'test-token',
      logger: silentLogger,
      onEvent: () => {},
      authTimeoutMs: 100,
      minBackoffMs: 50,
    });
    // One watchdog for both waits, so a hang still reaches `finally`.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<string>((resolve) => {
      watchdog = setTimeout(() => resolve('stalled for 3 s'), 3000);
    });
    try {
      const result = await Promise.race([
        socket.connect().then(
          () => 'unexpected success',
          (error: unknown) => error,
        ),
        stalled,
      ]);
      expect(result).toMatchObject({ name: 'NetworkError', message: expect.stringMatching(/handshake/i) });
      release();
      const first = await Promise.race([outcome, stalled]);
      expect(first).toBe('connection ended');
      // No reconnect: a rejected first connect leaves retries to the caller.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(connections).toBeLessThanOrEqual(1);
      expect(socket.connected).toBe(false);
    } finally {
      clearTimeout(watchdog);
      release();
      await socket.disconnect();
      for (const client of wss.clients) client.terminate();
      wss.close();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
