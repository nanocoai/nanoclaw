/**
 * record_key_binder_custody -- a worker (or Kirk, relayed via Pepper's a2a
 * message to Maintenance Coordinator) reporting who currently has one of
 * the three portable key binders. Writes an append-only audit event and
 * refreshes the current-state snapshot. Deliberately minimal: no
 * matching/reasoning logic here, no assumption that an unreported binder
 * is at its home location -- that's why key_binder_state defaults to
 * 'unknown' and stays there until something explicit is reported.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/
 * resolveActingWorkerUserId/findWorker are now async (awaited; findWorker
 * returns { ok, worker, reason }); getDb().prepare/get/run -> await
 * getDb().get/run.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { findWorker, resolveActingWorkerUserId } from './identity.js';

interface CustodyPayload {
  binder: string;
  holder_type: 'office' | 'kirk' | 'worker' | 'other' | 'unknown';
  holder_worker?: string;
  holder_note?: string;
  note?: string;
  source_message_id?: string;
}

const VALID_HOLDER_TYPES = ['office', 'kirk', 'worker', 'other', 'unknown'];

function isValid(p: unknown): p is CustodyPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.binder !== 'string' || !row.binder.trim()) return false;
  if (typeof row.holder_type !== 'string' || !VALID_HOLDER_TYPES.includes(row.holder_type)) return false;
  if (row.holder_worker !== undefined && typeof row.holder_worker !== 'string') return false;
  if (row.holder_note !== undefined && typeof row.holder_note !== 'string') return false;
  if (row.note !== undefined && typeof row.note !== 'string') return false;
  if (row.source_message_id !== undefined && typeof row.source_message_id !== 'string') return false;
  return true;
}

export async function validateRecordKeyBinderCustody(
  content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'record_key_binder_custody failed: not permitted for this agent.');
    return false;
  }
  if (!isValid(content.custody)) {
    await notifyAgent(
      session,
      "record_key_binder_custody failed: custody.binder and a valid holder_type ('office'|'kirk'|'worker'|'other'|'unknown') are required.",
    );
    return false;
  }
  return true;
}

export async function applyRecordKeyBinderCustody(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('record_key_binder_custody apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const custody = payload.custody as CustodyPayload;
  const identity = await resolveActingWorkerUserId(session, custody.source_message_id);
  if (!identity.ok || !identity.userId) {
    await notifyAgent(session, `record_key_binder_custody failed: ${identity.reason}`);
    return;
  }
  const db = getDb();

  const binder = await db.get<{ id: string }>('SELECT id FROM key_binders WHERE lower(label) = lower(?)', custody.binder);
  if (!binder) {
    await notifyAgent(session, `record_key_binder_custody failed: no known binder matches "${custody.binder}".`);
    return;
  }

  let holderWorkerId: string | null = null;
  if (custody.holder_type === 'worker') {
    if (!custody.holder_worker) {
      await notifyAgent(
        session,
        'record_key_binder_custody failed: holder_worker is required when holder_type is "worker".',
      );
      return;
    }
    const found = await findWorker(custody.holder_worker);
    if (!found.ok || !found.worker) {
      await notifyAgent(session, `record_key_binder_custody failed: no known worker matches "${custody.holder_worker}".`);
      return;
    }
    holderWorkerId = found.worker.user_id;
  }

  const reportedBy = identity.userId;
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO key_binder_custody_events (id, binder_id, holder_type, holder_worker_id, holder_note, changed_at, recorded_at, reported_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    binder.id,
    custody.holder_type,
    holderWorkerId,
    custody.holder_note ?? '',
    now,
    now,
    reportedBy,
    custody.note ?? '',
  );

  await db.run(
    `INSERT INTO key_binder_state (binder_id, holder_type, holder_worker_id, holder_note, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(binder_id) DO UPDATE SET
       holder_type = excluded.holder_type,
       holder_worker_id = excluded.holder_worker_id,
       holder_note = excluded.holder_note,
       updated_at = excluded.updated_at`,
    binder.id,
    custody.holder_type,
    holderWorkerId,
    custody.holder_note ?? '',
    now,
  );

  await notifyAgent(
    session,
    `Recorded: ${custody.binder} is now with ${custody.holder_type === 'worker' ? holderWorkerId : custody.holder_type}.`,
  );
  log.info('record_key_binder_custody: applied', { binderId: binder.id, holderType: custody.holder_type, reportedBy });
}
