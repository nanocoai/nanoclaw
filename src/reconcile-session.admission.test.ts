/**
 * The reconcile pass consults the registered scheduler admission before
 * waking a session with due messages, and tells it when a running session has
 * gone idle. With nothing registered, every due session wakes as before.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-reconcile-admission' };
});

vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { isContainerRunning, wakeContainer } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createSession, TASKS_SYSTEM_THREAD_ID } from './db/sessions.js';
import { getAgentMailbox } from './mailbox/index.js';
import {
  registerSchedulerAdmission,
  type DueSessionCandidate,
  type SchedulerAdmission,
} from './modules/scheduling/admission.js';
import { reconcileSession } from './reconcile-session.js';
import { initSessionFolder } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-reconcile-admission';
const AG = 'ag-admission';
const SESS = 'sess-admission';

function now(): string {
  return new Date().toISOString();
}

async function insertDueTask(content: Record<string, unknown>): Promise<void> {
  await getAgentMailbox().session({ agentGroupId: AG, sessionId: SESS }, (mailbox) =>
    mailbox.insertTask({
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: new Date(Date.now() - 1000).toISOString(),
      recurrence: null,
      content: JSON.stringify(content),
    }),
  );
}

beforeEach(async () => {
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Admission', folder: 'admission', agent_provider: null, created_at: now() });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: `${TASKS_SYSTEM_THREAD_ID}:task-1`,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(AG, SESS);
  await insertDueTask({ prompt: 'run the report', script: null, weight: 7 });
});

afterEach(async () => {
  registerSchedulerAdmission(null);
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('scheduler admission in the reconcile pass', () => {
  it('wakes a due session when no admission is registered', async () => {
    await reconcileSession(SESS);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('a registered admission defers the wake and sees the due task envelope', async () => {
    const seen: DueSessionCandidate[] = [];
    registerSchedulerAdmission({
      shouldWake: async (candidate) => {
        seen.push(candidate);
        return false;
      },
    });

    await reconcileSession(SESS);

    expect(wakeContainer).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].session.id).toBe(SESS);
    expect(seen[0].session.agent_group_id).toBe(AG);
    expect(seen[0].isTaskSession).toBe(true);
    expect(seen[0].dueCount).toBe(1);
    expect(seen[0].dueTasks.map((task) => JSON.parse(task.content).weight)).toEqual([7]);
  });

  it('a deferred wake is retried on the next reconcile once admitted', async () => {
    let open = false;
    registerSchedulerAdmission({ shouldWake: async () => open });

    await reconcileSession(SESS);
    expect(wakeContainer).not.toHaveBeenCalled();

    open = true;
    await reconcileSession(SESS);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('is not consulted while the container is already running', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const shouldWake = vi.fn<SchedulerAdmission['shouldWake']>().mockResolvedValue(true);
    registerSchedulerAdmission({ shouldWake });

    await reconcileSession(SESS);

    expect(shouldWake).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('calls onSessionIdle for a running container with nothing due or in flight', async () => {
    await getAgentMailbox().session({ agentGroupId: AG, sessionId: SESS }, (mailbox) => {
      mailbox.cancelTask('task-1');
    });
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const onSessionIdle = vi.fn<NonNullable<SchedulerAdmission['onSessionIdle']>>().mockResolvedValue();
    registerSchedulerAdmission({ shouldWake: async () => true, onSessionIdle });

    await reconcileSession(SESS);

    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(onSessionIdle.mock.calls[0][0].id).toBe(SESS);
  });

  it('does not call onSessionIdle while messages are still due', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const onSessionIdle = vi.fn<NonNullable<SchedulerAdmission['onSessionIdle']>>().mockResolvedValue();
    registerSchedulerAdmission({ shouldWake: async () => true, onSessionIdle });

    await reconcileSession(SESS);

    expect(onSessionIdle).not.toHaveBeenCalled();
  });
});
