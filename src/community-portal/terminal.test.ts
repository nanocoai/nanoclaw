import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writePrivate } from './private-file.js';
import { journalTerminalOf, reportTerminalState, terminalReportOf, terminalSnapshotOf } from './terminal.js';

it('parses the terminal section of a snapshot and drops what is off-contract', () => {
  expect(terminalSnapshotOf(undefined)).toBeUndefined();
  expect(terminalSnapshotOf({ revision: 3 })).toBeUndefined();
  expect(terminalSnapshotOf({ terminal: 'on' })).toBeUndefined();
  expect(terminalSnapshotOf({ terminal: {} })).toEqual({ enabled: false, keys: [], pending: [], sandboxes: [] });
  expect(
    terminalSnapshotOf({
      terminal: {
        enabled: true,
        name: 'alice',
        address: '2001:db8::5:0:0:1',
        deviceId: 'dev_1',
        hostKeyFingerprint: 'SHA256:host',
        updatedAt: '2026-09-11T10:00:00Z',
        keys: [
          {
            fingerprint: 'SHA256:a',
            keyType: 'ssh-ed25519',
            label: 'laptop',
            approvedAt: 't1',
            installedAt: 't2',
            source: { ip: '2001:db8::1', port: 5 },
            publicKey: 'never',
          },
          { keyType: 'ssh-ed25519' },
          'junk',
        ],
        pending: [
          {
            fingerprint: 'SHA256:p',
            keyType: 'ssh-rsa',
            code: 'ABCD-EFGH',
            source: { ip: '::2', port: 7 },
            at: 't3',
            expiresAt: 't4',
          },
          { fingerprint: 9 },
        ],
        sandboxes: [{ name: 'api', address: '2001:db8::5:0:0:2', createdAt: 't5' }, { address: 'x' }],
      },
    }),
  ).toEqual({
    enabled: true,
    name: 'alice',
    address: '2001:db8::5:0:0:1',
    deviceId: 'dev_1',
    hostKeyFingerprint: 'SHA256:host',
    updatedAt: '2026-09-11T10:00:00Z',
    keys: [
      {
        fingerprint: 'SHA256:a',
        keyType: 'ssh-ed25519',
        label: 'laptop',
        approvedAt: 't1',
        installedAt: 't2',
        source: { ip: '2001:db8::1' },
      },
    ],
    pending: [
      {
        fingerprint: 'SHA256:p',
        keyType: 'ssh-rsa',
        code: 'ABCD-EFGH',
        source: { ip: '::2', port: 7 },
        at: 't3',
        expiresAt: 't4',
      },
    ],
    sandboxes: [{ name: 'api', address: '2001:db8::5:0:0:2', createdAt: 't5' }],
  });
});

it('shapes the report and the journal entry from the door state', () => {
  const state = {
    enabled: true,
    name: 'alice',
    hostKey: 'ssh-ed25519 AAAA',
    hostKeyFingerprint: 'SHA256:h',
    doorPort: 33022,
  };
  expect(terminalReportOf(state)).toEqual({ enabled: true, hostKey: 'ssh-ed25519 AAAA', authorizedFingerprints: [] });
  expect(terminalReportOf({ ...state, authorizedFingerprints: ['SHA256:a'] }).authorizedFingerprints).toEqual([
    'SHA256:a',
  ]);
  expect(terminalReportOf({ enabled: false })).toEqual({ enabled: false, authorizedFingerprints: [] });
  expect(journalTerminalOf(state, () => 0)).toEqual({
    enabled: true,
    name: 'alice',
    hostKeyFingerprint: 'SHA256:h',
    doorPort: 33022,
    updatedAt: '1970-01-01T00:00:00.000Z',
  });
  expect(journalTerminalOf({ enabled: false }, () => 0)).toEqual({
    enabled: false,
    updatedAt: '1970-01-01T00:00:00.000Z',
  });
});

