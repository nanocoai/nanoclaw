/**
 * The surface core through the real dispatch path: with a provider
 * registered, `sandboxes new` opens and wires a surface for the session;
 * with none, the sandbox is plain; `status`, `diff` and `stop` are the
 * terminal's view of the same state either way.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../container-runner.js')>();
  return { ...orig, wakeContainer: vi.fn(async (): Promise<boolean> => false) };
});
vi.mock('../../drivers/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../drivers/index.js')>();
  return { ...orig, getSessionDriver: vi.fn() };
});
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-sandboxes-surface/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-sandboxes-surface/groups',
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-sandboxes-surface';

import { insertSessionSurface } from '../../code-mode/surface/db.js';
import {
  SESSION_SURFACE_SEAM,
  createSessionSurfaceRuntime,
  getSessionSurfaceByGroup,
  registerSessionSurface,
  sandboxWorkspaceDir,
  setSessionSurfaceRuntime,
  type SessionSurfaceProvider,
} from '../../code-mode/surface/index.js';
import { noopSessionSurface, resetSessionSurfacesForTesting } from '../../code-mode/surface/registry.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { findSandboxSessions, updateSession } from '../../db/sessions.js';
import { getSessionDriver } from '../../drivers/index.js';
import type { SessionEventsDriver } from '../../drivers/session-events.js';
import type { SessionHandle } from '../../drivers/types.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../frame.js';
import './sandboxes.js';
import './wirings.js';
import '../../code-mode/index.js';

const HOST: CallerContext = { caller: 'host' };

function call(command: string, args: Record<string, unknown> = {}): Promise<ResponseFrame> {
  const req: RequestFrame = { id: `r-${Math.random().toString(36).slice(2, 8)}`, command, args };
  return dispatch(req, HOST);
}

function dataOf<T>(res: ResponseFrame): T {
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.message}`);
  return res.data as T;
}

function fakeProvider() {
  let n = 0;
  const provider: SessionSurfaceProvider & { opens: string[] } = {
    ...noopSessionSurface,
    opens: [],
    spell: async (surfaceId) => ({ platformId: `chat:${surfaceId}`, instance: 'chat' }),
    open: vi.fn(async (sandbox) => {
      provider.opens.push(sandbox.folder);
      n += 1;
      return { surfaceId: `C${n}`, sessionId: sandbox.id };
    }),
  };
  return provider;
}

function installDriver(handles: SessionHandle[]): void {
  const driver = {
    kind: 'fake-container',
    listSessions: vi.fn(async () => handles.map((handle) => ({ handle, phase: 'running' as const }))),
    watchSessions: () => ({ stop: () => {} }),
  } as unknown as SessionEventsDriver;
  vi.mocked(getSessionDriver).mockReturnValue(driver);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups'), { recursive: true });
  await runMigrations(await initTestDb());
  installDriver([]);
  resetSessionSurfacesForTesting();
});

afterEach(async () => {
  resetSessionSurfacesForTesting();
  setSessionSurfaceRuntime(null);
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('sandboxes new with a session-surface provider', () => {
  it('opens a surface through the provider and wires it into the coding session', async () => {
    const provider = fakeProvider();
    registerSessionSurface('chat', provider, { seam: SESSION_SURFACE_SEAM });
    const res = await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const { id } = dataOf<{ id: string }>(res);
    expect(provider.opens).toEqual(['t1']);

    const row = (await getSessionSurfaceByGroup(id))!;
    expect(row).toMatchObject({ provider: 'chat', surface_id: 'C1', session_id: id, title: 't1' });
    const mg = (await getMessagingGroupByPlatform('chat', 'chat:C1', 'chat'))!;
    expect(row.messaging_group_id).toBe(mg.id);
    expect((await getMessagingGroupAgents(mg.id))[0]).toMatchObject({ agent_group_id: id, session_mode: 'sandbox' });

    const status = dataOf<{ status: string; surface: { provider: string; surfaceId: string } | null }>(
      await call('sandboxes-status', { id: 't1' }),
    );
    expect(status.status).toBe('suspended'); // no container yet
    expect(status.surface).toMatchObject({ provider: 'chat', surfaceId: 'C1' });
  });

  it('with two providers registered the first that answers binds; the second is never asked', async () => {
    const first = fakeProvider();
    const second = fakeProvider();
    registerSessionSurface('chat', first, { seam: SESSION_SURFACE_SEAM });
    registerSessionSurface('other-chat', second, { seam: SESSION_SURFACE_SEAM });
    const { id } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't1', 'no-attach': true }));
    expect(first.opens).toEqual(['t1']);
    expect(second.opens).toEqual([]);
    expect((await getSessionSurfaceByGroup(id))!.provider).toBe('chat');
  });

  it('a provider that passes (null) hands the turn to the next one', async () => {
    const passing = { ...noopSessionSurface, open: vi.fn(async () => null) };
    const second = fakeProvider();
    registerSessionSurface('chat', passing, { seam: SESSION_SURFACE_SEAM });
    registerSessionSurface('other-chat', second, { seam: SESSION_SURFACE_SEAM });
    const { id } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't1', 'no-attach': true }));
    expect(passing.open).toHaveBeenCalledTimes(1);
    expect(second.opens).toEqual(['t1']);
    expect((await getSessionSurfaceByGroup(id))!.provider).toBe('other-chat');
  });

  it('with no provider registered the sandbox is plain, and status says so', async () => {
    const res = await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const { id } = dataOf<{ id: string }>(res);
    expect(await getSessionSurfaceByGroup(id)).toBeUndefined();
    const status = await call('sandboxes-status', { id: 't1' });
    expect(dataOf<{ surface: unknown }>(status).surface).toBeNull();
    expect((status as { human?: string }).human).toContain('surface:  none');
  });

  it('a provider that answers null leaves the sandbox plain — the verb succeeds', async () => {
    registerSessionSurface('chat', { ...noopSessionSurface }, { seam: SESSION_SURFACE_SEAM });
    const res = await call('sandboxes-new', { name: 't1', 'no-attach': true });
    expect(res.ok).toBe(true);
    expect(await getSessionSurfaceByGroup(dataOf<{ id: string }>(res).id)).toBeUndefined();
  });
});

describe("session mode 'sandbox' on the wirings resource", () => {
  it('is refused for a chat group and accepted for a sandbox, on create and on update', async () => {
    const { id: sandboxId } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't1', 'no-attach': true }));
    await createAgentGroup({
      id: 'ag-chat',
      name: 'chat',
      folder: 'chat',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig('ag-chat');
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'chat',
      platform_id: 'chat:X',
      instance: 'chat',
      name: 'x',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    const refused = await call('wirings-create', {
      'messaging-group-id': 'mg-1',
      'agent-group-id': 'ag-chat',
      'session-mode': 'sandbox',
    });
    expect(refused.ok).toBe(false);
    expect((refused as { error: { message: string } }).error.message).toContain('needs a code-mode group');

    const shared = dataOf<{ id: string }>(
      await call('wirings-create', { 'messaging-group-id': 'mg-1', 'agent-group-id': 'ag-chat' }),
    );
    const flipped = await call('wirings-update', { id: shared.id, 'session-mode': 'sandbox' });
    expect(flipped.ok).toBe(false);

    const ok = await call('wirings-create', {
      'messaging-group-id': 'mg-1',
      'agent-group-id': sandboxId,
      'session-mode': 'sandbox',
    });
    expect(ok.ok).toBe(true);
  });
});

describe('a binding restored before its provider registers', () => {
  it('waits in the runtime, is marked not mirrored, and goes live the moment the provider registers', async () => {
    const { id } = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't1', 'no-attach': true }));
    // The row a previous host process wrote for a platform whose module has not activated yet.
    await insertSessionSurface({
      agent_group_id: id,
      provider: 'chat',
      surface_id: 'C9',
      session_id: id,
      messaging_group_id: null,
      title: 't1',
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
    expect(runtime.has(id)).toBe(false);
    expect(runtime.isWaiting(id)).toBe(true);
    await runtime.tick();
    expect((await getSessionSurfaceByGroup(id))!.last_status).toBeNull();
    let status = dataOf<{ surface: { mirrored: boolean } }>(await call('sandboxes-status', { id: 't1' }));
    expect(status.surface.mirrored).toBe(false);

    const provider = { ...fakeProvider(), status: vi.fn(async () => {}) };
    registerSessionSurface('chat', provider, { seam: SESSION_SURFACE_SEAM });
    for (let i = 0; i < 20 && !runtime.has(id); i++) await new Promise((r) => setImmediate(r));
    expect(runtime.has(id)).toBe(true);
    await runtime.tick();
    expect(provider.status).toHaveBeenCalledWith({ surfaceId: 'C9', sessionId: id }, 'suspended', {});
    expect((await getSessionSurfaceByGroup(id))!.last_status).toBe('suspended');
    status = dataOf<{ surface: { mirrored: boolean } }>(await call('sandboxes-status', { id: 't1' }));
    expect(status.surface.mirrored).toBe(true);
    await runtime.stop();
  });
});

describe('sandboxes status | diff | stop', () => {
  it('status reads the running container and the turn stamp', async () => {
    await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const group = (await getAgentGroupByFolder('t1'))!;
    const session = (await findSandboxSessions(group.id))[0];
    await updateSession(session.id, { container_status: 'running' });
    const dir = (await sandboxWorkspaceDir(group.id))!;
    fs.mkdirSync(path.join(path.dirname(dir), 'code-turns'), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(dir), 'code-turns', 'state.json'),
      JSON.stringify({ state: 'busy', seq: 3, at: '2026-09-11T10:00:00.000Z' }),
    );
    const status = dataOf<{ status: string; running: boolean; turn: { seq: number } }>(
      await call('sandboxes-status', { id: 't1' }),
    );
    expect(status).toMatchObject({ status: 'processing', running: true, turn: { seq: 3 } });
  });

  it('diff is read inside the running session, says when the session is cold, and when the tree is no repository', async () => {
    await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const group = (await getAgentGroupByFolder('t1'))!;
    const session = (await findSandboxSessions(group.id))[0];
    const dir = (await sandboxWorkspaceDir(group.id))!;
    fs.mkdirSync(dir, { recursive: true });

    // Cold: no container, no diff — the host does not read the tree itself.
    const cold = await call('sandboxes-diff', { id: 't1' });
    expect(dataOf<{ running: boolean; repository: boolean }>(cold)).toMatchObject({
      running: false,
      repository: false,
    });
    expect((cold as { human?: string }).human).toContain('not running');

    // Live: the exec the driver composes runs git in the session; here the
    // command runs on this machine with the workspace dir standing in for
    // the container's /workspace/group.
    const execs: string[][] = [];
    installDriver([
      {
        key: { installSlug: 'test-install', agentGroupId: group.id, sessionId: session.id },
        name: `ncl-${session.id}`,
        start: async () => {},
        status: async () => ({ phase: 'running' }),
        stop: async () => {},
        execSpec: (command: string[]) => {
          execs.push(command);
          const local = command.slice(1).map((a) => a.split('/workspace/group').join(dir));
          return { bin: command[0], argsTty: local, argsPlain: local };
        },
      },
    ]);
    const before = await call('sandboxes-diff', { id: 't1' });
    expect(dataOf<{ running: boolean; repository: boolean }>(before)).toMatchObject({
      running: true,
      repository: false,
    });
    expect((before as { human?: string }).human).toContain('not a git repository');
    expect(execs[0].slice(0, 3)).toEqual(['git', '-C', '/workspace/group']);

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      HOME: dir,
    };
    execFileSync('git', ['-C', dir, 'init', '-q'], { env });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const after = dataOf<{ running: boolean; repository: boolean; content: string }>(
      await call('sandboxes-diff', { id: 't1' }),
    );
    expect(after).toMatchObject({ running: true, repository: true });
    expect(after.content).toContain('+hello');
    expect(execs.every((c) => c[0] === 'git' || c[0] === 'sh')).toBe(true);
  });

  it('stop presses Escape in a live session through the driver, and reports when there is none', async () => {
    await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const cold = dataOf<{ interrupted: boolean }>(await call('sandboxes-stop', { id: 't1' }));
    expect(cold.interrupted).toBe(false);

    const group = (await getAgentGroupByFolder('t1'))!;
    const session = (await findSandboxSessions(group.id))[0];
    const execs: string[][] = [];
    installDriver([
      {
        key: { installSlug: 'test-install', agentGroupId: group.id, sessionId: session.id },
        name: `ncl-${session.id}`,
        start: async () => {},
        status: async () => ({ phase: 'running' }),
        stop: async () => {},
        execSpec: (command: string[]) => {
          execs.push(command);
          // `true` with the command as arguments: the exec is observed, not run.
          return { bin: 'true', argsTty: command, argsPlain: command };
        },
      },
    ]);
    const live = dataOf<{ interrupted: boolean }>(await call('sandboxes-stop', { id: 't1' }));
    expect(live.interrupted).toBe(true);
    expect(execs).toEqual([['tmux', '-S', '/tmp/code-runner/tmux.sock', 'send-keys', '-t', 'agent', 'Escape']]);
  });
});
