import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localDoor, type Door } from '../../code-mode/remote/door.js';
import {
  DEVICE_PROOF_HEADER,
  ensureDeviceKey,
  reportTerminalState,
  verifyDeviceProof,
  writePrivate,
  type LinkSocket,
} from '../../community-portal/index.js';
import { startPortalRuntime } from './runtime.js';

/**
 * The runtime against a loopback stand-in for the portal and a hand-driven
 * socket: the identity is account.json + host-id + device-key.json + the
 * journal's device id, tickets carry bearer plus a valid proof, reconciling is
 * plain bearer, and the link dials with the ticket as a subprotocol.
 */
type Listener = (event: { data: unknown; code?: number }) => void;
class FakeSocket implements LinkSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
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
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get('open') ?? []) listener({ data: undefined });
  }
  lost(code: number): void {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({ data: undefined, code });
  }
  frame(ch: number, seq: number, t: string, fields: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: JSON.stringify({ v: 1, ch, seq, t, ...fields }) });
  }
}

interface Seen {
  method: string;
  route: string;
  authorization?: string;
  proofValid?: boolean;
  body?: unknown;
}
let server: Server;
let origin: string;
let root: string;
let home: string;
let ticketStatus = 200;
const seen: Seen[] = [];
const DEVICE_ID = 'dev_0123456789abcdef01234567';
const state = { grants: [] as unknown[] };

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text = '';
  for await (const chunk of req) text += chunk;
  const route = new URL(req.url ?? '/', origin).pathname;
  const record: Seen = { method: req.method ?? '', route, authorization: req.headers.authorization };
  if (text) record.body = JSON.parse(text);
  const proof = req.headers[DEVICE_PROOF_HEADER];
  if (typeof proof === 'string') {
    const key = ensureDeviceKey({ homeDir: home });
    record.proofValid = verifyDeviceProof(proof, key.publicKeyJwk).valid;
  }
  seen.push(record);
  res.setHeader('content-type', 'application/json');
  if (route === '/api/v1/cell-ticket') {
    if (!record.proofValid) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'invalid_proof' }));
      return;
    }
    res.writeHead(ticketStatus);
    res.end(
      ticketStatus === 200
        ? JSON.stringify({ ticket: 'tkt', expiresIn: 900, socketUrl: `${origin.replace('http', 'ws')}/cell/link` })
        : JSON.stringify({ error: 'installation_revoked' }),
    );
    return;
  }
  if (route === '/api/v1/device/state') {
    res.end(JSON.stringify(state));
    return;
  }
  if (route === '/api/v1/terminal/host') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not_found' }));
}
async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(10);
  }
}
const journalFile = (): string => path.join(root, 'data/community-portal.json');

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-runtime-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-home-'));
  seen.length = 0;
  ticketStatus = 200;
  FakeSocket.instances = [];
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  await mkdir(path.join(home, '.config/nanoclaw'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config/nanoclaw/account.json'),
    JSON.stringify({ version: 1, api: 'https://registry.example.test', account_id: 'acct-1', token: 'tok' }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, '.config/nanoclaw/host-id'), 'install-1\n', { mode: 0o600 });
}

it('stays idle without a registered device, then dials with a proofed ticket and reconciles over bearer', async () => {
  const log = vi.fn();
  await signIn();
  const runtime = startPortalRuntime({ root, homeDir: home, log, intervalMs: 50, Socket: FakeSocket });
  await sleep(200);
  expect(seen).toEqual([]);
  expect(FakeSocket.instances).toEqual([]);
  // Setup registers the device: the journal gains its id, the machine its key.
  ensureDeviceKey({ homeDir: home });
  await writePrivate(journalFile(), { origin, deviceId: DEVICE_ID, credentials: {}, operations: {} });
  await until(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0];
  expect(socket.url.href).toBe(`${origin.replace('http', 'ws')}/cell/link`);
  expect(socket.protocols).toEqual(['nc-cell', 'ticket.tkt']);
  const ticket = seen.find((r) => r.route === '/api/v1/cell-ticket');
  expect(ticket).toEqual({
    method: 'POST',
    route: '/api/v1/cell-ticket',
    authorization: 'Bearer tok',
    proofValid: true,
    body: {},
  });
  await until(() => seen.some((r) => r.route === '/api/v1/device/state'));
  expect(seen.find((r) => r.route === '/api/v1/device/state')).toEqual({
    method: 'GET',
    route: '/api/v1/device/state',
    authorization: 'Bearer tok',
  });
  socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({ v: 1, ch: 0, seq: 1, t: 'hello', leg: 'host', caps: ['perks'] });
  expect(log).toHaveBeenCalledWith({ event: 'connected', deviceId: DEVICE_ID });
  // A perks snapshot from the cell triggers another bearer reconcile.
  const before = seen.filter((r) => r.route === '/api/v1/device/state').length;
  socket.frame(1, 1, 'open', { kind: 'perks' });
  socket.frame(1, 2, 'data', { snapshot: { revision: 2 }, presence: [] });
  await until(() => seen.filter((r) => r.route === '/api/v1/device/state').length > before);
  expect(seen.every((r) => r.route !== '/api/v1/device/state' || r.proofValid === undefined)).toBe(true);
  // The cell forgets the device: sign-in required, no redial, credentials dropped.
  socket.lost(4403);
  await until(() => log.mock.calls.some(([event]) => event.event === 'sign_in_required'));
  await sleep(300);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(seen.filter((r) => r.route === '/api/v1/cell-ticket')).toHaveLength(1);
  await runtime.stop();
  expect(socket.readyState).toBe(3);
});

