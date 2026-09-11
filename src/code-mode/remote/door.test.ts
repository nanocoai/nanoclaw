import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DoorSummary, MirrorTerminal, TerminalSeam } from '../door/index.js';
import type { KeyStore } from '../door/keys.js';
import { DEVICE_PROOF_HEADER, ensureDeviceKey, verifyDeviceProof, writePrivate } from '../../community-portal/index.js';
import { MIRROR_SKEW_MS, wireDoor, type DoorModule } from './door.js';

/**
 * The seam against a stand-in for the door module and a loopback stand-in
 * for the account service: status mapping, target pass-through, the
 * staleness guard on snapshots, and the three seam calls with and without
 * a checkout that is set up with the service.
 */
let server: Server;
let origin: string;
let root: string;
let home: string;
const seen: { method: string; route: string; authorization?: string; proofValid?: boolean; body: unknown }[] = [];
const answers: Record<string, unknown> = {};

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text = '';
  for await (const chunk of req) text += chunk;
  const route = new URL(req.url ?? '/', origin).pathname;
  const proof = req.headers[DEVICE_PROOF_HEADER];
  seen.push({
    method: req.method ?? '',
    route,
    authorization: req.headers.authorization,
    ...(typeof proof === 'string'
      ? { proofValid: verifyDeviceProof(proof, ensureDeviceKey({ homeDir: home }).publicKeyJwk).valid }
      : {}),
    body: text ? JSON.parse(text) : undefined,
  });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(answers[route] ?? { ok: true }));
}

