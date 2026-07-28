/**
 * Regression tests for the 2026-07-28 deep-fix pass:
 *
 * 1. Runaway "Engine handoff" recaps — last_turn_provider was only stamped
 *    when the primary's long-lived query CLOSED, while the fallback path
 *    stamped 'codex' per turn. One fallback episode left 'codex' stuck and
 *    every subsequent primary query prepended a recap (46+ in one session's
 *    transcript, provider never changing).
 * 2. Fallback thread never rotated — grew to 475k tokens live and wedged on
 *    every resume (180s idle abort on each turn).
 * 3. Post-result stream errors (codex thread/compact timeout) failed an
 *    already-answered fallback turn with a bogus ❌ banner.
 * 4. Quota pre-warning starved — rate_limit_events stopped carrying
 *    utilization (~2026-07-08); the /usage control API is the new source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import {
  getContinuation,
  getLastTurnProvider,
  getThreadTokens,
  setContinuation,
  setLastTurnProvider,
  setThreadTokens,
} from './db/session-state.js';
import { processQuery, rotateFallbackThreadIfOversized, runFallbackTurn } from './poll-loop.js';
import { usageToQuotaStatus } from './providers/claude.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import type { Database } from 'bun:sqlite';

const ROUTING = {
  platformId: 'whatsapp:123',
  channelType: 'whatsapp',
  threadId: null,
  inReplyTo: null,
};

let inbound: Database;

beforeEach(() => {
  ({ inbound } = initTestSessionDb());
  inbound
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('user', 'User', 'channel', 'whatsapp', 'whatsapp:123')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

/** AgentQuery that plays a scripted event sequence, optionally throwing at the end. */
function scriptedQuery(events: ProviderEvent[], throwAfter?: Error): AgentQuery {
  let ended = false;
  return {
    push() {},
    end() {
      ended = true;
    },
    abort() {
      ended = true;
    },
    events: (async function* () {
      for (const e of events) {
        yield e;
        if (ended && !throwAfter) return;
      }
      if (throwAfter) throw throwAfter;
    })(),
  };
}

function scriptedProvider(events: ProviderEvent[], throwAfter?: Error): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(_input: QueryInput): AgentQuery {
      return scriptedQuery(events, throwAfter);
    },
  };
}

describe('last_turn_provider stamping (runaway-recap regression)', () => {
  it('stamps the primary provider at RESULT time, even if the query later dies', async () => {
    // Simulate the live poisoned state: a past fallback turn stamped codex.
    setLastTurnProvider('codex');

    const query = scriptedQuery(
      [
        { type: 'init', continuation: 'sess-abc' },
        { type: 'result', text: '<message to="user">hi</message>' },
      ],
      new Error('stream closed abnormally'),
    );

    await expect(processQuery(query, { ...ROUTING }, [], 'claude', 'prompt', true)).rejects.toThrow(
      'stream closed abnormally',
    );

    // The regression: with stamping only at query close, this stayed 'codex'
    // and every subsequent query prepended an "Engine handoff" recap.
    expect(getLastTurnProvider()).toBe('claude');
  });
});

describe('rotateFallbackThreadIfOversized', () => {
  it('clears an oversized fallback thread so the next turn starts fresh', () => {
    setContinuation('codex', 'thread-wedged');
    setThreadTokens('codex', 475_364); // observed live
    rotateFallbackThreadIfOversized('codex', 150_000);
    expect(getContinuation('codex')).toBeUndefined();
    expect(getThreadTokens('codex')).toBe(0);
  });

  it('leaves a healthy thread alone', () => {
    setContinuation('codex', 'thread-ok');
    setThreadTokens('codex', 40_000);
    rotateFallbackThreadIfOversized('codex', 150_000);
    expect(getContinuation('codex')).toBe('thread-ok');
    expect(getThreadTokens('codex')).toBe(40_000);
  });
});

describe('fallback turn resilience to post-result stream errors', () => {
  it('treats the turn as answered when the stream errors AFTER the result', async () => {
    const provider = scriptedProvider(
      [
        { type: 'init', continuation: 'fb-1' },
        { type: 'result', text: '<message to="user">answered</message>' },
      ],
      new Error('Timeout waiting for thread/compact/start response (60000ms)'),
    );

    // Must resolve — the user already got their answer; failing here sent a
    // bogus ❌ "backup engine failed" banner right after a successful reply.
    await runFallbackTurn({ provider, providerName: 'codex' }, 'prompt', { ...ROUTING }, '/tmp');
  });
});

describe('usageToQuotaStatus (pre-warning data source)', () => {
  it('maps a five_hour utilization reading to a quota_status event', () => {
    const ev = usageToQuotaStatus({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 92, resets_at: '2026-07-28T21:00:00Z' } },
    });
    expect(ev).toEqual({
      type: 'quota_status',
      utilization: 92,
      warning: false,
      resetsAt: Math.floor(Date.parse('2026-07-28T21:00:00Z') / 1000),
      window: 'five_hour',
    });
  });

  it('returns null when plan limits do not apply', () => {
    expect(usageToQuotaStatus({ rate_limits_available: false, rate_limits: null })).toBeNull();
  });

  it('returns null when the window has no utilization reading', () => {
    expect(
      usageToQuotaStatus({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null, resets_at: null } },
      }),
    ).toBeNull();
    expect(usageToQuotaStatus(null)).toBeNull();
  });
});
