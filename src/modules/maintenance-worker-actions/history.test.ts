/**
 * Synthetic-fixture coverage for the Pepper->MC historical-query business
 * logic. No real worker messages/data anywhere in this file.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
// Side-effect import: registerMigration() must run before runMigrations()
// sees the worker_time_events/workers/etc. tables (see
// lowes-materials's tests for the same note).
import './index.js';
import { getWorkerActivityHistory, getWorkerTimeHistory } from './history.js';

const WORKER_A = 'telegram:1000000001';
const WORKER_B = 'telegram:1000000002';

async function seedWorker(userId: string, name: string): Promise<void> {
  await getDb().run(
    `INSERT INTO workers (user_id, name, preferred_language, role, can_drive_independently, created_at)
     VALUES (?, ?, 'en', 'worker', 1, ?)`,
    userId,
    name,
    new Date().toISOString(),
  );
}

async function seedTimeEvent(
  id: string,
  workerUserId: string,
  eventType: string,
  occurredAt: string,
  correctsEventId: string | null = null,
): Promise<void> {
  await getDb().run(
    `INSERT INTO worker_time_events (id, worker_user_id, event_type, occurred_at, recorded_at, source_message_id, corrects_event_id, note)
     VALUES (?, ?, ?, ?, ?, NULL, ?, '')`,
    id,
    workerUserId,
    eventType,
    occurredAt,
    occurredAt,
    correctsEventId,
  );
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedWorker(WORKER_A, 'Synthetic Alpha');
  await seedWorker(WORKER_B, 'Synthetic Beta');
});

afterEach(async () => {
  await closeDb();
});

describe('getWorkerTimeHistory', () => {
  it('computes hours worked per day across a date range from durable time events', async () => {
    await seedTimeEvent('e1', WORKER_A, 'clock_in', '2026-08-17T13:00:00.000Z');
    await seedTimeEvent('e2', WORKER_A, 'clock_out', '2026-08-17T21:00:00.000Z');
    await seedTimeEvent('e3', WORKER_A, 'clock_in', '2026-08-18T13:00:00.000Z');
    await seedTimeEvent('e4', WORKER_A, 'clock_out', '2026-08-18T20:30:00.000Z');

    const result = await getWorkerTimeHistory(WORKER_A, '2026-08-17T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.days).toHaveLength(2);
    expect(result.days[0].date).toBe('2026-08-17');
    expect(result.days[0].hoursWorked).toBe(8);
    expect(result.days[0].incomplete).toBe(false);
    expect(result.days[1].hoursWorked).toBe(7.5);
    expect(result.totalHours).toBe(15.5);
  });

  it('flags an incomplete day (missing clock_out) without inventing a punch', async () => {
    await seedTimeEvent('e1', WORKER_A, 'clock_in', '2026-08-17T13:00:00.000Z');
    // no matching clock_out

    const result = await getWorkerTimeHistory(WORKER_A, '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.days).toHaveLength(1);
    expect(result.days[0].incomplete).toBe(true);
    expect(result.days[0].incompleteNote).toMatch(/no matching clock_out/);
    expect(result.days[0].hoursWorked).toBeNull();
    expect(result.totalHours).toBe(0);
  });

  it('applies a correction (corrects_event_id) and reports it distinctly, never merging silently', async () => {
    await seedTimeEvent('e1', WORKER_A, 'clock_in', '2026-08-17T13:00:00.000Z');
    // Wrong clock_out recorded, then corrected.
    await seedTimeEvent('e2', WORKER_A, 'clock_out', '2026-08-17T18:00:00.000Z');
    await seedTimeEvent('e3', WORKER_A, 'clock_out', '2026-08-17T21:00:00.000Z', 'e2');

    const result = await getWorkerTimeHistory(WORKER_A, '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.correctionsApplied).toBe(1);
    // The superseded original (e2) is preserved in the raw event list...
    const original = result.days[0].events.find((e) => e.id === 'e2');
    expect(original?.supersededByCorrection).toBe(true);
    // ...but only the correcting event (e3) counts toward hours: 13:00-21:00 = 8h, not 13:00-18:00 = 5h.
    expect(result.days[0].hoursWorked).toBe(8);
  });

  it("one worker's records are never confused with another's", async () => {
    await seedTimeEvent('a1', WORKER_A, 'clock_in', '2026-08-17T13:00:00.000Z');
    await seedTimeEvent('a2', WORKER_A, 'clock_out', '2026-08-17T17:00:00.000Z');
    await seedTimeEvent('b1', WORKER_B, 'clock_in', '2026-08-17T09:00:00.000Z');
    await seedTimeEvent('b2', WORKER_B, 'clock_out', '2026-08-17T18:00:00.000Z');

    const resultA = await getWorkerTimeHistory(WORKER_A, '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
    expect(resultA.ok).toBe(true);
    if (resultA.ok) expect(resultA.totalHours).toBe(4);

    // Resolve by name too, and confirm the two workers' hours don't cross-contaminate.
    const resultB = await getWorkerTimeHistory('Synthetic Beta', '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      expect(resultB.totalHours).toBe(9);
      expect(resultB.workerUserId).toBe(WORKER_B);
    }
  });

  it('fails closed on an ambiguous name match rather than guessing', async () => {
    await seedWorker('telegram:1000000003', 'Synthetic Alpha'); // duplicate display name
    const result = await getWorkerTimeHistory('Synthetic Alpha', '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ambiguous/);
  });

  it('fails closed on an unknown worker', async () => {
    const result = await getWorkerTimeHistory('Nobody Here', '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
    expect(result.ok).toBe(false);
  });
});

describe('getWorkerActivityHistory', () => {
  it('merges structured records from all four source tables, chronologically', async () => {
    await getDb().run(
      `INSERT INTO worker_activity_log (id, worker_user_id, activity_type, detail, occurred_at, source_message_id)
       VALUES ('al1', ?, 'location_report', 'Arrived at Maple St', '2026-08-17T09:00:00.000Z', NULL)`,
      WORKER_A,
    );
    await seedTimeEvent('te1', WORKER_A, 'clock_in', '2026-08-17T09:05:00.000Z');
    await getDb().run(
      `INSERT INTO job_completions (id, job_reference, worker_user_id, reported_at, status, source_message_id)
       VALUES ('jc1', 'Maple St - unit 2 turn', ?, '2026-08-17T15:00:00.000Z', 'reported', NULL)`,
      WORKER_A,
    );
    await getDb().run(
      `INSERT INTO reported_issues (id, worker_user_id, property_reference, description, urgency, reported_at, status)
       VALUES ('ri1', ?, 'Maple St', 'Leaking faucet', 'normal', '2026-08-17T16:00:00.000Z', 'new')`,
      WORKER_A,
    );

    const result = await getWorkerActivityHistory({ worker: WORKER_A });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entries.map((e) => e.source)).toEqual([
      'worker_activity_log',
      'worker_time_events',
      'job_completions',
      'reported_issues',
    ]);
    // Chronological order preserved across sources.
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i].occurredAt >= result.entries[i - 1].occurredAt).toBe(true);
    }
  });

  it('honors a date range', async () => {
    await getDb().run(
      `INSERT INTO worker_activity_log (id, worker_user_id, activity_type, detail, occurred_at, source_message_id)
       VALUES ('al1', ?, 'note', 'in range', '2026-08-17T09:00:00.000Z', NULL)`,
      WORKER_A,
    );
    await getDb().run(
      `INSERT INTO worker_activity_log (id, worker_user_id, activity_type, detail, occurred_at, source_message_id)
       VALUES ('al2', ?, 'note', 'out of range', '2026-08-01T09:00:00.000Z', NULL)`,
      WORKER_A,
    );

    const result = await getWorkerActivityHistory({
      worker: WORKER_A,
      start: '2026-08-15T00:00:00.000Z',
      end: '2026-08-20T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].detail.detail).toBe('in range');
    }
  });

  it('property filter is exact for reported_issues and best-effort (flagged via caveats) elsewhere', async () => {
    await getDb().run(
      `INSERT INTO reported_issues (id, worker_user_id, property_reference, description, urgency, reported_at, status)
       VALUES ('ri1', ?, 'Maple St', 'Broken window', 'normal', '2026-08-17T16:00:00.000Z', 'new')`,
      WORKER_A,
    );
    await getDb().run(
      `INSERT INTO worker_activity_log (id, worker_user_id, activity_type, detail, occurred_at, source_message_id)
       VALUES ('al1', ?, 'note', 'Working at Maple St today', '2026-08-17T09:00:00.000Z', NULL)`,
      WORKER_A,
    );

    const result = await getWorkerActivityHistory({ property: 'Maple St' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((e) => e.source === 'reported_issues')?.propertyMatchType).toBe('exact');
    expect(result.entries.find((e) => e.source === 'worker_activity_log')?.propertyMatchType).toBe('best-effort-text');
    expect(result.caveats.length).toBeGreaterThan(0);
  });

  it('fails closed on an ambiguous worker name', async () => {
    await seedWorker('telegram:1000000003', 'Synthetic Alpha');
    const result = await getWorkerActivityHistory({ worker: 'Synthetic Alpha' });
    expect(result.ok).toBe(false);
  });
});
