/**
 * Wiring test for the install-wide idle timeout: NANOCLAW_IDLE_TIMEOUT_MS
 * really reaches the sweep's IDLE_TIMEOUT_MS *and* the claim-stuck tolerance,
 * so an install on a slow local-model backend stops cold-killing containers
 * that are still working but quiet (#3643).
 *
 * `readEnvFile` is mocked out for the whole file. Without it these cases read
 * whatever is in the developer's own `.env`, and `vi.stubEnv` cannot clear it
 * — so the "unset" case would fail on exactly the machines that have the var
 * set, which is everyone debugging this feature.
 *
 * Parse and fallback rules are covered by `idle-timeout.test.ts` against the
 * pure helper; this file re-imports the sweep's whole module graph, so it does
 * the minimum re-imports needed to prove the wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_IDLE_TIMEOUT_MS } from './idle-timeout.js';

vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

async function loadSweepWith(envValue?: string) {
  vi.resetModules();
  vi.stubEnv('NANOCLAW_IDLE_TIMEOUT_MS', envValue ?? '');
  return import('./host-sweep.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const NOW = Date.parse('2026-04-20T12:00:00.000Z');

describe('NANOCLAW_IDLE_TIMEOUT_MS', () => {
  it('leaves the sweep on its built-in defaults when unset', async () => {
    const { IDLE_TIMEOUT_MS, IDLE_TIMEOUT_OVERRIDE_MS, CLAIM_STUCK_MS, decideStuckAction } =
      await loadSweepWith(undefined);
    expect(IDLE_TIMEOUT_MS).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(IDLE_TIMEOUT_OVERRIDE_MS).toBeUndefined();

    // The 60s claim tolerance must not widen just because the default idle
    // timeout is 30 min — an unset install behaves exactly as it always did.
    expect(
      decideStuckAction({
        now: NOW,
        heartbeatMtimeMs: NOW - 5 * 60 * 1000,
        containerState: null,
        claims: [{ messageId: 'm-1', statusChanged: new Date(NOW - 5 * 60 * 1000).toISOString() }],
      }),
    ).toEqual({
      action: 'kill-claim',
      messageId: 'm-1',
      claimAgeMs: 5 * 60 * 1000,
      toleranceMs: CLAIM_STUCK_MS,
    });
  });

  it('raises the silence the sweep tolerates on both kill paths', async () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const { IDLE_TIMEOUT_MS, decideStuckAction } = await loadSweepWith(String(twoHrMs));
    expect(IDLE_TIMEOUT_MS).toBe(twoHrMs);

    // Heartbeat path — 45 min silent: killed under the built-in default,
    // alive under a 2h timeout.
    expect(
      decideStuckAction({
        now: NOW,
        heartbeatMtimeMs: NOW - 45 * 60 * 1000,
        containerState: null,
        claims: [],
      }).action,
    ).toBe('ok');
    expect(
      decideStuckAction({
        now: NOW,
        heartbeatMtimeMs: NOW - (twoHrMs + 1),
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'kill-idle-timeout', heartbeatAgeMs: twoHrMs + 1, idleTimeoutMs: twoHrMs });

    // Claim path — the regression this test exists for. A backend still doing
    // prompt processing has claimed the message and written no heartbeat yet.
    // At a flat 60s tolerance this is killed 5 minutes in, despite the 2h
    // timeout the operator set.
    expect(
      decideStuckAction({
        now: NOW,
        heartbeatMtimeMs: 0,
        containerStartedAtMs: NOW - 5 * 60 * 1000,
        containerState: null,
        claims: [{ messageId: 'm-1', statusChanged: new Date(NOW - 5 * 60 * 1000).toISOString() }],
      }).action,
    ).toBe('ok');
    // Past the override it is still killed — raised, not disabled.
    expect(
      decideStuckAction({
        now: NOW,
        heartbeatMtimeMs: 0,
        containerStartedAtMs: NOW - (twoHrMs + 1),
        containerState: null,
        claims: [{ messageId: 'm-1', statusChanged: new Date(NOW - (twoHrMs + 1)).toISOString() }],
      }).action,
    ).toBe('kill-idle-timeout');
  });

  it('ignores an invalid value rather than letting it reach the sweep', async () => {
    const { IDLE_TIMEOUT_MS, IDLE_TIMEOUT_OVERRIDE_MS } = await loadSweepWith('soon');
    expect(IDLE_TIMEOUT_MS).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(IDLE_TIMEOUT_OVERRIDE_MS).toBeUndefined();
  });
});
