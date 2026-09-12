/**
 * The module against the real composed tree with a placeholder platform:
 * a platform that registered its half and has a managed install gets a
 * session surface registered under its channel type; `sandboxes new` then
 * opens a surface at the (fake) service with the sandbox's terminal address,
 * a freshly bound surface and `remote enable` announce the address on the
 * member row, `sandboxes surface status | archive` reach the service, and a
 * platform without an install — or a service that says unavailable — leaves
 * the sandbox plain. Nothing platform-specific is in play.
 */
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-test-surface-module-${process.pid}`);

vi.mock('../../../container-runner.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../container-runner.js')>();
  return { ...orig, wakeContainer: vi.fn(async (): Promise<boolean> => false) };
});
vi.mock('../../../drivers/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../drivers/index.js')>();
  return { ...orig, getSessionDriver: vi.fn() };
});
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>();
  return { ...actual, DATA_DIR: `${ROOT}/data`, GROUPS_DIR: `${ROOT}/groups` };
});

import { dispatch } from '../../../cli/dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../../../cli/frame.js';
import { fireRemoteAccessChanged } from '../../../code-mode/hooks.js';
import { assertSandboxHook, assertSandboxVerb, assertSurfaceRegistered } from '../../../code-mode/surface/contract.js';
import { insertSessionSurface } from '../../../code-mode/surface/db.js';
import {
  createSessionSurfaceRuntime,
  getSessionSurfaceByGroup,
  setSessionSurfaceRuntime,
} from '../../../code-mode/surface/index.js';
import { resetSessionSurfacesForTesting } from '../../../code-mode/surface/registry.js';
import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import { getMessagingGroupByPlatform } from '../../../db/messaging-groups.js';
import { getSessionDriver } from '../../../drivers/index.js';
import type { SessionEventsDriver } from '../../../drivers/session-events.js';
import '../../../cli/resources/sandboxes.js';
import '../../../code-mode/index.js';
import '../index.js';
import {
  activateSurfaces,
  activeSurfacePlatforms,
  deactivateSurfaces,
  registerSurfacePlatform,
  setSurfaceModuleDeps,
  SURFACE_ADDRESS_HOOK,
} from './index.js';
import { resetSurfacePlatformsForTesting } from './platforms.js';

const HOST: CallerContext = { caller: 'host' };
interface Seen {
  method: string;
  route: string;
  authorization?: string;
  body: unknown;
}
let server: Server;
let origin: string;
let home: string;
const seen: Seen[] = [];
const answers: Record<string, { status: number; body: unknown }> = {};

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text = '';
  for await (const chunk of req) text += chunk;
  const route = new URL(req.url ?? '/', origin).pathname;
  seen.push({
    method: req.method ?? '',
    route,
    authorization: req.headers.authorization,
    body: text ? JSON.parse(text) : undefined,
  });
  const answer = answers[`${req.method} ${route}`] ?? answers[route] ?? { status: 200, body: { ok: true } };
  res.setHeader('content-type', 'application/json');
  res.writeHead(answer.status);
  res.end(JSON.stringify(answer.body));
}

function call(command: string, args: Record<string, unknown> = {}): Promise<ResponseFrame> {
  const req: RequestFrame = { id: `r-${Math.random().toString(36).slice(2, 8)}`, command, args };
  return dispatch(req, HOST);
}
function dataOf<T>(res: ResponseFrame): T {
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.message}`);
  return res.data as T;
}

/** A placeholder platform: spells `chat:<id>`, knows its bot, keeps its own install record. */
function chatPlatform(install: { serviceBase: string; appId: string } | null) {
  return {
    spell: (id: string) => ({ platformId: `chat:${id}`, instance: 'chat' }),
    botIdentity: async () => ({ botUserId: 'U0BOT' }),
    install: async () => (install ? { platform: 'chat', ...install } : null),
  };
}

