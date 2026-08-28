/**
 * get_worker_activity -- read-only, single-worker operational status:
 * clocked-in state, most recent time event, last reported
 * location/job, and whether there's been any activity today. This is
 * what "has Ivan checked in yet" / "is my picture of Elehazar stale"
 * actually requires -- get_worker_info deliberately only returns static
 * attributes (language/role/transport), and query_maintenance_status
 * (the all-workers summary) is deliberately Pepper-only. This tool is
 * the missing single-worker equivalent for Maintenance Coordinator
 * itself: one worker at a time, read-only, no admin action, no
 * cross-worker dump, no access to any conversation content.
 *
 * "No data yet today" and "no data ever" are reported as distinct,
 * explicit, unknown-labeled facts -- never inferred as good or bad.
 * Durable state (worker_state / worker_time_events) is always the
 * answer; this tool exists precisely so the agent never has to fall
 * back on conversational memory to judge activity/staleness.
 *
 * 2026-08-16 correction: activityToday was computed by slicing the raw
 * UTC timestamp's YYYY-MM-DD substring and comparing it directly to
 * "today" (which is correctly computed in the schedule's configured
 * timezone). Near midnight UTC -- which is still evening in Eastern
 * Time -- these two dates disagree, so a same-day event got reported as
 * "NOT today" while the structured clocked_in/last_activity_at fields
 * correctly showed it. Fix: every date compared against "today" is now
 * resolved through the exact same timezone-aware path (resolveTodayInfo,
 * already DST-safe via Intl.DateTimeFormat on the IANA zone name -- never
 * a hardcoded UTC offset). All facts are also now computed once into a
 * single object and every sentence in the reply is mechanically derived
 * from that same object -- there is no second place a contradiction
 * could be introduced.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/findWorker/
 * hasFreshWorkdayStatusCheck are now async (awaited; findWorker returns
 * { ok, worker, reason }); getDb().prepare/get -> await getDb().get.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { findWorker } from './identity.js';
import {
  readScheduleConfig,
  resolveTodayInfo,
  hasFreshWorkdayStatusCheck,
  type MaintenanceScheduleConfig,
} from './schedule-config.js';

interface ActivityPayload {
  worker: string;
}

function isValid(p: unknown): p is ActivityPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  return typeof row.worker === 'string' && row.worker.trim().length > 0;
}

export async function validateGetWorkerActivity(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'get_worker_activity failed: not permitted for this agent.');
    return false;
  }
  if (!isValid(content.query)) {
    await notifyAgent(session, 'get_worker_activity failed: query.worker is required (a worker name).');
    return false;
  }
  return true;
}

interface WorkerStateRow {
  clocked_in: number;
  current_location_reported: string | null;
  current_location_reported_at: string | null;
  active_job_reference: string | null;
  last_activity_at: string;
}

interface TimeEventRow {
  event_type: string;
  occurred_at: string;
}

/**
 * The local calendar date (YYYY-MM-DD) an ISO timestamp falls on, in the
 * schedule's configured timezone -- NEVER the raw UTC date substring.
 * Reuses resolveTodayInfo (the same DST-safe Intl.DateTimeFormat path
 * "today" itself is computed through) so an event timestamp and "today"
 * are always resolved identically. Falls back to the UTC date substring
 * only when the schedule genuinely has no configured timezone -- a
 * degraded-but-consistent fallback, not silent guessing.
 */
export function localDateOf(config: MaintenanceScheduleConfig | null, isoTimestamp: string): string {
  if (config) return resolveTodayInfo(config, new Date(isoTimestamp)).date;
  return isoTimestamp.slice(0, 10);
}

export interface WorkerActivityFacts {
  workerName: string;
  clockedIn: 'yes' | 'no' | 'unknown';
  lastEventType: string | null;
  lastEventAt: string | null;
  lastLocation: string | null;
  lastLocationAt: string | null;
  activeJobReference: string | null;
  lastActivityAt: string | null;
  /** Computed once, here, from lastActivityAt vs. today -- both resolved through localDateOf/resolveTodayInfo in the same timezone. Every downstream sentence must read this field, never re-derive its own notion of "today". */
  activityToday: boolean;
}

