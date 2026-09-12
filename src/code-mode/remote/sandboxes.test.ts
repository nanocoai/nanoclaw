import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DoorSummary } from '../door/index.js';
import { writePrivate } from '../../community-portal/index.js';
import { registerSandbox, sandboxTerminalAddress, unregisterSandbox } from './sandboxes.js';

/**
 * Sandbox registration against a loopback stand-in for the account service:
 * gated on the door, never throwing, one request per verb.
 */
let server: Server;
let origin: string;
let root: string;
let home: string;
const seen: { method: string; route: string; body: unknown }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text = '';
  for await (const chunk of req) text += chunk;
  seen.push({
    method: req.method ?? '',
    route: new URL(req.url ?? '/', origin).pathname,
    body: text ? JSON.parse(text) : undefined,
  });
  res.setHeader('content-type', 'application/json');
  res.writeHead(answer.status);
  res.end(JSON.stringify(answer.body));
}

const summary =
  (partial: Partial<DoorSummary>): (() => Promise<DoorSummary>) =>
  async () => ({
    enabled: false,
    approvalUrl: 'https://approve.example.test/terminals',
    terminal: { enabled: false, updatedAt: 'x' },
    door: { running: false },
    keys: { approved: 0, browser: 0, pending: 0, rooms: 0 },
    ...partial,
  });
const enabled = summary({ enabled: true, name: 'alice', doorPort: 33022 });

async function setUp(): Promise<void> {
  await mkdir(path.join(home, '.config/nanoclaw'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config/nanoclaw/account.json'),
    JSON.stringify({ version: 1, api: 'https://registry.example.test', account_id: 'acct-1', token: 'tok' }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, '.config/nanoclaw/host-id'), 'install-1\n', { mode: 0o600 });
  await writePrivate(path.join(root, 'data/community-portal.json'), {
    origin,
    deviceId: 'dev_1',
    credentials: {},
    operations: {},
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-sandboxes-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-sandboxes-home-'));
  seen.length = 0;
  answer = { status: 200, body: { ok: true } };
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

it('registers a named sandbox with the account while remote access is enabled, and never the default one', async () => {
  const log = vi.fn();
  answer = { status: 200, body: { name: 'api', address: '2001:db8::5:0:0:2', host: 'api.alice.example.test' } };
  expect(await registerSandbox('api', { root, homeDir: home, log, doorStatus: summary({}) })).toEqual({
    done: false,
    code: 'not_enabled',
  });
  expect(await registerSandbox('api', { root, homeDir: home, log, doorStatus: enabled })).toEqual({
    done: false,
    code: 'installation_required',
  });
  expect(seen).toEqual([]);
  await setUp();
  expect(await registerSandbox('alice', { root, homeDir: home, log, doorStatus: enabled })).toEqual({
    done: false,
    code: 'default_sandbox',
  });
  expect(await registerSandbox('api', { root, homeDir: home, log, doorStatus: enabled })).toEqual({
    done: true,
    address: '2001:db8::5:0:0:2',
    host: 'api.alice.example.test',
  });
  expect(seen).toEqual([{ method: 'POST', route: '/api/v1/terminal/sandboxes', body: { name: 'api' } }]);
  expect(log).toHaveBeenCalledExactlyOnceWith({
    event: 'sandbox_registered',
    sandbox: 'api',
    host: 'api.alice.example.test',
  });
});

it('never throws: a refusal or an unreachable service comes back as a code and a log line', async () => {
  const log = vi.fn();
  await setUp();
  answer = { status: 409, body: { error: 'name_taken' } };
  expect(await registerSandbox('api', { root, homeDir: home, log, doorStatus: enabled })).toEqual({
    done: false,
    code: 'name_taken',
  });
  expect(log).toHaveBeenLastCalledWith({ event: 'sandbox_register_failed', sandbox: 'api', code: 'name_taken' });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const outcome = await registerSandbox('api', { root, homeDir: home, log, doorStatus: enabled });
  expect(outcome.done).toBe(false);
  expect(outcome.code).toBeTruthy();
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

it('frees the address of a deleted sandbox whenever the account ever named this machine', async () => {
  const log = vi.fn();
  await setUp();
  expect(await unregisterSandbox('api', { root, homeDir: home, log, doorStatus: summary({}) })).toEqual({
    done: false,
    code: 'not_enabled',
  });
  expect(await unregisterSandbox('alice', { root, homeDir: home, log, doorStatus: enabled })).toEqual({
    done: false,
    code: 'default_sandbox',
  });
  expect(seen).toEqual([]);
  // Disabled for now, but named: the sandbox is gone, so its address goes too.
  const disabled = summary({ enabled: false, name: 'alice', doorPort: 33022 });
  expect(await unregisterSandbox('api', { root, homeDir: home, log, doorStatus: disabled })).toEqual({ done: true });
  expect(seen).toEqual([{ method: 'DELETE', route: '/api/v1/terminal/sandboxes/api', body: undefined }]);
  expect(log).toHaveBeenCalledWith({ event: 'sandbox_unregistered', sandbox: 'api' });
  answer = { status: 404, body: { error: 'not_found' } };
  expect(await unregisterSandbox('gone', { root, homeDir: home, log, doorStatus: enabled })).toEqual({
    done: false,
    code: 'not_found',
  });
});

it("composes a sandbox's terminal address from the door's name and host name, and nothing without them", () => {
  const door = { enabled: true, name: 'alice', host: 'alice.example.test' };
  expect(sandboxTerminalAddress('api', door)).toEqual({ sandbox: 'api', address: 'api.alice.example.test' });
  // The default sandbox is the account's own address.
  expect(sandboxTerminalAddress('alice', door)).toEqual({ sandbox: 'alice', address: 'alice.example.test' });
  // Lower-cased, as the address space is.
  expect(sandboxTerminalAddress('Api', door)).toEqual({ sandbox: 'api', address: 'api.alice.example.test' });
  // A host name recorded before a rename still yields the current name's address.
  expect(sandboxTerminalAddress('api', { ...door, name: 'bob' })).toEqual({
    sandbox: 'api',
    address: 'api.bob.example.test',
  });
  // Not a DNS label: such a sandbox never got an address.
  expect(sandboxTerminalAddress('my_box', door)).toBeUndefined();
  expect(sandboxTerminalAddress('-api', door)).toBeUndefined();
  // Off, unnamed, or no host name yet (the account has not answered): nothing to report.
  expect(sandboxTerminalAddress('api', { ...door, enabled: false })).toBeUndefined();
  expect(sandboxTerminalAddress('api', { enabled: true, name: 'alice' })).toBeUndefined();
  expect(sandboxTerminalAddress('api', { enabled: true, host: 'alice.example.test' })).toBeUndefined();
  expect(sandboxTerminalAddress('api', { enabled: true, name: 'alice', host: 'alice' })).toBeUndefined();
});