const door = { enabled: true, name: 'alice', host: 'alice.example.test' };

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'groups'), { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-surface-home-'));
  fs.mkdirSync(path.join(home, '.config/nanoclaw'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(home, '.config/nanoclaw/account.json'),
    JSON.stringify({ version: 1, api: 'https://registry.example.test', account_id: 'acct-1', token: 'tok' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(home, '.config/nanoclaw/host-id'), 'install-1\n', { mode: 0o600 });
  seen.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
  await runMigrations(await initTestDb());
  vi.mocked(getSessionDriver).mockReturnValue({
    kind: 'fake-container',
    listSessions: vi.fn(async () => []),
    watchSessions: () => ({ stop: () => {} }),
  } as unknown as SessionEventsDriver);
  resetSessionSurfacesForTesting();
  resetSurfacePlatformsForTesting();
  setSurfaceModuleDeps({ homeDir: home, doorState: async () => door });
});

afterEach(async () => {
  setSessionSurfaceRuntime(null);
  deactivateSurfaces();
  resetSessionSurfacesForTesting();
  resetSurfacePlatformsForTesting();
  setSurfaceModuleDeps(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('registrations', () => {
  it('registers the address hooks and the surface verbs on the real tree', () => {
    expect(() => assertSandboxHook('bound', SURFACE_ADDRESS_HOOK)).not.toThrow();
    expect(() => assertSandboxHook('remote-access-changed', SURFACE_ADDRESS_HOOK)).not.toThrow();
    expect(() => assertSandboxVerb('surface status')).not.toThrow();
    expect(() => assertSandboxVerb('surface archive')).not.toThrow();
    expect(() => assertSandboxVerb('surface enable')).not.toThrow();
    expect(() => assertSandboxVerb('surface disable')).not.toThrow();
  });

  it('offers a surface only for a platform with a managed install, and hears of a platform registered later', async () => {
    registerSurfacePlatform('chat', chatPlatform({ serviceBase: origin, appId: 'A1' }));
    registerSurfacePlatform('other', chatPlatform(null));
    expect(await activateSurfaces()).toEqual(['chat']);
    expect(() => assertSurfaceRegistered('chat')).not.toThrow();
    expect(() => assertSurfaceRegistered('other')).toThrow(/no session surface/);
    registerSurfacePlatform('late', {
      ...chatPlatform({ serviceBase: origin, appId: 'A2' }),
      channelType: 'late-chat',
    });
    await vi.waitFor(() => expect(activeSurfacePlatforms()).toEqual(['chat', 'late']));
    expect(() => assertSurfaceRegistered('late-chat')).not.toThrow();
  });
});

describe('a sandbox on a host that serves a surface', () => {
  it('opens the surface at the service with its address, wires it, announces on bind and after remote enable, and archives', async () => {
    registerSurfacePlatform('chat', chatPlatform({ serviceBase: origin, appId: 'A1' }));
    await activateSurfaces();
    answers['POST /v1/code-channels'] = {
      status: 201,
      body: { channelId: 'C1', sessionId: 'x', status: 'active', created: true },
    };

    const { id } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't1', 'no-attach': true }));
    const create = seen.find((r) => r.route === '/v1/code-channels');
    expect(create).toEqual({
      method: 'POST',
      route: '/v1/code-channels',
      authorization: 'Bearer tok',
      body: {
        appId: 'A1',
        title: 't1',
        botUserId: 'U0BOT',
        sandboxName: 't1',
        terminalAddress: 't1.alice.example.test',
        sessionId: id,
      },
    });
    const row = (await getSessionSurfaceByGroup(id))!;
    expect(row).toMatchObject({ provider: 'chat', surface_id: 'C1', title: 't1' });
    expect(await getMessagingGroupByPlatform('chat', 'chat:C1', 'chat')).toBeTruthy();
    // The bound hook told the surface the address on the member row.
    await vi.waitFor(() =>
      expect(seen.find((r) => r.route === '/v1/code-channels/C1/members/U0BOT')).toMatchObject({
        method: 'PUT',
        body: { sandboxName: 't1', terminalAddress: 't1.alice.example.test' },
      }),
    );

    // `remote enable` (or a rename) sweeps every open surface.
    const before = seen.filter((r) => r.route === '/v1/code-channels/C1/members/U0BOT').length;
    await fireRemoteAccessChanged({ enabled: true, name: 'alice', host: 'alice.example.test' });
    await vi.waitFor(() =>
      expect(seen.filter((r) => r.route === '/v1/code-channels/C1/members/U0BOT').length).toBe(before + 1),
    );

    answers['GET /v1/code-channels/C1'] = {
      status: 200,
      body: {
        channelId: 'C1',
        sessionId: id,
        status: 'processing',
        members: [{ botUserId: 'U0BOT', role: 'owner', sandboxName: 't1', terminalAddress: 't1.alice.example.test' }],
        views: [{ viewKey: 'diff', type: 'diff' }],
      },
    };
    const status = await call('sandboxes-surface-status', { id: 't1' });
    expect(dataOf<{ status: string; members: unknown[] }>(status)).toMatchObject({
      provider: 'chat',
      surfaceId: 'C1',
      status: 'processing',
      members: [{ id: 'U0BOT', role: 'owner', sandbox: 't1', terminalAddress: 't1.alice.example.test' }],
    });
    expect(status.ok && status.human).toContain('ssh t1.alice.example.test');

    answers['POST /v1/code-channels/C1/archive'] = {
      status: 200,
      body: { channelId: 'C1', sessionId: id, status: 'closed', archived: true, archivedAt: 't' },
    };
    const archived = await call('sandboxes-surface-archive', { id: 't1', summary: 'done' });
    expect(dataOf<{ archived: true }>(archived).archived).toBe(true);
    expect(seen.at(-1)).toMatchObject({ route: '/v1/code-channels/C1/archive', body: { summary: 'done' } });
    expect((await getSessionSurfaceByGroup(id))!.archived_at).toBeTruthy();
  });

  it('leaves the sandbox plain when the service says unavailable, and when no platform has an install', async () => {
    registerSurfacePlatform('chat', chatPlatform({ serviceBase: origin, appId: 'A1' }));
    await activateSurfaces();
    answers['POST /v1/code-channels'] = { status: 409, body: { error: 'code_channels_unavailable', message: 'no' } };
    const { id } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't2', 'no-attach': true }));
    expect(await getSessionSurfaceByGroup(id)).toBeUndefined();
    expect(dataOf<{ surface: null }>(await call('sandboxes-surface-status', { id: 't2' })).surface).toBeNull();

    deactivateSurfaces();
    resetSessionSurfacesForTesting();
    resetSurfacePlatformsForTesting();
    registerSurfacePlatform('chat', chatPlatform(null));
    expect(await activateSurfaces()).toEqual([]);
    const plain = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't3', 'no-attach': true }));
    expect(await getSessionSurfaceByGroup(plain.id)).toBeUndefined();
    expect(seen.filter((r) => r.route === '/v1/code-channels')).toHaveLength(1);
  });
});

