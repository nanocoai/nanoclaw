/**
 * `ncl sandboxes new/list/attach` through the real dispatch path — the ssh
 * door's lifecycle verbs (sandbox-spec D13, D14, D20, D22).
 *
 * All three verbs are hostOnly: every door interaction is host-mediated, so
 * an agent caller must be refused before any handler runs. `new` must set
 * code_mode BEFORE the first spawn (runner selection happens only at spawn),
 * create the door session (system:door — attachable yet invisible to chat
 * routing), and hand back the driver-composed exec spec verbatim.
 *
 * Mocks GROUPS_DIR/DATA_DIR (the create path writes a real workspace —
 * groups-create-folder-reuse.test.ts precedent) plus the session driver and
 * wakeContainer (groups-attach.test.ts precedent).
 */
import fs from 'fs';
import path from 'path';
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
    DATA_DIR: '/tmp/nanoclaw-test-sandboxes/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-sandboxes/groups',
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-sandboxes';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

import { wakeContainer } from '../../container-runner.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig, ensureContainerConfig } from '../../db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { DOOR_SYSTEM_THREAD_ID, findDoorSessions, findSessionByAgentGroup } from '../../db/sessions.js';
import { getSessionDriver } from '../../drivers/index.js';
import type { SessionEventsDriver } from '../../drivers/session-events.js';
import type { SessionHandle, SessionPhase, SessionStatus } from '../../drivers/types.js';
import type { Session } from '../../types.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../frame.js';
// Side-effect imports: register the sandboxes-* commands and the code-mode
// migrations (the code_mode / permission_mode columns the verbs write).
import './sandboxes.js';
import '../../code-mode/index.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 's1',
  agentGroupId: 'g-agent',
  messagingGroupId: 'mg1',
};

const CLIENT_TAIL = '/app/src/code-runner/attach-client.ts';

function call(command: string, args: Record<string, unknown> = {}, ctx: CallerContext = HOST): Promise<ResponseFrame> {
  const req: RequestFrame = { id: `r-${Math.random().toString(36).slice(2, 8)}`, command, args };
  return dispatch(req, ctx);
}

function errMsg(res: ResponseFrame): string {
  if (res.ok) throw new Error('expected an error response');
  return res.error.message;
}

