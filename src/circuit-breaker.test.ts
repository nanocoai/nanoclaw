/**
 * Unit tests for the startup circuit breaker.
 *
 * Covers state transitions, the documented backoff schedule, and the
 * fresh-install case where DATA_DIR doesn't exist yet (the breaker runs
 * before initDb, so it has to create the dir itself).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so they can't close over local
// consts. vi.hoisted is hoisted alongside the mock and runs before any
// `import` — so it can only use globals (no path/os modules).
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-cb-test' }));
const CB_PATH = path.join(TEST_DIR, 'circuit-breaker.json');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';

function readState(): { attempt: number; timestamp: string } {
  return JSON.parse(fs.readFileSync(CB_PATH, 'utf-8'));
}

function seedState(attempt: number, timestamp = new Date().toISOString()): void {
  fs.writeFileSync(CB_PATH, JSON.stringify({ attempt, timestamp }));
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('resetCircuitBreaker', () => {
  it('deletes the state file', () => {
    seedState(3);
    expect(fs.existsSync(CB_PATH)).toBe(true);
    resetCircuitBreaker();
    expect(fs.existsSync(CB_PATH)).toBe(false);
  });

  it('is a no-op when the file does not exist', () => {
    expect(fs.existsSync(CB_PATH)).toBe(false);
    expect(() => resetCircuitBreaker()).not.toThrow();
  });
});

describe('enforceStartupBackoff — state transitions', () => {
  it('first run writes attempt=1 and does not delay', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    await enforceStartupBackoff();
    // No timers should have been queued — clean first start is 0s.
    expect(Date.now() - start).toBe(0);
    expect(readState().attempt).toBe(1);
  });

  it('within reset window, attempt is incremented', async () => {
    seedState(1);
    vi.useFakeTimers();
    const promise = enforceStartupBackoff();
    await vi.runAllTimersAsync();
    await promise;
    expect(readState().attempt).toBe(2);
  });

  it('outside reset window (>1h), attempt resets to 1', async () => {
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedState(5, longAgo);
    await enforceStartupBackoff();
    expect(readState().attempt).toBe(1);
  });

  it('exactly at the reset window boundary still counts as "within"', async () => {
    // RESET_WINDOW_MS = 60min. Use 59min59s to stay inside even if the test
    // takes a few ms to execute.
    const justInside = new Date(Date.now() - (60 * 60 * 1000 - 1000)).toISOString();
    seedState(2, justInside);
    vi.useFakeTimers();
    const promise = enforceStartupBackoff();
    await vi.runAllTimersAsync();
    await promise;
    expect(readState().attempt).toBe(3);
  });

  it('treats a malformed state file as no prior state', async () => {
    fs.writeFileSync(CB_PATH, '{ this is not json');
    await enforceStartupBackoff();
    expect(readState().attempt).toBe(1);
  });

  it('resetCircuitBreaker after a startup actually clears the counter for the next startup', async () => {
    // Simulate: crash, restart (attempt=2), graceful shutdown, restart again.
    seedState(1);
    vi.useFakeTimers();
    const p1 = enforceStartupBackoff();
    await vi.runAllTimersAsync();
    await p1;
    expect(readState().attempt).toBe(2);

    resetCircuitBreaker();
    expect(fs.existsSync(CB_PATH)).toBe(false);

    await enforceStartupBackoff();
    expect(readState().attempt).toBe(1);
  });
});

describe('enforceStartupBackoff — backoff schedule', () => {
  /**
   * Documented schedule:
   *
   *   clean start → 1 crash → 2 crash → 3 crash → 4 crash → 5 crash → 6+ crash
   *      0s    →    0s    →   10s   →   30s   →   2min  →   5min  →   15min cap
   *
   * Each row is [priorAttempt seeded in the file, expected delay this run
   * produces in seconds]. priorAttempt=null = no file = very first start.
   *
   * To assert the *requested* delay (not just observed elapsed real time),
   * we spy on global.setTimeout and look at the longest call. runAllTimersAsync
   * lets the function complete so we can move on.
   */
  const cases: Array<{ label: string; priorAttempt: number | null; expectedDelaySec: number }> = [
    { label: 'clean first start (no file)', priorAttempt: null, expectedDelaySec: 0 },
    { label: 'first crash (attempt=2)', priorAttempt: 1, expectedDelaySec: 0 },
    { label: 'second crash (attempt=3)', priorAttempt: 2, expectedDelaySec: 10 },
    { label: 'third crash (attempt=4)', priorAttempt: 3, expectedDelaySec: 30 },
    { label: 'fourth crash (attempt=5)', priorAttempt: 4, expectedDelaySec: 120 },
    { label: 'fifth crash (attempt=6)', priorAttempt: 5, expectedDelaySec: 300 },
    { label: 'sixth crash (attempt=7) — cap', priorAttempt: 6, expectedDelaySec: 900 },
    { label: 'far past cap (attempt=20)', priorAttempt: 19, expectedDelaySec: 900 },
  ];

  for (const { label, priorAttempt, expectedDelaySec } of cases) {
    it(`${label}: delays ${expectedDelaySec}s`, async () => {
      if (priorAttempt !== null) seedState(priorAttempt);

      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const promise = enforceStartupBackoff();
      await vi.runAllTimersAsync();
      await promise;

      // enforceStartupBackoff only calls setTimeout when delaySec > 0. Pick
      // the longest delay it requested (vitest may queue small internal
      // timers we don't care about).
      const requestedDelays = setTimeoutSpy.mock.calls.map((c) => c[1] ?? 0);
      const maxDelayMs = requestedDelays.length ? Math.max(...requestedDelays) : 0;

      expect(maxDelayMs).toBe(expectedDelaySec * 1000);
    });
  }
});

describe('enforceStartupBackoff — fresh install (DATA_DIR missing)', () => {
  /**
   * The breaker runs before initDb (which is what creates DATA_DIR). On a
   * fresh checkout the dir doesn't exist yet, so write() must create it
   * before writing the state file — otherwise the host crashes on its very
   * first start.
   */
  it('creates DATA_DIR on demand and does not throw', async () => {
    fs.rmSync(TEST_DIR, { recursive: true });
    expect(fs.existsSync(TEST_DIR)).toBe(false);

    await expect(enforceStartupBackoff()).resolves.toBeUndefined();
    expect(fs.existsSync(TEST_DIR)).toBe(true);
    expect(fs.existsSync(CB_PATH)).toBe(true);
    expect(readState().attempt).toBe(1);
  });
});
