/**
 * `ncl groups attach` through the real dispatch path (sandbox-spec D13, D20, D22).
 *
 * The verb is hostOnly — every attach is host-mediated, so an agent caller
 * must be refused before the handler runs. The handler resolves the live
 * runtime THROUGH THE SESSION DRIVER (the host's in-memory container name is
 * a lineage label, not the runtime name) and returns the exec spec the
 * driver's handle composed — the ncl client owns the terminal and performs
 * the exec, so the handler's contract IS the returned argv.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../container-runner.js')>();
  return { ...orig, wakeContainer: vi.fn(async (): Promise<boolean> => false) };
});
vi.mock('../../drivers/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../drivers/index.js')>();
  return { ...orig, getSessionDriver: vi.fn() };
});

import { wakeContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { findSessionByAgentGroup, taskThreadId } from '../../db/sessions.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getSessionDriver } from '../../drivers/index.js';
import type { SessionEventsDriver } from '../../drivers/session-events.js';
import type { SessionHandle, SessionPhase, SessionStatus } from '../../drivers/types.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../frame.js';
// Side-effect imports: register the groups-* commands and the code-mode
// migration (the code_mode column this verb reads).
import './groups.js';
import '../../code-mode/index.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 's1',
  agentGroupId: 'g-code',
  messagingGroupId: 'mg1',
};

const GROUP_ID = 'g-code';
const FOLDER = 'code-folder';
const CLIENT_TAIL = '/app/src/code-runner/attach-client.ts';
/** The door-activity stamp every door-routed exec carries (liveness v2). */
const DOOR_STAMP = [
  'sh',
  '-c',
  '{ mkdir -p /tmp/code-runner && date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/code-runner/door-activity; } 2>/dev/null; exec "$@"',
  'door',
];

function attach(target: string, ctx: CallerContext = HOST): Promise<ResponseFrame> {
  const req: RequestFrame = { id: 'r1', command: 'groups-attach', args: { id: target } };
  return dispatch(req, ctx);
}

function errMsg(res: ResponseFrame): string {
  if (res.ok) throw new Error('expected an error response');
  return res.error.message;
}

/** A pod-shaped handle: the exec dialect only the driver knows (D22). */
function handleFor(sessionId: string, name: string): SessionHandle {
  return {
    key: { installSlug: 'test-install', agentGroupId: GROUP_ID, sessionId },
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

/**
 * Discovery reports the phase the listing itself observed — no per-handle
 * probe. A bare handle is a running one; pair it with a phase to say otherwise.
 */
function installDriver(entries: (SessionHandle | [SessionHandle, SessionPhase])[]): void {
  const snapshots = entries.map((entry) =>
    Array.isArray(entry) ? { handle: entry[0], phase: entry[1] } : { handle: entry, phase: 'running' as SessionPhase },
  );
  const driver = {
    kind: 'fake-pod',
    listSessions: vi.fn(async () => snapshots),
    watchSessions: () => ({ stop: () => {} }),
  } as unknown as SessionEventsDriver;
  vi.mocked(getSessionDriver).mockReturnValue(driver);
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await db.run(
    'INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)',
    GROUP_ID,
    'Code Group',
    FOLDER,
    new Date().toISOString(),
  );
  await ensureContainerConfig(GROUP_ID);
  installDriver([]);
  vi.mocked(wakeContainer).mockReset();
  vi.mocked(wakeContainer).mockResolvedValue(false);
});

afterEach(async () => {
  await closeDb();
});

async function seedActiveSession(sessionId = 'sess-live', lastActive = new Date().toISOString()): Promise<void> {
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, NULL, NULL, NULL, 'active', 'running', ?, ?)`,
    sessionId,
    GROUP_ID,
    lastActive,
    lastActive,
  );
}

/** A task-created session: messaging_group_id NULL, thread_id 'system:tasks:<series>'. */
async function seedTaskSession(
  sessionId: string,
  seriesId = 'series-1',
  createdAt = new Date().toISOString(),
): Promise<void> {
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, NULL, ?, NULL, 'active', 'running', ?, ?)`,
    sessionId,
    GROUP_ID,
    taskThreadId(seriesId),
    createdAt,
    createdAt,
  );
}

/** A channel-wired session: a real messaging group behind it (FKs are on). */
async function seedChannelSession(sessionId: string, createdAt = new Date().toISOString()): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, instance, created_at) VALUES ('mg1', 'test', 'chan-1', '', ?)`,
    createdAt,
  );
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, 'mg1', NULL, NULL, 'active', 'running', ?, ?)`,
    sessionId,
    GROUP_ID,
    createdAt,
    createdAt,
  );
}

