import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DEVICE_PROOF_HEADER,
  ensureDeviceKey,
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
  for await (const _chunk of req) {
    /* drain */
  }
  const route = new URL(req.url ?? '/', origin).pathname;
  const record: Seen = { method: req.method ?? '', route, authorization: req.headers.authorization };
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
