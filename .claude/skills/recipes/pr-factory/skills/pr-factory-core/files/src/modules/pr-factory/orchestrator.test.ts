/**
 * pr-factory-core guard — the orchestrator's consumption of the two-DB
 * session seam: writeOutboundDirect into the worker session's outbound.db
 * (depends on core's read-write outbound open), writeSessionMessage +
 * wakeContainer for the inbound trigger, and resolveSession against the
 * tester-instance messaging group.
 *
 * The VM control plane is a stub conforming to the TestOrchestratorModule
 * seam — its callbacks are captured from initOrchestrator's init() call and
 * driven directly. Real central DB, real on-disk session DBs. No canvas
 * provider is registered, so summaries take the plain-text fallback.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-orch/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-orch/groups',
  };
});

vi.mock('./activity-log.js', () => ({ prLog: vi.fn() }));

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPrThread } from '../../db/pr-threads.js';
import { inboundDbPath, outboundDbPath, resolveSession } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { handleTestResults, initOrchestrator, shutdownOrchestrator } from './orchestrator.js';
import type { OrchestratorCallbacks, TestOrchestratorModule } from './test-orchestration.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-prf-orch';
const REPO = 'acme/widgets';
const CHANNEL_ID = 'slack:C0WORK';
const THREAD_TS = '1700000000.000100';

let callbacks: OrchestratorCallbacks;
let testOrchStub: {
  init: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
};
let workerSession: Session;

function now(): string {
  return new Date().toISOString();
}

function readRows(dbPath: string, table: string): Array<{ kind: string; content: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT kind, content FROM ${table} ORDER BY rowid`).all() as Array<{
    kind: string;
    content: string;
  }>;
  db.close();
  return rows;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-worker',
    name: 'Worker',
    folder: 'pr-factory-worker',
    agent_provider: null,
    created_at: now(),
  });
  createAgentGroup({ id: 'ag-tester', name: 'Tester', folder: 'pr-tester', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-worker',
    channel_type: 'slack',
    platform_id: CHANNEL_ID,
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-tester',
    channel_type: 'slack',
    platform_id: CHANNEL_ID,
    instance: 'slack-tester',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });

  workerSession = resolveSession('ag-worker', 'mg-worker', `${CHANNEL_ID}:${THREAD_TS}`, 'per-thread').session;
  createPrThread({
    channel_id: CHANNEL_ID,
    thread_ts: THREAD_TS,
    channel_type: 'slack',
    repo_full_name: REPO,
    pr_number: 42,
    session_id: workerSession.id,
    created_at: now(),
  });

  testOrchStub = {
    init: vi.fn((cbs: OrchestratorCallbacks) => {
      callbacks = cbs;
    }),
    completeRun: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  };
  initOrchestrator(testOrchStub as unknown as TestOrchestratorModule, 'ag-tester', 'mg-tester');
  expect(testOrchStub.init).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  shutdownOrchestrator();
  vi.clearAllMocks();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('orchestrator', () => {
  it('onVmReady resolves a tester session in the PR thread, writes the plan trigger, and wakes it', async () => {
    await callbacks.onVmReady(42, REPO, 'test-vm-42.example.test', '## Test Plan');

    const tester = resolveSession('ag-tester', 'mg-tester', `${CHANNEL_ID}:${THREAD_TS}`, 'per-thread');
    expect(tester.created).toBe(false); // already created by onVmReady

    const inbound = readRows(inboundDbPath('ag-tester', tester.session.id), 'messages_in');
    expect(inbound).toHaveLength(1);
    const text = (JSON.parse(inbound[0].content) as { text: string }).text;
    expect(text).toContain('test-vm-42.example.test');
    expect(text).toContain('## Test Plan');
    expect(text).toContain(`[PR_CONTEXT: channel=${CHANNEL_ID} thread=${THREAD_TS} repo=${REPO} pr=42]`);
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);

    // Clear the 30-minute timeout armed by onVmReady.
    await handleTestResults({ pr_number: 42, repo: REPO, verdict: 'PASS', content: 'all good' }, workerSession);
  });

  it('PASS verdict: posts the summary to the worker outbound.db and wakes the worker to propose merge', async () => {
    await handleTestResults({ pr_number: 42, repo: REPO, verdict: 'PASS', content: 'all good' }, workerSession);

    expect(testOrchStub.completeRun).toHaveBeenCalledWith(42);

    const outbound = readRows(outboundDbPath('ag-worker', workerSession.id), 'messages_out');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].kind).toBe('chat');
    expect((JSON.parse(outbound[0].content) as { text: string }).text).toContain('PASS');

    const inbound = readRows(inboundDbPath('ag-worker', workerSession.id), 'messages_in');
    expect(inbound).toHaveLength(1);
    const text = (JSON.parse(inbound[0].content) as { text: string }).text;
    expect(text).toContain('Propose merge');
    expect(text).toContain(`[PR_CONTEXT: channel=${CHANNEL_ID} thread=${THREAD_TS} repo=${REPO} pr=42]`);
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('FAIL verdict: wakes the worker to analyze instead of proposing merge', async () => {
    await handleTestResults({ pr_number: 42, repo: REPO, verdict: 'FAIL', content: 'test 3 failed' }, workerSession);

    const inbound = readRows(inboundDbPath('ag-worker', workerSession.id), 'messages_in');
    expect(inbound).toHaveLength(1);
    const text = (JSON.parse(inbound[0].content) as { text: string }).text;
    expect(text).toContain('Analyze the results');
    expect(text).toContain('test 3 failed');
    expect(text).not.toContain('Propose merge');
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('a second onVmReady for the same PR clears the prior timeout — no orphaned timer fires', async () => {
    vi.useFakeTimers();
    try {
      // Two VM-ready events for the same PR. The fix clears the first timer
      // before arming the second; without it the first timer is orphaned and
      // still fires at +30min, posting a spurious "Test Timeout".
      await callbacks.onVmReady(42, REPO, 'vm-a.example.test', '## Plan A');
      await callbacks.onVmReady(42, REPO, 'vm-b.example.test', '## Plan B');

      // Results arrive and clear the single live (second) timer.
      await handleTestResults({ pr_number: 42, repo: REPO, verdict: 'PASS', content: 'all good' }, workerSession);

      // Advance well past the 30-minute ceiling. A leaked first timer would
      // fire handleTimeout here and append a timeout message.
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

      const outbound = readRows(outboundDbPath('ag-worker', workerSession.id), 'messages_out');
      const timeoutMsgs = outbound.filter((r) =>
        (JSON.parse(r.content) as { text: string }).text.includes('Test Timeout'),
      );
      expect(timeoutMsgs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
