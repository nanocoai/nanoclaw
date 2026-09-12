import { afterEach, expect, it, vi } from 'vitest';
import {
  CLOSE_FORBIDDEN,
  CellLink,
  MAX_STREAMS,
  computeBackoffDelay,
  hostCaps,
  parseSshOpen,
  type LinkSocket,
  type SshChannel,
  type SshOpen,
  type SshOpener,
} from './link.js';
import type { Frame } from './mux.js';

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

/** A stream opener the test drives by hand: records every open and the frames each channel receives. */
function fakeOpener() {
  const opened: { open: SshOpen; channel: SshChannel; frames: Frame[]; torn: number }[] = [];
  const ssh: SshOpener = (open, channel) => {
    const entry = { open, channel, frames: [] as Frame[], torn: 0 };
    opened.push(entry);
    return { onFrame: (frame) => entry.frames.push(frame), onTeardown: () => entry.torn++ };
  };
  return { ssh, opened };
}
const sshOpen = (stream: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'ssh',
  stream,
  target: { account: 'alice' },
  source: { ip: '2001:db8::1', port: 4242 },
  ...extra,
});

it('refuses channel kinds it does not support, ssh included while no opener is installed, and ignores their data', async () => {
  const { link, onSnapshot } = connect();
  link.start();
  await settle();
  const socket = FakeSocket.instances[0];
  socket.open();
  expect(socket.frames()[0]).toMatchObject({ t: 'hello', caps: ['perks'] });
  socket.frame(2, 'open', sshOpen('s1'));
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 2, seq: 1, t: 'error', code: 'unsupported' });
  socket.frame(3, 'open', { kind: 'files' });
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 3, seq: 1, t: 'error', code: 'unsupported' });
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

it('announces ssh with an opener installed and hands every ssh open to it with its target and source', async () => {
  const { ssh, opened } = fakeOpener();
  const { link, log } = connect({ ssh });
  link.start();
  await settle();
  const socket = FakeSocket.instances[0];
  socket.open();
  expect(socket.frames()[0]).toEqual({ v: 1, ch: 0, seq: 1, t: 'hello', leg: 'host', caps: ['perks', 'ssh'] });
  socket.frame(1, 'open', { kind: 'perks' });
  socket.frame(2, 'open', sshOpen('s1', { target: { account: 'alice', sandbox: 'api' }, ticket: 'jti1' }));
  expect(opened).toHaveLength(1);
  expect(opened[0].open).toEqual({
    stream: 's1',
    target: { account: 'alice', sandbox: 'api' },
    source: { ip: '2001:db8::1', port: 4242 },
    ticket: 'jti1',
  });
  expect(opened[0].channel.ch).toBe(2);
  expect(link.streams).toBe(1);
  // Frames on the channel reach its handler untouched.
  socket.frame(2, 'data', { off: 0, b64: 'AAECAw==' });
  socket.frame(2, 'credit', { ack: 4 });
  expect(opened[0].frames.map((f) => [f.t, f.off ?? f.ack])).toEqual([
    ['data', 0],
    ['credit', 4],
  ]);
  // The channel sends with the ssh allowance: a full 16 KiB chunk fits.
  const chunk = Buffer.alloc(16_384, 1).toString('base64');
  expect(opened[0].channel.send('data', { off: 0, b64: chunk })).toBe(true);
  expect(socket.frames().at(-1)).toMatchObject({ ch: 2, seq: 1, t: 'data', off: 0 });
  expect(opened[0].channel.send('credit', { ack: 4 })).toBe(true);
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 2, seq: 2, t: 'credit', ack: 4 });
  // A second open on a channel already open is ignored.
  socket.frame(2, 'open', sshOpen('s2'));
  expect(opened).toHaveLength(1);
  // release forgets the channel and tears its handler down exactly once; later frames go nowhere.
  opened[0].channel.release();
  opened[0].channel.release();
  expect(opened[0].torn).toBe(1);
  expect(link.streams).toBe(0);
  socket.frame(2, 'data', { off: 4, b64: 'AA==' });
  expect(opened[0].frames).toHaveLength(2);
  // An open that is off the contract is refused with close protocol and never reaches the opener.
  socket.frame(3, 'open', { kind: 'ssh', stream: 's3' });
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 3, seq: 1, t: 'close', reason: 'protocol' });
  expect(log).toHaveBeenCalledWith({ event: 'stream_refused', reason: 'protocol' });
  expect(opened).toHaveLength(1);
  // A link drop tears every open stream down without sending anything.
  socket.frame(4, 'open', sshOpen('s4'));
  expect(opened).toHaveLength(2);
  const sentBefore = socket.sent.length;
  socket.lost();
  expect(opened[1].torn).toBe(1);
  expect(socket.sent).toHaveLength(sentBefore);
  expect(link.streams).toBe(0);
});