describe('a binding restored before this module activates', () => {
  it('waits without a tick or a write, then flows status to the service once the platform registers', async () => {
    // No platform yet: the sandbox is created plain, and the row below is what
    // a previous host process wrote for it.
    const { id } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't5', 'no-attach': true }));
    await insertSessionSurface({
      agent_group_id: id,
      provider: 'chat',
      surface_id: 'C9',
      session_id: id,
      messaging_group_id: null,
      title: 't5',
      last_status: null,
      last_status_at: null,
      stopped_at: null,
      last_turn_seq: 0,
      events_cursor: null,
      archived_at: null,
    });
    const runtime = createSessionSurfaceRuntime({ watchEvents: false });
    setSessionSurfaceRuntime(runtime);
    await runtime.start();
    expect(runtime.isWaiting(id)).toBe(true);
    await runtime.tick();
    expect(seen.filter((r) => r.route.startsWith('/v1/code-channels'))).toHaveLength(0);
    expect((await getSessionSurfaceByGroup(id))!.last_status).toBeNull();

    // The platform's module comes up after the host restored its bindings.
    registerSurfacePlatform('chat', chatPlatform({ serviceBase: origin, appId: 'A1' }));
    expect(await activateSurfaces()).toEqual(['chat']);
    await vi.waitFor(() => expect(runtime.has(id)).toBe(true));
    expect(runtime.isWaiting(id)).toBe(false);
    await runtime.tick();
    const statuses = () => seen.filter((r) => r.route === '/v1/code-channels/C9/status');
    expect(statuses()).toEqual([
      {
        method: 'POST',
        route: '/v1/code-channels/C9/status',
        authorization: 'Bearer tok',
        body: { status: 'suspended' },
      },
    ]);
    expect((await getSessionSurfaceByGroup(id))!.last_status).toBe('suspended');
    // The next tick is coalesced: the same status is not sent twice.
    await runtime.tick();
    expect(statuses()).toHaveLength(1);
    await runtime.stop();
  });
});

describe('sandboxes surface enable | disable', () => {
  it('disable keeps new sandboxes plain and open surfaces mirrored, persists across activation, enable turns it back on', async () => {
    registerSurfacePlatform('chat', chatPlatform({ serviceBase: origin, appId: 'A1' }));
    await activateSurfaces();
    answers['POST /v1/code-channels'] = {
      status: 201,
      body: { channelId: 'C1', sessionId: 'x', status: 'active', created: true },
    };
    const first = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't6', 'no-attach': true }));
    expect((await getSessionSurfaceByGroup(first.id))!.surface_id).toBe('C1');

    const disabled = await call('sandboxes-surface-disable');
    expect(dataOf<{ autoOpen: boolean }>(disabled).autoOpen).toBe(false);
    expect(disabled.ok && disabled.human).toMatch(/no chat surface on this host/);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/session-surface.json'), 'utf8'))).toMatchObject({
      version: 1,
      autoOpen: false,
    });
    const creates = () => seen.filter((r) => r.route === '/v1/code-channels').length;
    const before = creates();
    const plain = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't7', 'no-attach': true }));
    expect(await getSessionSurfaceByGroup(plain.id)).toBeUndefined();
    expect(creates()).toBe(before);
    // The surface opened before stays bound; the setting archives nothing.
    expect((await getSessionSurfaceByGroup(first.id))!.archived_at).toBeNull();

    // A fresh activation (a host restart) reads the same setting.
    deactivateSurfaces();
    resetSessionSurfacesForTesting();
    expect(await activateSurfaces()).toEqual(['chat']);
    const still = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't8', 'no-attach': true }));
    expect(await getSessionSurfaceByGroup(still.id)).toBeUndefined();

    const enabled = await call('sandboxes-surface-enable');
    expect(dataOf<{ autoOpen: boolean }>(enabled).autoOpen).toBe(true);
    answers['POST /v1/code-channels'] = {
      status: 201,
      body: { channelId: 'C2', sessionId: 'y', status: 'active', created: true },
    };
    const again = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't9', 'no-attach': true }));
    expect((await getSessionSurfaceByGroup(again.id))!.surface_id).toBe('C2');
  });
});