function dataOf<T>(res: ResponseFrame): T {
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.message}`);
  return res.data as T;
}

/** A pod-shaped handle: the exec dialect only the driver knows (D22). */
function handleFor(agentGroupId: string, sessionId: string, name: string): SessionHandle {
  return {
    key: { installSlug: 'test-install', agentGroupId, sessionId },
    name,
    start: async () => {},
    status: async () => ({ phase: 'running' }) as SessionStatus,
    stop: async () => {},
    execSpec: (command: string[]) => ({
      bin: 'kubectl',
      argsTty: ['exec', '-i', '-t', '-n', 'agents', name, '-c', 'agent', '--', ...command],
      argsPlain: ['exec', '-i', '-n', 'agents', name, '-c', 'agent', '--', ...command],
    }),
  };
}

/** Discovery reports the phase the listing itself observed — no per-handle probe. */
function installDriver(handles: SessionHandle[], phase: SessionPhase = 'running'): void {
  const driver = {
    kind: 'fake-pod',
    listSessions: vi.fn(async () => handles.map((handle) => ({ handle, phase }))),
    watchSessions: () => ({ stop: () => {} }),
  } as unknown as SessionEventsDriver;
  vi.mocked(getSessionDriver).mockReturnValue(driver);
}

/** Wake succeeds and the woken session's pod appears in driver discovery. */
function wakeBringsPodUp(): void {
  vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
    installDriver([handleFor(session.agent_group_id, session.id, `ncl-${session.id}`)]);
    return true;
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  installDriver([]);
  vi.mocked(wakeContainer).mockReset();
  vi.mocked(wakeContainer).mockResolvedValue(false);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('sandboxes — operator-only surface (D20)', () => {
  it('refuses every verb for an agent caller before the handler runs', async () => {
    for (const command of ['sandboxes-new', 'sandboxes-list', 'sandboxes-attach']) {
      const res = await call(command, { id: 'x' }, AGENT);
      expect(res.ok).toBe(false);
      expect(errMsg(res)).toMatch(/operator-only/);
    }
  });
});

describe('sandboxes new', () => {
  it('creates a code-mode group with the flag set BEFORE the first spawn, and lands attached', async () => {
    let codeModeAtWake: number | null | undefined;
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      // D22: spawn reads code_mode — it must already be 1 when the first wake happens.
      codeModeAtWake = (await getContainerConfig(session.agent_group_id))?.code_mode;
      installDriver([handleFor(session.agent_group_id, session.id, `ncl-${session.id}`)]);
      return true;
    });

    const res = await call('sandboxes-new', { name: 't1' });
    expect(res.ok).toBe(true);
    const data = dataOf<{ attachExec: { bin: string; argsTty: string[] }; group: string; containerName: string }>(res);

    expect(codeModeAtWake).toBe(1);
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);

    // The argv is the driver handle's, with the door-activity stamp riding in
    // front of the frozen client tail (liveness v2 — groups-attach.test.ts
    // pins the stamp's exact shape).
    expect(data.attachExec.bin).toBe('kubectl');
    expect(data.attachExec.argsTty.slice(-2)).toEqual(['bun', CLIENT_TAIL]);
    expect(data.group).toBe('t1');

    // The full creation machinery ran: DB row, workspace folder, config row.
    const group = (await getAgentGroupByFolder('t1'))!;
    expect(group).toBeDefined();
    expect(fs.existsSync(path.join(GROUPS_DIR, 't1'))).toBe(true);
    expect((await getContainerConfig(group.id))?.code_mode).toBe(1);

    // The wake target is the door session.
    const doorSessions = await findDoorSessions(group.id);
    expect(doorSessions).toHaveLength(1);
    expect(doorSessions[0].thread_id).toBe(DOOR_SYSTEM_THREAD_ID);
    expect(vi.mocked(wakeContainer).mock.calls[0][0].id).toBe(doorSessions[0].id);
  });

  it('door session is attachable yet invisible to chat routing', async () => {
    wakeBringsPodUp();
    const res = await call('sandboxes-new', { name: 't1' });
    expect(res.ok).toBe(true);
    const group = (await getAgentGroupByFolder('t1'))!;
    // resolveSession's agent-shared mode must keep seeing no session at all.
    expect(await findSessionByAgentGroup(group.id)).toBeUndefined();
  });

  it('--no-attach creates without waking anything and hands back the attach hint', async () => {
    const res = await call('sandboxes-new', { name: 't1', 'no-attach': true });
    expect(res.ok).toBe(true);
    const data = dataOf<{ sandbox: string; id: string; sessionId: string; attach: string }>(res);
    expect(data.sandbox).toBe('t1');
    expect(data.attach).toBe('ncl sandboxes attach t1');
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
    expect(await findDoorSessions(data.id)).toHaveLength(1);
    expect((await getContainerConfig(data.id))?.code_mode).toBe(1);
  });

  it('applies --permission-mode and --timezone at creation; validates both', async () => {
    const res = await call('sandboxes-new', {
      name: 't1',
      'no-attach': true,
      'permission-mode': 'bypass',
      timezone: 'Europe/Lisbon',
    });
    expect(res.ok).toBe(true);
    const cfg = (await getContainerConfig(dataOf<{ id: string }>(res).id))!;
    expect(cfg.permission_mode).toBe('bypass');
    expect(cfg.timezone).toBe('Europe/Lisbon');

    const badMode = await call('sandboxes-new', { 'no-attach': true, 'permission-mode': 'yolo' });
    expect(errMsg(badMode)).toContain('--permission-mode must be auto or bypass');
    const badTz = await call('sandboxes-new', { 'no-attach': true, timezone: 'Mars/Olympus' });
    expect(errMsg(badTz)).toContain('not an IANA timezone id');
  });

  it('validates the name against the folder grammar AND the k8s label bound', async () => {
    for (const bad of ['has/slash', 'global', 'a'.repeat(64), 'ends_']) {
      const res = await call('sandboxes-new', { name: bad, 'no-attach': true });
      expect(res.ok).toBe(false);
      expect(errMsg(res)).toContain('invalid sandbox name');
    }
    // 63 chars, alphanumeric both ends: legal in both grammars.
    const ok = await call('sandboxes-new', { name: 'a'.repeat(63), 'no-attach': true });
    expect(ok.ok).toBe(true);
  });

  it('generates suffix-deduped names when --name is omitted', async () => {
    const first = await call('sandboxes-new', { 'no-attach': true });
    expect(dataOf<{ sandbox: string }>(first).sandbox).toBe('sandbox');
    const second = await call('sandboxes-new', { 'no-attach': true });
    expect(dataOf<{ sandbox: string }>(second).sandbox).toBe('sandbox-2');
    // On-disk residue (no DB row) also blocks a generated name.
    fs.mkdirSync(path.join(GROUPS_DIR, 'sandbox-3'));
    const third = await call('sandboxes-new', { 'no-attach': true });
    expect(dataOf<{ sandbox: string }>(third).sandbox).toBe('sandbox-4');
  });

  it('takes the positional as the name via the dispatch trim (`ncl sandboxes new t1`)', async () => {
    // The client joins positionals: `ncl sandboxes new t1` → 'sandboxes-new-t1'
    // → dispatch fallback → 'sandboxes-new' + id 't1'. The door's most natural
    // spelling must create THAT name, never a generated one.
    const res = await call('sandboxes-new-t1', { 'no-attach': true });
    expect(res.ok).toBe(true);
    expect(dataOf<{ sandbox: string }>(res).sandbox).toBe('t1');
    expect(await getAgentGroupByFolder('t1')).toBeDefined();
    expect(await getAgentGroupByFolder('sandbox')).toBeUndefined();

    // And the positional path hits the same collision refusal.
    const again = await call('sandboxes-new-t1', { 'no-attach': true });
    expect(again.ok).toBe(false);
    expect(errMsg(again)).toContain("sandbox 't1' already exists");

    // A positional name is validated like --name.
    const bad = await call('sandboxes-new', { id: 'ends_', 'no-attach': true });
    expect(errMsg(bad)).toContain('invalid sandbox name');
  });

  it('refuses conflicting positional and --name spellings', async () => {
    const res = await call('sandboxes-new-t1', { name: 't2', 'no-attach': true });
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toContain('conflicting sandbox names');
    expect(await getAgentGroupByFolder('t1')).toBeUndefined();
    expect(await getAgentGroupByFolder('t2')).toBeUndefined();
    // Agreeing spellings are fine.
    const ok = await call('sandboxes-new-t1', { name: 't1', 'no-attach': true });
    expect(ok.ok).toBe(true);
  });

  it('refuses an existing sandbox name with the attach hint — never idempotent-returns', async () => {
    const first = await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const firstId = dataOf<{ id: string }>(first).id;

    const res = await call('sandboxes-new', { name: 't1', 'no-attach': true });
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toContain("sandbox 't1' already exists");
    expect(errMsg(res)).toContain('ncl sandboxes attach t1');
    // Nothing was minted over the existing group.
    expect((await getAgentGroupByFolder('t1'))!.id).toBe(firstId);
  });

  it('refuses on-disk residue with no claiming DB row (folder-reuse refusal, A4)', async () => {
    fs.mkdirSync(path.join(GROUPS_DIR, 'recycled'));
    fs.writeFileSync(path.join(GROUPS_DIR, 'recycled', 'memory.md'), 'old group memory\n');

    const res = await call('sandboxes-new', { name: 'recycled', 'no-attach': true });
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toContain('already exists on disk');
    expect(await getDb().get('SELECT * FROM agent_groups WHERE folder = ?', 'recycled')).toBeUndefined();
    expect(fs.readFileSync(path.join(GROUPS_DIR, 'recycled', 'memory.md'), 'utf8')).toBe('old group memory\n');
  });
});

describe('sandboxes list', () => {
  it('lists exactly the code-mode groups — a chat-only group is not a sandbox', async () => {
    await call('sandboxes-new', { name: 't1', 'no-attach': true });
    // A plain (non-code-mode) group.
    await getDb().run(
      'INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)',
      'g-chat',
      'Chat',
      'chat-folder',
      new Date().toISOString(),
    );
    await ensureContainerConfig('g-chat');

    const res = await call('sandboxes-list');
    const rows = dataOf<{ sandbox: string; status: string; sessions: number }[]>(res);
    expect(rows.map((r) => r.sandbox)).toEqual(['t1']);
    expect(rows[0].sessions).toBe(1); // the door session
  });

  it('shows cold after the lease reaped the pod, running while the runtime lives (D14 visibility)', async () => {
    await call('sandboxes-new', { name: 't1', 'no-attach': true });
    const group = (await getAgentGroupByFolder('t1'))!;
    const door = (await findDoorSessions(group.id))[0];

    // No live runtime → cold. The group and workspace are still listed:
    // durable identity, disposable pod.
    let rows = dataOf<{ sandbox: string; status: string }[]>(await call('sandboxes-list'));
    expect(rows).toEqual([expect.objectContaining({ sandbox: 't1', status: 'cold' })]);

    // A live runtime for the door session → running.
    installDriver([handleFor(group.id, door.id, `ncl-${door.id}`)]);
    rows = dataOf<{ sandbox: string; status: string }[]>(await call('sandboxes-list'));
    expect(rows).toEqual([expect.objectContaining({ sandbox: 't1', status: 'running' })]);
  });
});

describe('sandboxes attach', () => {
  it('resolves by name via the dispatch trailing-positional trim (`ncl sandboxes attach t1`)', async () => {
    wakeBringsPodUp();
    await call('sandboxes-new', { name: 't1', 'no-attach': true });

    // The client joins positionals: `ncl sandboxes attach t1` → 'sandboxes-attach-t1'.
    const res = await call('sandboxes-attach-t1');
    expect(res.ok).toBe(true);
    const data = dataOf<{ attachExec: { bin: string; argsTty: string[] }; containerName: string }>(res);
    expect(data.attachExec.argsTty.slice(-2)).toEqual(['bun', CLIENT_TAIL]);
    expect(data.containerName).toBe(`ncl-${(await findDoorSessions((await getAgentGroupByFolder('t1'))!.id))[0].id}`);
  });

  it('D13: a cold sandbox is woken lazily on attach', async () => {
    await call('sandboxes-new', { name: 't1', 'no-attach': true });
    wakeBringsPodUp();

    const res = await call('sandboxes-attach', { id: 't1' });
    expect(res.ok).toBe(true);
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('points an unknown name at `new`', async () => {
    const res = await call('sandboxes-attach', { id: 'nope' });
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toContain("no sandbox 'nope'");
    expect(errMsg(res)).toContain('ncl sandboxes new --name nope');
  });
});