/**
 * Pure formatter: every sentence is mechanically derived from `facts`,
 * with no independent logic of its own -- this is what guarantees the
 * structured facts and the human-readable summary can never contradict
 * each other. If a future field is added, add it here and nowhere else.
 */
export function formatActivityFacts(facts: WorkerActivityFacts): string {
  const parts: string[] = [];
  parts.push(`${facts.workerName}:`);
  parts.push(`clocked_in=${facts.clockedIn}${facts.clockedIn === 'unknown' ? ' (no worker_state row yet)' : ''}`);
  parts.push(
    facts.lastEventType && facts.lastEventAt
      ? `last time event: ${facts.lastEventType} at ${facts.lastEventAt}`
      : 'last time event: none recorded',
  );
  parts.push(
    facts.lastLocation
      ? `last reported location: "${facts.lastLocation}" at ${facts.lastLocationAt}`
      : 'last reported location: none recorded',
  );
  parts.push(
    facts.activeJobReference
      ? `active job reference: ${facts.activeJobReference}`
      : 'active job reference: none recorded',
  );
  parts.push(`last_activity_at: ${facts.lastActivityAt ?? 'none recorded'}`);
  parts.push(
    facts.activityToday
      ? "HAS had recorded activity today (in the schedule's own timezone)."
      : 'has NOT had any recorded activity yet today -- this is a real signal, not a gap in your data.',
  );
  return parts.join(' ');
}

export async function applyGetWorkerActivity(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('get_worker_activity apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const config = readScheduleConfig();
  const todayInfo = config ? resolveTodayInfo(config, new Date()) : null;

  // Structural freshness gate: on a conditional day, worker activity is
  // never evaluated until THIS session has actually re-checked
  // get_workday_status for TODAY -- a confirmation seen earlier in a
  // long-lived session's own history is not enough, and this is checked
  // in code, not left to the agent remembering to call it first. Fixed
  // and off days have no confirmation to go stale, so they skip this.
  if (todayInfo?.dayType === 'conditional' && !(await hasFreshWorkdayStatusCheck(session.id, todayInfo.date))) {
    await notifyAgent(
      session,
      `get_worker_activity failed: today (${todayInfo.date}) is a conditional day and this conversation hasn't freshly checked get_workday_status yet today -- call that first, before checking any worker's activity. A confirmation you saw earlier in this same conversation does not carry over to a new day.`,
    );
    return;
  }

  const query = payload.query as ActivityPayload;
  const found = await findWorker(query.worker);
  if (!found.ok || !found.worker) {
    await notifyAgent(session, `get_worker_activity: no known worker matches "${query.worker}".`);
    return;
  }
  const worker = found.worker;

  const db = getDb();
  const state = await db.get<WorkerStateRow>(
    'SELECT clocked_in, current_location_reported, current_location_reported_at, active_job_reference, last_activity_at FROM worker_state WHERE worker_user_id = ?',
    worker.user_id,
  );
  const lastEvent = await db.get<TimeEventRow>(
    'SELECT event_type, occurred_at FROM worker_time_events WHERE worker_user_id = ? ORDER BY occurred_at DESC LIMIT 1',
    worker.user_id,
  );

  if (!state && !lastEvent) {
    await notifyAgent(
      session,
      `${worker.name}: no activity ever recorded (unknown, not "not working" -- nobody has clocked in, reported status, or been asked about yet). No data to judge staleness or today's check-in against.`,
    );
    return;
  }

  const today = todayInfo?.date ?? new Date().toISOString().slice(0, 10);
  const lastActivityAt = state?.last_activity_at ?? lastEvent?.occurred_at ?? null;
  const activityToday = lastActivityAt !== null && localDateOf(config, lastActivityAt) === today;

  const facts: WorkerActivityFacts = {
    workerName: worker.name,
    clockedIn: state ? (state.clocked_in ? 'yes' : 'no') : 'unknown',
    lastEventType: lastEvent?.event_type ?? null,
    lastEventAt: lastEvent?.occurred_at ?? null,
    lastLocation: state?.current_location_reported ?? null,
    lastLocationAt: state?.current_location_reported_at ?? null,
    activeJobReference: state?.active_job_reference ?? null,
    lastActivityAt,
    activityToday,
  };

  await notifyAgent(session, formatActivityFacts(facts));
  log.info('get_worker_activity: applied', { workerUserId: worker.user_id, activityToday });
}