const journalFile = (): string => path.join(root, 'data/community-portal.json');
async function signIn(): Promise<void> {
  await mkdir(path.join(home, '.config/nanoclaw'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config/nanoclaw/account.json'),
    JSON.stringify({ version: 1, api: 'https://registry.example.test', account_id: 'acct-1', token: 'tok' }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, '.config/nanoclaw/host-id'), 'install-1\n', { mode: 0o600 });
}
async function setUp(): Promise<void> {
  await signIn();
  ensureDeviceKey({ homeDir: home });
  await writePrivate(journalFile(), { origin, deviceId: 'dev_1', credentials: {}, operations: {} });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-door-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-door-home-'));
  seen.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
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

/** A stand-in for the door module: a summary and key store to answer with, and a record of every call. */
function fakeModule(summary: Partial<DoorSummary> = {}, store: Partial<KeyStore> = {}) {
  const calls: string[] = [];
  const mirrors: (MirrorTerminal | undefined)[] = [];
  let seam: Partial<TerminalSeam> = {};
  const module: DoorModule = {
    doorStatus: async () => ({
      enabled: false,
      approvalUrl: 'https://approve.example.test/terminals',
      terminal: { enabled: false, updatedAt: 'x' },
      door: { running: false },
      keys: { approved: 0, browser: 0, pending: 0, rooms: 0 },
      ...summary,
    }),
    listDoorKeys: async () => ({ version: 1, approved: [], pending: [], ...store }),
    registerTarget: (port, entry) => {
      calls.push(`register:${port}:${entry.target.account}:${entry.stream ?? '-'}`);
    },
    unregisterTarget: (port) => {
      calls.push(`unregister:${port}`);
    },
    lookupTarget: (port) => (port === 40001 ? { target: { account: 'alice' }, openedAt: 'then' } : undefined),
    applyTerminalMirror: async (terminal) => {
      mirrors.push(terminal);
      return { approved: [], revoked: [] };
    },
    setTerminalSeam: (partial) => {
      seam = partial;
    },
  };
  return { module, calls, mirrors, seam: () => seam as TerminalSeam };
}

it('maps the door summary and key store to the status the link needs, and passes targets through', async () => {
  const off = fakeModule();
  expect(await wireDoor({ root, homeDir: home, module: off.module }).status()).toEqual({
    enabled: false,
    authorizedFingerprints: [],
  });
  const on = fakeModule(
    { enabled: true, doorPort: 33022, hostKey: 'ssh-ed25519 AAAA' },
    {
      approved: [{ fingerprint: 'SHA256:a', publicKey: 'k', label: 'l', approvedAt: 't' }],
      mirror: { fingerprints: ['SHA256:a', 'SHA256:b'], updatedAt: 't' },
    },
  );
  const door = wireDoor({ root, homeDir: home, module: on.module });
  expect(await door.status()).toEqual({
    enabled: true,
    port: 33022,
    hostKey: 'ssh-ed25519 AAAA',
    authorizedFingerprints: ['SHA256:a', 'SHA256:b'],
  });
  const stale = fakeModule({ enabled: true, terminal: { enabled: true, updatedAt: 'x' } });
  expect((await wireDoor({ root, homeDir: home, module: stale.module }).status()).enabled).toBe(false);
  door.registerTarget(40001, { stream: 's', target: { account: 'alice' }, source: { ip: '::1', port: 1 } });
  expect(door.lookupTarget(40001)).toEqual({ target: { account: 'alice' }, openedAt: 'then' });
  expect(door.lookupTarget(40002)).toBeUndefined();
  door.unregisterTarget(40001);
  expect(on.calls).toEqual(['register:40001:alice:s', 'unregister:40001']);
});

it('forwards the snapshot terminal section to the door, skipping mirrors older than its own enable call', async () => {
  await setUp();
  answers['/api/v1/terminal/enable'] = { name: 'alice', address: '2001:db8::1', host: 'alice.example.test' };
  const fake = fakeModule();
  const log = vi.fn();
  const clock = 1_000_000;
  const door = wireDoor({ root, homeDir: home, log, module: fake.module, now: () => clock });
  const snapshot = (updatedAt: string | undefined, extra: Record<string, unknown> = {}) => ({
    enabled: true,
    name: 'alice',
    keys: [{ fingerprint: 'SHA256:a', keyType: 'ssh-ed25519' }],
    pending: [],
    sandboxes: [],
    ...(updatedAt ? { updatedAt } : {}),
    ...extra,
  });
  // Before any enable every snapshot is applied, as the mirror's shape.
  await door.applyTerminalSnapshot(snapshot(undefined, { previousName: 'old' }));
  await door.applyTerminalSnapshot(undefined);
  expect(fake.mirrors).toEqual([
    { enabled: true, name: 'alice', previousName: 'old', keys: [{ fingerprint: 'SHA256:a' }] },
    undefined,
  ]);
  await fake.seam().enable({ name: 'alice', hostKey: 'ssh-ed25519 AAAA', hostKeyFingerprint: 'SHA256:h' });
  const enabledAt = clock;
  await door.applyTerminalSnapshot(snapshot(new Date(enabledAt - MIRROR_SKEW_MS - 1).toISOString()));
  await door.applyTerminalSnapshot(snapshot(undefined));
  await door.applyTerminalSnapshot(undefined);
  expect(fake.mirrors).toHaveLength(2);
  expect(log).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenLastCalledWith({ event: 'terminal_snapshot_stale' });
  await door.applyTerminalSnapshot(snapshot(new Date(enabledAt - MIRROR_SKEW_MS).toISOString()));
  await door.applyTerminalSnapshot(snapshot(new Date(enabledAt + 5_000).toISOString(), { enabled: false }));
  expect(fake.mirrors.slice(2)).toEqual([
    { enabled: true, name: 'alice', keys: [{ fingerprint: 'SHA256:a' }] },
    { enabled: false, name: 'alice', keys: [{ fingerprint: 'SHA256:a' }] },
  ]);
});

it('answers the door standalone while the checkout is not set up with the account service', async () => {
  const fake = fakeModule();
  const onReported = vi.fn();
  wireDoor({ root, homeDir: home, module: fake.module, onReported });
  const seam = fake.seam();
  await expect(seam.enable({ hostKey: 'k', hostKeyFingerprint: 'f' })).rejects.toThrow(/--name/);
  expect(await seam.enable({ name: 'mine', hostKey: 'k', hostKeyFingerprint: 'f' })).toEqual({ name: 'mine' });
  expect(
    await seam.pending({
      fingerprint: 'SHA256:p',
      keyType: 'ssh-ed25519',
      publicKey: 'ssh-ed25519 AAAA',
      at: '2026-09-11T10:00:00.000Z',
      approvalUrl: 'https://approve.example.test/terminals',
    }),
  ).toEqual({ url: 'https://approve.example.test/terminals', expiresAt: '2026-09-11T10:10:00.000Z' });
  await seam.report({ enabled: true, name: 'mine', doorPort: 33022, authorizedFingerprints: [] });
  expect(onReported).toHaveBeenCalledOnce();
  expect(seen).toEqual([]);
  // Signed in but without a device key: enable still needs a name, but the state and pending keys are reported.
  await signIn();
  await writePrivate(journalFile(), { origin, deviceId: 'dev_1', credentials: {}, operations: {} });
  expect(await seam.enable({ name: 'mine', hostKey: 'k', hostKeyFingerprint: 'f' })).toEqual({ name: 'mine' });
  await seam.report({ enabled: true, name: 'mine', doorPort: 33022, authorizedFingerprints: ['SHA256:a'] });
  expect(seen.map((r) => [r.method, r.route])).toEqual([['PUT', '/api/v1/terminal/host']]);
  expect(seen[0].body).toEqual({ enabled: true, authorizedFingerprints: ['SHA256:a'] });
  expect(onReported).toHaveBeenCalledTimes(2);
});

it('carries enable, report and pending keys to the account service once the checkout is set up', async () => {
  await setUp();
  answers['/api/v1/terminal/enable'] = {
    name: 'alice',
    address: '2001:db8::5:0:0:1',
    host: 'alice.example.test',
    hostKeyFingerprint: 'SHA256:h',
    previousName: 'bob',
  };
  answers['/api/v1/terminal/keys/pending'] = {
    code: 'ABCD-EFGH',
    url: 'https://approve.example.test/?approve=ABCDEFGH',
    expiresAt: '2026-09-11T10:10:00.000Z',
  };
  const fake = fakeModule();
  const onReported = vi.fn();
  wireDoor({ root, homeDir: home, module: fake.module, onReported, now: () => 0 });
  const seam = fake.seam();
  expect(await seam.enable({ hostKey: 'ssh-ed25519 AAAA', hostKeyFingerprint: 'SHA256:h' })).toEqual({
    name: 'alice',
    address: '2001:db8::5:0:0:1',
    host: 'alice.example.test',
    previousName: 'bob',
  });
  expect(seen[0]).toEqual({
    method: 'POST',
    route: '/api/v1/terminal/enable',
    authorization: 'Bearer tok',
    proofValid: true,
    body: { hostKey: 'ssh-ed25519 AAAA' },
  });
  await seam.enable({ name: 'alice', hostKey: 'ssh-ed25519 AAAA', hostKeyFingerprint: 'SHA256:h' });
  expect(seen[1].body).toEqual({ name: 'alice', hostKey: 'ssh-ed25519 AAAA' });
  await seam.report({
    enabled: true,
    name: 'alice',
    hostKeyFingerprint: 'SHA256:h',
    doorPort: 33022,
    authorizedFingerprints: ['SHA256:a'],
  });
  expect(seen[2]).toEqual({
    method: 'PUT',
    route: '/api/v1/terminal/host',
    authorization: 'Bearer tok',
    body: { enabled: true, authorizedFingerprints: ['SHA256:a'] },
  });
  expect(onReported).toHaveBeenCalledOnce();
  const journal = JSON.parse(await readFile(journalFile(), 'utf8')) as { terminal: unknown };
  expect(journal.terminal).toEqual({
    enabled: true,
    name: 'alice',
    hostKeyFingerprint: 'SHA256:h',
    doorPort: 33022,
    updatedAt: '1970-01-01T00:00:00.000Z',
  });
  expect(
    await seam.pending({
      fingerprint: 'SHA256:p',
      keyType: 'ssh-ed25519',
      publicKey: 'ssh-ed25519 BBBB',
      source: { ip: '2001:db8::9', port: 4242 },
      at: '2026-09-11T10:00:00.000Z',
      approvalUrl: 'https://approve.example.test/terminals',
    }),
  ).toEqual({
    code: 'ABCD-EFGH',
    url: 'https://approve.example.test/?approve=ABCDEFGH',
    expiresAt: '2026-09-11T10:10:00.000Z',
  });
  expect(seen[3]).toEqual({
    method: 'POST',
    route: '/api/v1/terminal/keys/pending',
    authorization: 'Bearer tok',
    body: {
      fingerprint: 'SHA256:p',
      keyType: 'ssh-ed25519',
      publicKey: 'ssh-ed25519 BBBB',
      source: { ip: '2001:db8::9', port: 4242 },
      at: '2026-09-11T10:00:00.000Z',
    },
  });
  // A service answer without a page or expiry falls back to the door's own.
  answers['/api/v1/terminal/keys/pending'] = { code: 'ZZZZ-2222' };
  expect(
    await seam.pending({
      fingerprint: 'SHA256:p',
      keyType: 'ssh-ed25519',
      publicKey: 'ssh-ed25519 BBBB',
      at: '2026-09-11T10:00:00.000Z',
      approvalUrl: 'https://approve.example.test/terminals',
    }),
  ).toEqual({
    code: 'ZZZZ-2222',
    url: 'https://approve.example.test/terminals',
    expiresAt: '2026-09-11T10:10:00.000Z',
  });
});
