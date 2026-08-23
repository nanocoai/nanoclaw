/**
 * mark_workday_active -- records that a conditional day (Saturday, or
 * any other non-fixed day) is actually an active workday today, with
 * why. Idempotent (upsert by date) so calling it more than once for the
 * same evidence is harmless. The date is always resolved here from real
 * time in the schedule's own configured timezone -- never taken from
 * the agent's own claim, so there's no way to backdate or misdate this.
 *
 * confirmed_by is an audit trail, not an access-control decision, so
 * unlike the strict worker-action resolver this tolerates being called
 * from the scheduled-wake's own system session (no messaging group at
 * all) as well as from a live chat -- either way, if a real sender is
 * resolvable it's used; otherwise the wake itself is recorded as the
 * source, which is legitimate provenance for "the agent noticed this
 * itself from worker state, e.g. a check-in."
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/
 * resolveActingWorkerUserId are now async (awaited); getDb().prepare/run
 * -> await getDb().run.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { resolveActingWorkerUserId } from './identity.js';
import { readScheduleConfig, resolveTodayInfo } from './schedule-config.js';

interface MarkActivePayload {
  reason: string;
  source_message_id?: string;
}

function isValid(p: unknown): p is MarkActivePayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (typeof row.reason !== 'string' || !row.reason.trim()) return false;
  if (row.source_message_id !== undefined && typeof row.source_message_id !== 'string') return false;
  return true;
}

export async function validateMarkWorkdayActive(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'mark_workday_active failed: not permitted for this agent.');
    return false;
  }
  if (!isValid(content.confirmation)) {
    await notifyAgent(
      session,
      'mark_workday_active failed: confirmation.reason is required (why today counts as an active workday).',
    );
    return false;
  }
  return true;
}

async function resolveConfirmedBy(session: Session, sourceMessageId?: string): Promise<string> {
  const identity = await resolveActingWorkerUserId(session, sourceMessageId);
  if (identity.ok && identity.userId) return identity.userId;
  return 'pepper-scheduled-wake';
}

export async function applyMarkWorkdayActive(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('mark_workday_active apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const confirmation = payload.confirmation as MarkActivePayload;

  const config = readScheduleConfig();
  if (!config) {
    await notifyAgent(session, 'mark_workday_active failed: schedule is not configured yet.');
    return;
  }
  const today = resolveTodayInfo(config, new Date());

  const confirmedBy = await resolveConfirmedBy(session, confirmation.source_message_id);
  const now = new Date().toISOString();

  await getDb().run(
    `INSERT INTO maintenance_confirmed_workdays (work_date, confirmed_by, reason, confirmed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(work_date) DO UPDATE SET confirmed_by = excluded.confirmed_by, reason = excluded.reason, confirmed_at = excluded.confirmed_at`,
    today.date,
    confirmedBy,
    confirmation.reason,
    now,
  );

  await notifyAgent(
    session,
    `Marked ${today.date} as an active workday (${confirmation.reason}). Treat it like a normal workday for the rest of today.`,
  );
  log.info('mark_workday_active: applied', { date: today.date, confirmedBy, reason: confirmation.reason });
}
