import { afterEach, expect, it, vi } from 'vitest';
import { CLOSE_FORBIDDEN, CellLink, computeBackoffDelay, type LinkSocket } from './link.js';

type Listener = (event: { data: unknown; code?: number }) => void;

/** A WHATWG-shaped socket the test drives by hand. */
class FakeSocket implements LinkSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(
    readonly url: URL,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(data: unknown): void {
    this.emit('message', { data });
  }
  /** A frame from the cell: seq is stamped per channel like the cell does. */
  frame(ch: number, t: string, fields: Record<string, unknown> = {}): void {
    const seq = (this.seqs.get(ch) ?? 0) + 1;
    this.seqs.set(ch, seq);
    this.message(JSON.stringify({ v: 1, ch, seq, t, ...fields }));
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  lost(code?: number): void {
    this.readyState = 3;
    this.emit('close', { data: undefined, ...(code === undefined ? {} : { code }) });
  }
  private seqs = new Map<number, number>();
  private emit(type: string, event: { data: unknown; code?: number } = { data: undefined }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const ORIGIN = 'https://portal.example.test';
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const links: CellLink[] = [];
function connect(overrides: Partial<ConstructorParameters<typeof CellLink>[0]> = {}) {
  const log = vi.fn();
  const onSnapshot = vi.fn();
  const onChange = vi.fn();
  let tickets = 0;
  const getTicket = vi.fn(async () => ({
    ticket: `tkt.${++tickets}`,
    socketUrl: `wss://portal.example.test/cell/link`,
  }));
  const link = new CellLink({
    origin: ORIGIN,
    getTicket,
    onSnapshot,
    onChange,
    log,
    Socket: FakeSocket,
    random: () => 1,
    ...overrides,
  });
  links.push(link);
  return { link, log, onSnapshot, onChange, getTicket };
}

afterEach(() => {
  for (const link of links.splice(0)) link.stop();
  FakeSocket.instances = [];
  vi.useRealTimers();
});

it('dials with the ticket as a subprotocol, says hello as the host leg first, and hands perks data to onSnapshot', async () => {
  const { link, onSnapshot, onChange, log } = connect({ ver: '1.2.3' });
  link.start();
  await settle();
  expect(FakeSocket.instances).toHaveLength(1);
  const socket = FakeSocket.instances[0];
  expect(socket.url.href).toBe('wss://portal.example.test/cell/link');
  expect(socket.protocols).toEqual(['nc-cell', 'ticket.tkt.1']);
  expect(link.connected).toBe(false);
  socket.open();
  expect(link.connected).toBe(true);
  expect(socket.frames()).toEqual([{ v: 1, ch: 0, seq: 1, t: 'hello', leg: 'host', caps: ['perks'], ver: '1.2.3' }]);
  expect(log).toHaveBeenCalledWith({ event: 'connected' });
  socket.frame(0, 'hello', { leg: 'cell', revision: 3 });
  socket.frame(1, 'open', { kind: 'perks' });
  const snapshot = { revision: 3, grants: [{ perk: 'echo' }] };
  const presence = [{ deviceId: 'dev_1', connected: true }];
  socket.frame(1, 'data', { snapshot, presence });
  expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({ snapshot, presence });
  socket.frame(0, 'status', { state: 'presence', presence });
  // The data frame is the truth; the perks.changed that follows it is only a hint.
  socket.frame(0, 'perks.changed', { revision: 3 });
  expect(onChange).not.toHaveBeenCalled();
  socket.frame(1, 'data', { snapshot: { revision: 4 }, presence });
  socket.frame(0, 'perks.changed', { revision: 4 });
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  expect(onChange).not.toHaveBeenCalled();
  // A hint with no data frame before it is acted on.
  socket.frame(0, 'perks.changed', { revision: 5 });
  expect(onChange).toHaveBeenCalledTimes(1);
  // The host never answers a cell ping: a pong would be refused as read_only.
  socket.frame(0, 'ping');
  expect(socket.frames()).toHaveLength(1);
  // Anything unparseable, off-protocol or oversize is dropped; the host never answers it.
  socket.message('not json');
  socket.message(JSON.stringify({ type: 'perks.changed' }));
  socket.message(Buffer.from('binary'));
  socket.message(JSON.stringify({ v: 1, ch: 1, seq: 9, t: 'data', snapshot: 'x'.repeat(512_000) }));
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(socket.frames()).toHaveLength(1);
  socket.frame(0, 'error', { code: 'read_only' });
  expect(log).toHaveBeenCalledWith({ event: 'cell_error', code: 'read_only' });
  expect(JSON.stringify(log.mock.calls)).not.toContain('grants');
  link.stop();
  expect(socket.closed).toBe(true);
  expect(link.connected).toBe(false);
});

it('refuses channel kinds it does not support and ignores their data', async () => {
  const { link, onSnapshot } = connect();
  link.start();
  await settle();
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.frame(2, 'open', { kind: 'ssh' });
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 2, seq: 1, t: 'error', code: 'unsupported' });
  socket.frame(2, 'data', { snapshot: {}, presence: [] });
  expect(onSnapshot).not.toHaveBeenCalled();
  socket.frame(1, 'open', { kind: 'perks' });
  socket.frame(1, 'open', { kind: 'perks' });
  socket.frame(1, 'data', { snapshot: {}, presence: [] });
  expect(onSnapshot).toHaveBeenCalledTimes(1);
  socket.frame(1, 'close');
  socket.frame(1, 'data', { snapshot: {}, presence: [] });
  expect(onSnapshot).toHaveBeenCalledTimes(1);
  expect(socket.frames().filter((f) => f.ch === 1)).toEqual([]);
});

it('refuses a socket address outside the portal origin or off the cell path', async () => {
  for (const socketUrl of [
    'wss://elsewhere.example.test/cell/link',
    'wss://portal.example.test/other',
    'wss://portal.example.test/cell/link?x=1',
  ]) {
    const { link, log } = connect({ getTicket: async () => ({ ticket: 't', socketUrl }) });
    link.start();
    await settle();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(log).toHaveBeenCalledWith({ event: 'connection_retry', code: 'invalid_cell_url' });
    link.stop();
  }
});

it('retries with jittered exponential backoff when a ticket cannot be obtained', async () => {
  vi.useFakeTimers();
  const getTicket = vi.fn(async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  });
  const { link, log } = connect({ getTicket, backoffBaseMs: 100, backoffCapMs: 400, random: () => 1 });
  link.start();
  await settle();
  expect(log).toHaveBeenCalledWith({ event: 'connection_retry', code: 'ECONNREFUSED' });
  expect(getTicket).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(getTicket).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getTicket).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(200);
  expect(getTicket).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(400);
  expect(getTicket).toHaveBeenCalledTimes(4);
  // Capped: the next window is 400 again.
  await vi.advanceTimersByTimeAsync(400);
  expect(getTicket).toHaveBeenCalledTimes(5);
  link.stop();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(getTicket).toHaveBeenCalledTimes(5);
});

