/**
 * Regression test for the wake-tick SLA race in the host sweep.
 *
 * Drives the real sweep loop (startHostSweep) against a real central DB and
 * real on-disk session DBs, mocking only the container runner. Scenario: a
 * session has a due inbound message AND a stale processing_ack claim left
 * over from a crashed container. Evidence that predates the fresh
 * container's durable claim time must not kill it — the freshly-woken
 * container hasn't had a chance to clear the stale claim yet
 * (clearStaleProcessingAcks runs on agent-runner startup), so the inherited
 * claim's age is measured from the incarnation's start, giving it the full
 * tolerance window. Once that window elapses with no sign of life, a later
 * tick must kill (claim-stuck). Goes red if the incarnation gate in
 * enforceRunningContainerSla stops reading the session_claims row.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-grace' };
});

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { log } from './log.js';
import { getAgentMailbox } from './mailbox/index.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { initSessionFolder, writeSessionMessage } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-grace';
const AG = 'ag-test';
const SESS = 'sess-test';
// Mirrors SWEEP_INTERVAL_MS in host-sweep.ts — identifies the sweep's
// self-reschedule among other setTimeout calls (e.g. vi.waitFor's polling).
const SWEEP_INTERVAL_MS = 60_000;

function now(): string {
  return new Date().toISOString();
}

function seedStaleClaim(messageId: string, ageMs: number): void {
  const db = new Database(outboundDbPath(AG, SESS));
  db.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)").run(
    messageId,
    new Date(Date.now() - ageMs).toISOString(),
  );
  db.close();
}

/**
 * The sweep loop signals tick completion by rescheduling itself via
 * setTimeout(sweep, SWEEP_INTERVAL_MS). Capture those callbacks instead of
 * scheduling them, so each tick ends inert and the test drives the next tick
 * explicitly. All other setTimeout calls pass through untouched.
 */
const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

/** Run exactly one sweep tick and wait for it to complete. */
async function runSweepTick(): Promise<void> {
  const before = sweepCallbacks.length;
  if (before === 0) {
    startHostSweep();
  } else {
    // Invoke the captured self-reschedule — the real next-tick path.
    sweepCallbacks[before - 1]();
  }
  await vi.waitFor(() => {
    expect(sweepCallbacks.length).toBe(before + 1);
  });
}

beforeEach(async () => {
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  vi.mocked(wakeContainer)
    .mockReset()
    // Simulate a successful spawn honoring the runner's claim-first contract:
    // a wake claims the session at a fresh incarnation (claimed_at = now),
    // then the container reports running.
    .mockImplementation(async () => {
      const { getSessionClaim, tryClaimSession } = await import('./db/coordination.js');
      const current = await getSessionClaim(SESS);
      await tryClaimSession({
        sessionId: SESS,
        instanceId: 'sweep-test-host',
        expectedIncarnation: current?.incarnation ?? 0,
        now: new Date().toISOString(),
      });
      vi.mocked(isContainerRunning).mockReturnValue(true);
      return true;
    });

  sweepCallbacks.length = 0;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(AG, SESS);

  // A due message (wakes the container) + a stale claim from a previous crash
  // (would trip claim-stuck if the SLA check ran on the wake tick).
  await writeSessionMessage(AG, SESS, { id: 'm-1', kind: 'chat', timestamp: now(), content: '{"text":"hi"}' });
  seedStaleClaim('m-1', 2 * 60 * 60 * 1000); // claimed 2h ago
});

afterEach(async () => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('host sweep incarnation-gated grace period', () => {
  it('uses one mailbox session when no wake is needed', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const sessionSpy = vi.spyOn(getAgentMailbox(), 'session');

    try {
      await runSweepTick();
      expect(wakeContainer).not.toHaveBeenCalled();
      expect(sessionSpy).toHaveBeenCalledTimes(1);
    } finally {
      sessionSpy.mockRestore();
    }
  });

  it('logs mailbox failures with session context and retries on a later tick', async () => {
    const err = new Error('mailbox unavailable');
    const sessionSpy = vi.spyOn(getAgentMailbox(), 'session').mockRejectedValueOnce(err);
    const logSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    try {
      await runSweepTick();
      expect(logSpy).toHaveBeenCalledWith('Session mailbox sweep failed', {
        agentGroupId: AG,
        sessionId: SESS,
        err,
      });

      await runSweepTick();
      // Failed preflight on tick 1, then preflight + maintenance on tick 2.
      expect(sessionSpy).toHaveBeenCalledTimes(3);
    } finally {
      sessionSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('gives a fresh container its tolerance window against inherited stale claims, then kills', async () => {
    // Tick 1: due message + no running container → wake. The 2h-old claim is
    // still in outbound.db, but it predates the fresh incarnation's claim
    // time — not evidence against this container.
    await runSweepTick();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).not.toHaveBeenCalled();

    // Tick 2, moments later: the inherited claim's age is measured from the
    // incarnation start, so it is still inside the tolerance window — no kill.
    await runSweepTick();
    expect(wakeContainer).toHaveBeenCalledTimes(1); // no second wake
    expect(killContainer).not.toHaveBeenCalled();

    // The tolerance window elapses (backdate the incarnation's claim time)
    // with no sign of life — now the stale claim is this container's own
    // silence → kill.
    const { getDb } = await import('./db/index.js');
    await getDb().run(
      'UPDATE session_claims SET claimed_at = ? WHERE session_id = ?',
      new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      SESS,
    );
    await runSweepTick();
    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(SESS, 'claim-stuck');
  });
});
