/**
 * Regression test for the wake-tick SLA race in the host sweep.
 *
 * Drives the real sweep loop (startHostSweep) against a real central DB and
 * real on-disk session DBs, mocking only the container runner. Scenario: a
 * session has a due inbound message AND a stale processing_ack claim left
 * over from a crashed container. The sweep tick that wakes a fresh container
 * must NOT kill it in the same tick — the freshly-woken container hasn't had
 * a chance to clear the stale claim yet (clearStaleProcessingAcks runs on
 * agent-runner startup). A later tick where the claim is still stale must
 * kill (claim-stuck). Goes red if the justWoke grace gate
 * (`if (alive && outDb && !justWoke)`) is removed.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-grace' };
});

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { initSessionFolder, openOutboundDbRw, writeSessionMessage } from './session-manager.js';

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
  const db = openOutboundDbRw(AG, SESS);
  try {
    db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
      messageId,
      'processing',
      new Date(Date.now() - ageMs).toISOString(),
    );
  } finally {
    db.close();
  }
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

beforeEach(() => {
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  vi.mocked(wakeContainer)
    .mockReset()
    // Simulate a successful spawn: after wake, the container reports running.
    .mockImplementation(async () => {
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

  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: AG, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  createSession({
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
  writeSessionMessage(AG, SESS, { id: 'm-1', kind: 'chat', timestamp: now(), content: '{"text":"hi"}' });
  seedStaleClaim('m-1', 2 * 60 * 60 * 1000); // claimed 2h ago
});

afterEach(() => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('host sweep justWoke grace period', () => {
  it('does not kill the container on the tick that woke it, kills on a later tick if the claim is still stale', async () => {
    // Tick 1: due message + no running container → wake. The stale claim is
    // still in outbound.db, but the grace period must skip the SLA check.
    await runSweepTick();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).not.toHaveBeenCalled();

    // Tick 2: container is running (no fresh wake → no grace), the claim is
    // still stale because our simulated container never cleared it → kill.
    await runSweepTick();
    expect(wakeContainer).toHaveBeenCalledTimes(1); // no second wake
    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(SESS, 'claim-stuck');
  });
});