it('refuses a ninth stream with close busy and accepts another once a slot frees', async () => {
  const { ssh, opened } = fakeOpener();
  const { link, log } = connect({ ssh });
  link.start();
  await settle();
  const socket = FakeSocket.instances[0];
  socket.open();
  for (let ch = 2; ch < 2 + MAX_STREAMS; ch++) socket.frame(ch, 'open', sshOpen(`s${ch}`));
  expect(opened).toHaveLength(MAX_STREAMS);
  expect(link.streams).toBe(MAX_STREAMS);
  socket.frame(20, 'open', sshOpen('s20'));
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 20, seq: 1, t: 'close', reason: 'busy' });
  expect(log).toHaveBeenCalledWith({ event: 'stream_refused', reason: 'busy', stream: 's20' });
  expect(opened).toHaveLength(MAX_STREAMS);
  // The far end closes one stream; its pipe releases the channel and the slot is free again.
  socket.frame(3, 'close', { reason: 'peer' });
  expect(opened[1].frames.at(-1)).toMatchObject({ t: 'close', reason: 'peer' });
  opened[1].channel.release();
  expect(link.streams).toBe(MAX_STREAMS - 1);
  socket.frame(21, 'open', sshOpen('s21'));
  expect(opened).toHaveLength(MAX_STREAMS + 1);
  expect(opened.at(-1)?.open.stream).toBe('s21');
});

it('renews its ticket into every socket and again after each renewed, leaving expiry as the failure path', async () => {
  vi.useFakeTimers();
  const { link, getTicket, log } = connect({ renewMs: 1_000, renewJitterMs: 0 });
  link.start();
  await settle();
  const socket = FakeSocket.instances[0];
  socket.open();
  await vi.advanceTimersByTimeAsync(999);
  expect(getTicket).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getTicket).toHaveBeenCalledTimes(2);
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 0, seq: 2, t: 'renew', ticket: 'tkt.2' });
  // Nothing more until the cell confirms.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(getTicket).toHaveBeenCalledTimes(2);
  socket.frame(0, 'renewed', { exp: 1_757_600_000 });
  expect(log).toHaveBeenCalledWith({ event: 'renewed', exp: 1_757_600_000 });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(getTicket).toHaveBeenCalledTimes(3);
  expect(socket.frames().at(-1)).toEqual({ v: 1, ch: 0, seq: 3, t: 'renew', ticket: 'tkt.3' });
  socket.frame(0, 'renewed', { exp: 1_757_600_900 });
  // A ticket that cannot be fetched is logged; the socket stays up and the cell's expiry close redials.
  getTicket.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(log).toHaveBeenCalledWith({ event: 'renew_failed', code: 'ECONNREFUSED' });
  expect(socket.closed).toBe(false);
  expect(socket.frames().filter((f) => f.t === 'renew')).toHaveLength(2);
  // A socket that is gone is never renewed; stop clears the timer.
  socket.frame(0, 'renewed', { exp: 1 });
  link.stop();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(getTicket).toHaveBeenCalledTimes(4);
});

it('jitters the renewal and keeps its caps explicit', () => {
  expect(hostCaps()).toEqual(['perks']);
  expect(hostCaps({ ssh: true })).toEqual(['perks', 'ssh']);
  expect(hostCaps({ ssh: false })).toEqual(['perks']);
  const frame = (fields: Record<string, unknown>): Frame => ({ v: 1, ch: 2, seq: 1, t: 'open', ...fields });
  expect(parseSshOpen(frame(sshOpen('s1')))).toEqual({
    stream: 's1',
    target: { account: 'alice' },
    source: { ip: '2001:db8::1', port: 4242 },
  });
  expect(parseSshOpen(frame(sshOpen('s1', { ticket: 7 })))?.ticket).toBeUndefined();
  expect(parseSshOpen(frame(sshOpen('')))).toBeNull();
  expect(parseSshOpen(frame(sshOpen('s1', { target: {} })))).toBeNull();
  expect(parseSshOpen(frame(sshOpen('s1', { target: { account: 'alice', sandbox: '' } })))).toBeNull();
  expect(parseSshOpen(frame(sshOpen('s1', { source: { ip: '::1' } })))).toBeNull();
  expect(parseSshOpen(frame(sshOpen('s1', { source: { ip: 1, port: 2 } })))).toBeNull();
});

it('computes the jittered exponential backoff of the reference module', () => {
  expect(computeBackoffDelay(0, { random: () => 0 })).toBe(500);
  expect(computeBackoffDelay(0, { random: () => 1 })).toBe(1_000);
  expect(computeBackoffDelay(3, { random: () => 0.5 })).toBe(6_000);
  expect(computeBackoffDelay(10, { random: () => 1 })).toBe(30_000);
  expect(computeBackoffDelay(-5, { random: () => 1 })).toBe(1_000);
  expect(computeBackoffDelay(1, { baseMs: 100, capMs: 150, random: () => 1 })).toBe(150);
});