it('announces ssh while the door is enabled, pipes streams into it, forwards the terminal snapshot and reports the door', async () => {
  const log = vi.fn();
  await signIn();
  ensureDeviceKey({ homeDir: home });
  // A loopback echo server stands in for the door.
  const echo = net.createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const doorPort = (echo.address() as net.AddressInfo).port;
  await writePrivate(journalFile(), {
    origin,
    deviceId: DEVICE_ID,
    credentials: {},
    operations: {},
    terminal: { enabled: true, name: 'alice', doorPort, updatedAt: 'x' },
  });
  const applied: unknown[] = [];
  const inner = localDoor({ root });
  const door: Door = {
    ...inner,
    applyTerminalSnapshot: (terminal) => {
      applied.push(terminal);
      inner.applyTerminalSnapshot(terminal);
    },
  };
  const runtime = startPortalRuntime({
    root,
    homeDir: home,
    log,
    intervalMs: 50,
    Socket: FakeSocket,
    door,
    terminalReportMs: 100,
  });
  await until(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0];
  socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({ v: 1, ch: 0, seq: 1, t: 'hello', leg: 'host', caps: ['perks', 'ssh'] });
  // The door's state goes to the service with the first reconcile.
  await until(() => seen.some((r) => r.route === '/api/v1/terminal/host'));
  expect(seen.find((r) => r.route === '/api/v1/terminal/host')).toEqual({
    method: 'PUT',
    route: '/api/v1/terminal/host',
    authorization: 'Bearer tok',
    body: { enabled: true, authorizedFingerprints: [] },
  });
  // The snapshot's terminal section reaches the door, and the next report names its keys.
  const terminal = { enabled: true, keys: [{ fingerprint: 'SHA256:a' }], pending: [], sandboxes: [] };
  socket.frame(1, 1, 'open', { kind: 'perks' });
  socket.frame(1, 2, 'data', { snapshot: { revision: 2, terminal }, presence: [] });
  expect(applied).toEqual([terminal]);
  await sleep(120);
  socket.frame(1, 3, 'data', { snapshot: { revision: 3, terminal }, presence: [] });
  await until(() => seen.filter((r) => r.route === '/api/v1/terminal/host').length >= 2);
  expect(seen.filter((r) => r.route === '/api/v1/terminal/host').at(-1)?.body).toEqual({
    enabled: true,
    authorizedFingerprints: ['SHA256:a'],
  });
  // A stream the cell opens is piped into the door and echoed back, with credit for what the door took.
  const onStream = (): Record<string, unknown>[] =>
    socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((f) => f.ch === 2);
  socket.frame(2, 1, 'open', {
    kind: 'ssh',
    stream: 's1',
    target: { account: 'alice' },
    source: { ip: '::1', port: 1 },
  });
  socket.frame(2, 2, 'data', { off: 0, b64: Buffer.from('hi').toString('base64') });
  await until(() => onStream().some((f) => f.t === 'credit') && onStream().some((f) => f.t === 'data'));
  expect(onStream().find((f) => f.t === 'credit')).toMatchObject({ ack: 2 });
  expect(onStream().find((f) => f.t === 'data')).toMatchObject({ off: 0, b64: Buffer.from('hi').toString('base64') });
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'stream_open', stream: 's1', account: 'alice', deviceId: DEVICE_ID }),
  );
  // Disabling the door restarts the link without the cap; the open stream is torn down and ssh opens are refused.
  expect(await reportTerminalState({ enabled: false, doorPort }, { root, homeDir: home })).toEqual({
    journaled: true,
    reported: true,
  });
  expect(seen.at(-1)?.body).toEqual({ enabled: false, authorizedFingerprints: [] });
  await until(() => FakeSocket.instances.length === 2);
  expect(socket.readyState).toBe(3);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'stream_closed', stream: 's1', by: 'link' }));
  const second = FakeSocket.instances[1];
  second.open();
  expect(JSON.parse(second.sent[0])).toEqual({ v: 1, ch: 0, seq: 1, t: 'hello', leg: 'host', caps: ['perks'] });
  second.frame(2, 1, 'open', {
    kind: 'ssh',
    stream: 's2',
    target: { account: 'alice' },
    source: { ip: '::1', port: 1 },
  });
  expect(JSON.parse(second.sent.at(-1) ?? '{}')).toEqual({ v: 1, ch: 2, seq: 1, t: 'error', code: 'unsupported' });
  const reports = seen.filter((r) => r.route === '/api/v1/terminal/host').length;
  await sleep(150);
  expect(seen.filter((r) => r.route === '/api/v1/terminal/host')).toHaveLength(reports);
  await runtime.stop();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

it('reports sign_in_required and clears local credentials when the portal refuses the device', async () => {
  const log = vi.fn();
  await signIn();
  ensureDeviceKey({ homeDir: home });
  await writePrivate(journalFile(), {
    origin,
    deviceId: DEVICE_ID,
    credentials: { echo: { keyId: 'k', operationId: 'o', secret: 'shh', resource: { label: 'Echo' } } },
    operations: { echo: { grantId: 'g', idempotencyKey: 'i' } },
  });
  ticketStatus = 401;
  const runtime = startPortalRuntime({ root, homeDir: home, log, intervalMs: 50, Socket: FakeSocket });
  await until(() => log.mock.calls.some(([event]) => event.event === 'sign_in_required'));
  await sleep(200);
  const journal = JSON.parse(await readFile(journalFile(), 'utf8')) as { credentials: object; operations: object };
  expect(journal.credentials).toEqual({});
  expect(journal.operations).toEqual({});
  expect(FakeSocket.instances).toEqual([]);
  expect(JSON.stringify(await readFile(journalFile(), 'utf8'))).not.toContain('tok');
  await runtime.stop();
});
