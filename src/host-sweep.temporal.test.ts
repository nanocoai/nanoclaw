import { describe, expect, it } from 'vitest';

import { TEMPORAL_IDLE_MS, shouldDestroyTemporalSession } from './host-sweep.js';
import type { Session } from './types.js';

const NOW = Date.parse('2026-04-20T12:00:00.000Z');

function sess(overrides: Partial<Session>): Session {
  return {
    id: 'sess-x',
    agent_group_id: 'ag',
    messaging_group_id: 'mg',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    temporal: 1,
    ...overrides,
  };
}

describe('shouldDestroyTemporalSession', () => {
  const idle = new Date(NOW - TEMPORAL_IDLE_MS - 1000).toISOString();
  const fresh = new Date(NOW - 1000).toISOString();

  it('tears down an idle, not-running temporal session', () => {
    expect(shouldDestroyTemporalSession(sess({ last_active: idle }), false, NOW)).toBe(true);
  });

  it('keeps a temporal session whose container is running', () => {
    expect(shouldDestroyTemporalSession(sess({ last_active: idle }), true, NOW)).toBe(false);
  });

  it('keeps a freshly-active temporal session', () => {
    expect(shouldDestroyTemporalSession(sess({ last_active: fresh }), false, NOW)).toBe(false);
  });

  it('never tears down a normal (temporal=0) session', () => {
    expect(shouldDestroyTemporalSession(sess({ temporal: 0, last_active: idle }), false, NOW)).toBe(false);
  });

  it('falls back to created_at when last_active is null', () => {
    expect(shouldDestroyTemporalSession(sess({ last_active: null, created_at: idle }), false, NOW)).toBe(true);
    expect(shouldDestroyTemporalSession(sess({ last_active: null, created_at: fresh }), false, NOW)).toBe(false);
  });
});
