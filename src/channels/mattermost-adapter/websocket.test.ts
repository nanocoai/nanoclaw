import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

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