describe('groups attach', () => {
  it('is operator-only: an agent caller is refused before the handler runs', async () => {
    const res = await attach(GROUP_ID, AGENT);
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toMatch(/operator-only/);
  });

  it('refuses a group that is not in code mode, pointing at the flag', async () => {
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toMatch(/not a code-mode group/);
    expect(errMsg(res)).toContain('--code-mode true');
  });

  it('refuses a group with no session rows at all — nothing to wake', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toMatch(/no session yet/);
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('D13: no live runtime → wakes the session lazily and attaches to it', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedActiveSession('sess-cold');
    // No handle before the wake; the wake brings the pod up.
    vi.mocked(wakeContainer).mockImplementation(async () => {
      installDriver([handleFor('sess-cold', 'ncl-test-sess-cold')]);
      return true;
    });
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect((res.data as { containerName: string }).containerName).toBe('ncl-test-sess-cold');
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(wakeContainer).mock.calls[0][0].id).toBe('sess-cold');
  });

  it('reports honestly when the wake itself fails', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedActiveSession('sess-cold');
    vi.mocked(wakeContainer).mockResolvedValue(false);
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(false);
    expect(errMsg(res)).toMatch(/did not come up/);
  });

  it('scans ALL active sessions and attaches to the one with a running runtime', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedActiveSession('sess-old', '2026-01-01T00:00:00.000Z'); // has the running pod
    await seedActiveSession('sess-new'); // newer, but its pod is gone
    installDriver([
      [handleFor('sess-new', 'ncl-test-sess-new'), 'terminal'],
      [handleFor('sess-old', 'ncl-test-sess-old'), 'running'],
    ]);
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect((res.data as { containerName: string }).containerName).toBe('ncl-test-sess-old');
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('returns the exec spec THE DRIVER composed, resolving by folder too', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedActiveSession('sess-live');
    installDriver([handleFor('sess-live', 'ncl-test-sess-live')]);

    const res = await attach(FOLDER); // folder, not id — both resolve
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    const data = res.data as {
      attachExec: { bin: string; argsTty: string[]; argsPlain: string[] };
      containerName: string;
    };
    expect(data.containerName).toBe('ncl-test-sess-live');
    // The argv is the handle's, verbatim, around the host's ONE addition:
    // the door-activity stamp (policy, decided here — liveness v2), then the
    // frozen client tail.
    expect(data.attachExec.bin).toBe('kubectl');
    expect(data.attachExec.argsTty).toEqual([
      'exec',
      '-i',
      '-t',
      '-n',
      'agents',
      'ncl-test-sess-live',
      '-c',
      'agent',
      '--',
      ...DOOR_STAMP,
      'bun',
      CLIENT_TAIL,
    ]);
    expect(data.attachExec.argsPlain).toEqual([
      'exec',
      '-i',
      '-n',
      'agents',
      'ncl-test-sess-live',
      '-c',
      'agent',
      '--',
      ...DOOR_STAMP,
      'bun',
      CLIENT_TAIL,
    ]);
  });

  it('hands back the stock tmux client argv when the deployment terminal mode is tmux', async () => {
    process.env.NANOCLAW_CODE_TERM = 'tmux';
    try {
      await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
      await seedActiveSession();
      installDriver([handleFor('sess-live', 'ncl-test-sess-live')]);
      const res = await attach(GROUP_ID);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      const data = res.data as { attachExec: { argsTty: string[] } };
      // Same handle-owned dialect, different client: tmux against the
      // runner's server socket (hand-synced with tmux-session.ts). The
      // `env TERM=…` prefix and `-u` are not decoration — the exec transport
      // forwards neither TERM nor the locale, so without them the operator
      // gets 8-color output and garbled block glyphs (measured on the POC).
      expect(data.attachExec.argsTty.slice(-9)).toEqual([
        'env',
        'TERM=xterm-256color',
        'tmux',
        '-u',
        '-S',
        '/tmp/code-runner/tmux.sock',
        'attach-session',
        '-t',
        'agent',
      ]);
      // The door stamp rides in front of the client on this arm too.
      expect(data.attachExec.argsTty.slice(-13, -9)).toEqual(DOOR_STAMP);
    } finally {
      delete process.env.NANOCLAW_CODE_TERM;
    }
  });

  it('opens a box whose only sessions are task-created (task #16)', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedTaskSession('sess-task'); // no channel-wired rows anywhere
    installDriver([handleFor('sess-task', 'ncl-test-sess-task')]);
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect((res.data as { containerName: string }).containerName).toBe('ncl-test-sess-task');
  });

  it('prefers the channel-wired session for the wake even when a task session is newer', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedChannelSession('sess-chat', '2026-01-01T00:00:00.000Z');
    await seedTaskSession('sess-task'); // newer, but not what an operator means
    vi.mocked(wakeContainer).mockImplementation(async () => {
      installDriver([handleFor('sess-chat', 'ncl-test-sess-chat')]);
      return true;
    });
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect((res.data as { containerName: string }).containerName).toBe('ncl-test-sess-chat');
    expect(vi.mocked(wakeContainer).mock.calls[0][0].id).toBe('sess-chat');
  });

  it('widens attach only: chat resolution still never sees a task session', async () => {
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    await seedTaskSession('sess-task');
    installDriver([handleFor('sess-task', 'ncl-test-sess-task')]);
    // resolveSession's agent-shared mode rides findSessionByAgentGroup —
    // a task-only box must attach, yet look sessionless to chat routing.
    expect(await findSessionByAgentGroup(GROUP_ID)).toBeUndefined();
    const res = await attach(GROUP_ID);
    expect(res.ok).toBe(true);
  });
});
