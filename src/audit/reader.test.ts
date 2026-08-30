import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from './types.js';

const state = vi.hoisted(() => ({ rows: [] as Array<{ event: AuditEvent; line: string }> }));
vi.mock('./config.js', () => ({ AUDIT_ENABLED: true }));
vi.mock('./store.js', () => ({
  getAuditStore: () => ({
    readNewest: async (before: number | null, limit: number) =>
      state.rows.filter(({ event }) => before === null || event.seq < before).slice(0, limit),
  }),
}));

import { listAuditEvents, parseTimeFlag } from './reader.js';

function event(seq: number, action: string, outcome: 'success' | 'failure'): AuditEvent {
  return {
    schema_version: 'nanoco.host-audit.v1',
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    host_id: 'host-reader-test',
    seq,
    occurred_at: new Date(Date.UTC(2026, 7, 25, 10, 0, seq)).toISOString(),
    event_type: 'ncl_action',
    provenance: 'host-observed',
    actor: { type: 'human', id: `user-${seq}` },
    agent_id: null,
    session_id: null,
    dimensions: { transport: 'socket', arg_names: [], action, outcome },
  };
}

beforeEach(() => {
  const events = [
    event(3, 'groups.update', 'failure'),
    event(2, 'groups.list', 'success'),
    event(1, 'users.list', 'success'),
  ];
  state.rows = events.map((candidate) => ({ event: candidate, line: JSON.stringify(candidate) }));
});

describe('PostgreSQL audit reader', () => {
  it('returns newest-first rows with action and outcome filters', async () => {
    const rows = await listAuditEvents({ action: 'groups', outcome: 'success' });
    expect(rows).toEqual([
      expect.objectContaining({ seq: 2, action: 'groups.list', outcome: 'success' }),
    ]);
  });

  it('returns the exact stored canonical lines for ndjson', async () => {
    const output = await listAuditEvents({ format: 'ndjson', limit: 2 });
    expect(output).toBe(state.rows.slice(0, 2).map(({ line }) => line).join('\n'));
  });

  it('parses relative and canonical time flags and rejects malformed values', () => {
    expect(parseTimeFlag('2026-08-25T10:00:00.000Z', '--since')).toBe(Date.parse('2026-08-25T10:00:00.000Z'));
    expect(parseTimeFlag('30m', '--since')).toBeLessThanOrEqual(Date.now());
    expect(() => parseTimeFlag('sometime', '--since')).toThrow(/invalid --since/);
  });
});
