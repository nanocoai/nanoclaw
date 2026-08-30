import { describe, expect, it, vi } from 'vitest';

import { HOST_AUDIT_MAX_BATCH_BYTES, HOST_AUDIT_MAX_BATCH_ITEMS } from './contract.js';
import { streamGovernanceBatches } from './governance-queue.js';
import type { AuditStore, StoredAuditEvent } from './store.js';
import type { AuditEvent } from './types.js';

function event(seq: number, dimensions: Record<string, unknown> = {}): AuditEvent {
  return {
    schema_version: 'nanoco.host-audit.v1',
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    host_id: 'Prod.EU:Host-01',
    seq,
    occurred_at: '2026-08-23T10:00:00.000Z',
    event_type: 'ncl_action',
    provenance: 'host-observed',
    actor: { type: 'human', id: 'host:test' },
    agent_id: null,
    session_id: null,
    dimensions: dimensions as AuditEvent['dimensions'],
  };
}

function fakeStore(events: AuditEvent[]): AuditStore {
  const rows: StoredAuditEvent[] = events.map((candidate) => ({ event: candidate, line: JSON.stringify(candidate) }));
  return {
    initialize: vi.fn(async () => undefined),
    append: vi.fn(),
    allocatedThrough: vi.fn(async () => events.at(-1)?.seq ?? 0),
    acknowledgedThrough: vi.fn(async () => 0),
    advanceAcknowledgement: vi.fn(async () => undefined),
    readAfter: vi.fn(async (seq: number, limit: number) => rows.filter(({ event: row }) => row.seq > seq).slice(0, limit)),
    readNewest: vi.fn(),
    pruneAcknowledgedBefore: vi.fn(async () => 0),
  } as AuditStore;
}

async function collect(store: AuditStore, cursor = 0) {
  const batches = [];
  for await (const batch of streamGovernanceBatches(cursor, store)) batches.push(batch);
  return batches;
}

describe('PostgreSQL Governance outbox batching', () => {
  it('replays the same contiguous bytes until acknowledgement advances', async () => {
    const store = fakeStore([event(1), event(2), event(3)]);
    const first = await collect(store);
    const replay = await collect(store);
    expect(first).toHaveLength(1);
    expect(first[0].body.equals(replay[0].body)).toBe(true);
    expect(first[0].batch.items.map((item) => item.event.seq)).toEqual([1, 2, 3]);
    expect(await collect(store, 3)).toEqual([]);
  });

  it('caps requests at 512 events and 1 MiB', async () => {
    const countStore = fakeStore(Array.from({ length: HOST_AUDIT_MAX_BATCH_ITEMS + 1 }, (_, index) => event(index + 1)));
    const countBatches = await collect(countStore);
    expect(countBatches.map((batch) => batch.batch.items.length)).toEqual([512, 1]);

    const refs = Array.from({ length: 16 }, (_, index) => `task:${index}${'x'.repeat(230)}`);
    const byteStore = fakeStore(Array.from({ length: 400 }, (_, index) => event(index + 1, { resource_refs: refs })));
    const byteBatches = await collect(byteStore);
    expect(byteBatches.length).toBeGreaterThan(1);
    expect(byteBatches.every((batch) => batch.body.length <= HOST_AUDIT_MAX_BATCH_BYTES)).toBe(true);
  });

  it('refuses a database gap instead of skipping evidence', async () => {
    await expect(collect(fakeStore([event(1), event(3)]))).rejects.toThrow(/not contiguous at seq 2/);
  });
});