let server: Server;
let origin: string;
let root: string;
let home: string;
let status = 200;
const seen: { method: string; route: string; authorization?: string; body: unknown }[] = [];

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text = '';
  for await (const chunk of req) text += chunk;
  seen.push({
    method: req.method ?? '',
    route: new URL(req.url ?? '/', origin).pathname,
    authorization: req.headers.authorization,
    body: text ? JSON.parse(text) : undefined,
  });
  res.setHeader('content-type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(status === 200 ? { ok: true } : { error: 'unavailable' }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-terminal-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-terminal-home-'));
  seen.length = 0;
  status = 200;
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

const journalFile = (): string => path.join(root, 'data/community-portal.json');
const journal = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(journalFile(), 'utf8'));

async function signIn(): Promise<void> {
  await mkdir(path.join(home, '.config/nanoclaw'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config/nanoclaw/account.json'),
    JSON.stringify({ version: 1, api: 'https://registry.example.test', account_id: 'acct-1', token: 'tok' }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, '.config/nanoclaw/host-id'), 'install-1\n', { mode: 0o600 });
}

it('journals the door state and reports it over the bearer route', async () => {
  await signIn();
  await writePrivate(journalFile(), { origin, deviceId: 'dev_1', credentials: {}, operations: {} });
  const log = vi.fn();
  const state = {
    enabled: true,
    name: 'alice',
    hostKey: 'ssh-ed25519 AAAA',
    hostKeyFingerprint: 'SHA256:h',
    doorPort: 33022,
    authorizedFingerprints: ['SHA256:a'],
  };
  expect(await reportTerminalState(state, { root, homeDir: home, log, now: () => 0 })).toEqual({
    journaled: true,
    reported: true,
  });
  expect(seen).toEqual([
    {
      method: 'PUT',
      route: '/api/v1/terminal/host',
      authorization: 'Bearer tok',
      body: { enabled: true, hostKey: 'ssh-ed25519 AAAA', authorizedFingerprints: ['SHA256:a'] },
    },
  ]);
  expect((await journal()).terminal).toEqual({
    enabled: true,
    name: 'alice',
    hostKeyFingerprint: 'SHA256:h',
    doorPort: 33022,
    updatedAt: '1970-01-01T00:00:00.000Z',
  });
  expect(JSON.stringify(await journal())).not.toContain('AAAA');
  // Disable: the journal keeps the port for the next enable; the service hears enabled false.
  expect(
    await reportTerminalState({ enabled: false, doorPort: 33022 }, { root, homeDir: home, now: () => 1000 }),
  ).toEqual({ journaled: true, reported: true });
  expect(seen.at(-1)?.body).toEqual({ enabled: false, authorizedFingerprints: [] });
  expect((await journal()).terminal).toEqual({
    enabled: false,
    doorPort: 33022,
    updatedAt: '1970-01-01T00:00:01.000Z',
  });
  expect(log).not.toHaveBeenCalled();
});

it('comes back with a code instead of throwing when the checkout is not set up, signed out, or the service fails', async () => {
  const log = vi.fn();
  expect(await reportTerminalState({ enabled: true, doorPort: 1 }, { root, homeDir: home, log })).toEqual({
    journaled: false,
    reported: false,
    code: 'installation_required',
  });
  await writePrivate(journalFile(), { origin, deviceId: 'dev_1', credentials: {}, operations: {} });
  expect(await reportTerminalState({ enabled: true, doorPort: 1 }, { root, homeDir: home, log })).toEqual({
    journaled: true,
    reported: false,
    code: 'installation_required',
  });
  expect((await journal()).terminal).toMatchObject({ enabled: true, doorPort: 1 });
  expect(seen).toEqual([]);
  await signIn();
  status = 503;
  expect(await reportTerminalState({ enabled: true, doorPort: 2 }, { root, homeDir: home, log })).toEqual({
    journaled: true,
    reported: false,
    code: 'unavailable',
  });
  expect((await journal()).terminal).toMatchObject({ enabled: true, doorPort: 2 });
  expect(log).toHaveBeenCalledWith({ event: 'terminal_report_failed', code: 'unavailable' });
});