it('pings on the interval, drops a socket that misses its pong, and reconnects with a fresh ticket', async () => {
  vi.useFakeTimers();
  const { link, getTicket, log } = connect({
    pingMs: 1_000,
    pongTimeoutMs: 3_000,
    backoffBaseMs: 100,
    backoffCapMs: 100,
  });
  link.start();
  await settle();
  const first = FakeSocket.instances[0];
  first.open();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.frames().map((f) => f.t)).toEqual(['hello', 'ping']);
  expect(first.frames()[1]).toEqual({ v: 1, ch: 0, seq: 2, t: 'ping' });
  first.frame(0, 'pong');
  await vi.advanceTimersByTimeAsync(2_500);
  expect(first.frames().map((f) => f.t)).toEqual(['hello', 'ping', 'ping', 'ping']);
  expect(first.closed).toBe(false);
  // No pong for longer than the timeout: the socket is dropped and replaced.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(first.closed).toBe(true);
  expect(link.connected).toBe(false);
  expect(log).toHaveBeenCalledWith({ event: 'pong_timeout' });
  expect(log).toHaveBeenCalledWith({ event: 'disconnected' });
  await vi.advanceTimersByTimeAsync(100);
  expect(getTicket).toHaveBeenCalledTimes(2);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(FakeSocket.instances[1].protocols).toEqual(['nc-cell', 'ticket.tkt.2']);
  // A late close from the dropped socket changes nothing.
  first.lost();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

it('gives up on a handshake that does not open in time and reconnects', async () => {
  vi.useFakeTimers();
  const { link, log } = connect({ handshakeMs: 500, backoffBaseMs: 100, backoffCapMs: 100 });
  link.start();
  await settle();
  const first = FakeSocket.instances[0];
  await vi.advanceTimersByTimeAsync(499);
  expect(first.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(first.closed).toBe(true);
  expect(log).toHaveBeenCalledWith({ event: 'handshake_timeout' });
  await vi.advanceTimersByTimeAsync(100);
  expect(FakeSocket.instances).toHaveLength(2);
  FakeSocket.instances[1].open();
  expect(link.connected).toBe(true);
});

it('reconnects after the cell closes the connection, resetting the backoff after a stable session', async () => {
  vi.useFakeTimers();
  const { link, log } = connect({ backoffBaseMs: 100, backoffCapMs: 1_000, random: () => 1 });
  link.start();
  await settle();
  const first = FakeSocket.instances[0];
  first.open();
  first.lost();
  expect(link.connected).toBe(false);
  expect(log).toHaveBeenCalledWith({ event: 'disconnected' });
  await vi.advanceTimersByTimeAsync(100);
  expect(FakeSocket.instances).toHaveLength(2);
  FakeSocket.instances[1].lost();
  await vi.advanceTimersByTimeAsync(199);
  expect(FakeSocket.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeSocket.instances).toHaveLength(3);
  const third = FakeSocket.instances[2];
  third.open();
  await vi.advanceTimersByTimeAsync(31_000);
  third.lost();
  await vi.advanceTimersByTimeAsync(100);
  expect(FakeSocket.instances).toHaveLength(4);
});

it('reconnects on 4401 and 4008/4009 (logging the latter as a bug) and stops on 4403 until started again', async () => {
  vi.useFakeTimers();
  const onForbidden = vi.fn();
  const { link, log, getTicket } = connect({ onForbidden, backoffBaseMs: 100, backoffCapMs: 100 });
  link.start();
  await settle();
  const first = FakeSocket.instances[0];
  first.open();
  first.lost(4401);
  expect(log).toHaveBeenCalledWith({ event: 'disconnected', closeCode: 4401 });
  expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'protocol_error' }));
  await vi.advanceTimersByTimeAsync(100);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(FakeSocket.instances[1].protocols).toEqual(['nc-cell', 'ticket.tkt.2']);
  const second = FakeSocket.instances[1];
  second.open();
  second.lost(4008);
  expect(log).toHaveBeenCalledWith({ event: 'protocol_error', closeCode: 4008 });
  await vi.advanceTimersByTimeAsync(100);
  expect(FakeSocket.instances).toHaveLength(3);
  const third = FakeSocket.instances[2];
  third.open();
  third.lost(CLOSE_FORBIDDEN);
  expect(onForbidden).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith({ event: 'forbidden' });
  expect(link.connected).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.instances).toHaveLength(3);
  expect(getTicket).toHaveBeenCalledTimes(3);
  link.start();
  await settle();
  expect(FakeSocket.instances).toHaveLength(4);
});

it('computes the jittered exponential backoff of the reference module', () => {
  expect(computeBackoffDelay(0, { random: () => 0 })).toBe(500);
  expect(computeBackoffDelay(0, { random: () => 1 })).toBe(1_000);
  expect(computeBackoffDelay(3, { random: () => 0.5 })).toBe(6_000);
  expect(computeBackoffDelay(10, { random: () => 1 })).toBe(30_000);
  expect(computeBackoffDelay(-5, { random: () => 1 })).toBe(1_000);
  expect(computeBackoffDelay(1, { baseMs: 100, capMs: 150, random: () => 1 })).toBe(150);
});
