/**
 * get_workday_status -- what kind of day is today, and (for a
 * conditional day like Saturday) has it actually been confirmed active
 * yet. This is the first thing the scheduled wake -- or the agent
 * reasoning mid-conversation -- should check before doing anything
 * proactive about attendance.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/
 * recordWorkdayStatusCheck are now async (awaited); getDb().prepare/get
 * -> await getDb().get.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { readScheduleConfig, resolveTodayInfo, recordWorkdayStatusCheck } from './schedule-config.js';

export async function validateGetWorkdayStatus(
  _content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'get_workday_status failed: not permitted for this agent.');
    return false;
  }
  return true;
}

export async function applyGetWorkdayStatus(_payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('get_workday_status apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const config = readScheduleConfig();
  if (!config) {
    await notifyAgent(
      session,
      'get_workday_status: schedule is not configured yet -- treat today as unknown, do not assume it is a workday.',
    );
    return;
  }

  const today = resolveTodayInfo(config, new Date());

  // Unconditional, every call, every day type -- this is what
  // get_worker_activity checks before it will answer on a conditional
  // day. Recorded even for fixed/off days for consistency, though only
  // conditional days ever actually consult it.
  await recordWorkdayStatusCheck(session.id, today.date);

  if (today.dayType === 'off') {
    await notifyAgent(
      session,
      `Today (${today.date}) is not a scheduled workday and has not been marked active. Do not proactively ask about attendance.`,
    );
    return;
  }

  if (today.dayType === 'fixed') {
    await notifyAgent(session, `Today (${today.date}) is a normal scheduled workday.`);
    return;
  }

  // Conditional day -- check whether it's already been confirmed active.
  const confirmed = await getDb().get<{ confirmed_by: string; reason: string; confirmed_at: string }>(
    'SELECT confirmed_by, reason, confirmed_at FROM maintenance_confirmed_workdays WHERE work_date = ?',
    today.date,
  );

  if (confirmed) {
    await notifyAgent(
      session,
      `Today (${today.date}) is a conditional day that HAS been confirmed active (by ${confirmed.confirmed_by}, reason: ${confirmed.reason}). Treat it like a normal workday for the rest of today.`,
    );
  } else {
    await notifyAgent(
      session,
      `Today (${today.date}) is a conditional day (e.g. Saturday) that has NOT been confirmed active -- no evidence yet that anyone is working. Do not proactively ask Ivan or Elehazar whether they're coming in. If you find real evidence (Kirk says so, a worker checks in, a known assignment), call mark_workday_active.`,
    );
  }
}
