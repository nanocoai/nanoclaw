/**
 * record_time_event -- a worker clocking in or out. Writes an append-only
 * worker_time_events row (never updated/deleted -- a correction is a new
 * row referencing the original) and refreshes worker_state.clocked_in.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/
 * resolveActingWorkerUserId are now async (awaited); getDb().prepare/run
 * -> await getDb().run.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { resolveActingWorkerUserId } from './identity.js';

interface TimeEventPayload {
  event_type: 'clock_in' | 'clock_out';
  note?: string;
  source_message_id?: string;
}

function isValid(p: unknown): p is TimeEventPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (row.event_type !== 'clock_in' && row.event_type !== 'clock_out') return false;
  if (row.note !== undefined && typeof row.note !== 'string') return false;
  if (row.source_message_id !== undefined && typeof row.source_message_id !== 'string') return false;
  return true;
}

export async function validateRecordTimeEvent(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'record_time_event failed: not permitted for this agent.');
    return false;
  }
  if (!isValid(content.event)) {
    await notifyAgent(session, "record_time_event failed: event.event_type must be 'clock_in' or 'clock_out'.");
    return false;
  }
  return true;
}

export async function applyRecordTimeEvent(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('record_time_event apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const event = payload.event as TimeEventPayload;
  const identity = await resolveActingWorkerUserId(session, event.source_message_id);
  if (!identity.ok || !identity.userId) {
    await notifyAgent(session, `record_time_event failed: ${identity.reason}`);
    return;
  }
  const workerUserId = identity.userId;

  const now = new Date().toISOString();
  const db = getDb();

  await db.run(
    `INSERT INTO worker_time_events (id, worker_user_id, event_type, occurred_at, recorded_at, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    workerUserId,
    event.event_type,
    now,
    now,
    event.note ?? '',
  );

  await db.run(
    `INSERT INTO worker_state (worker_user_id, clocked_in, last_activity_at)
     VALUES (?, ?, ?)
     ON CONFLICT(worker_user_id) DO UPDATE SET clocked_in = excluded.clocked_in, last_activity_at = excluded.last_activity_at`,
    workerUserId,
    event.event_type === 'clock_in' ? 1 : 0,
    now,
  );

  await notifyAgent(session, `Recorded: ${event.event_type === 'clock_in' ? 'clocked in' : 'clocked out'} at ${now}.`);
  log.info('record_time_event: applied', { workerUserId, eventType: event.event_type });
}
