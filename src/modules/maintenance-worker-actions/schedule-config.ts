/**
 * Reads the same schedule-config.json the container-side pre-task gate
 * script (groups/maintenance-coordinator/schedule-gate.mjs) reads --
 * single source of truth for which days/hours are ever in play. This
 * host-side copy exists because get_workday_status/mark_workday_active
 * run host-side (like every other tool apply handler) and need the same
 * day-type classification the gate script computes, independently
 * (the container has no path back into this process, and the host has
 * no path into the container's local file reads either -- both sides
 * just read the identical file from their own vantage point).
 *
 * Ported from old commit 824318ff, adapted: readScheduleConfig/
 * resolveTodayInfo/localDateOf remain pure sync fs/date logic
 * (unaffected by the async DB migration); recordWorkdayStatusCheck and
 * hasFreshWorkdayStatusCheck are adapted to the async DbDriver
 * (`await getDb().run/get`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';

export interface MaintenanceScheduleConfig {
  timezone: string;
  fixed_workdays: number[];
  conditional_workdays: Record<string, { enabled: boolean }>;
  work_start_hour: number;
  work_end_hour: number;
}

function scheduleConfigPath(): string {
  return path.join(GROUPS_DIR, 'maintenance-coordinator', 'schedule-config.json');
}

export function readScheduleConfig(): MaintenanceScheduleConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleConfigPath(), 'utf8')) as Record<string, unknown>;
    if (
      typeof raw.timezone !== 'string' ||
      !Array.isArray(raw.fixed_workdays) ||
      typeof raw.conditional_workdays !== 'object' ||
      raw.conditional_workdays === null ||
      typeof raw.work_start_hour !== 'number' ||
      typeof raw.work_end_hour !== 'number'
    ) {
      return null;
    }
    return raw as unknown as MaintenanceScheduleConfig;
  } catch {
    return null;
  }
}

export type DayType = 'fixed' | 'conditional' | 'off';

export interface TodayInfo {
  /** YYYY-MM-DD in the schedule's configured timezone -- never the container's or host's own local date. */
  date: string;
  /** ISO weekday, 1=Monday .. 7=Sunday. */
  weekday: number;
  hour: number;
  dayType: DayType;
}

const WEEKDAY_TO_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function resolveTodayInfo(config: MaintenanceScheduleConfig, now: Date): TodayInfo {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const weekday = WEEKDAY_TO_ISO[get('weekday')];
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some locales render midnight as "24"

  let dayType: DayType = 'off';
  if (weekday !== undefined) {
    if (config.fixed_workdays.includes(weekday)) dayType = 'fixed';
    else if (config.conditional_workdays[String(weekday)]?.enabled) dayType = 'conditional';
  }

  return { date, weekday, hour, dayType };
}

/**
 * Records that THIS session called get_workday_status and got a real
 * answer for `date` (the schedule's local date at call time). One row
 * per session -- a later call overwrites the date/timestamp rather than
 * accumulating history, since only "did this session check TODAY" ever
 * matters, never a full log of past checks.
 */
export async function recordWorkdayStatusCheck(sessionId: string, date: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO maintenance_workday_status_checks (session_id, work_date, checked_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET work_date = excluded.work_date, checked_at = excluded.checked_at`,
    sessionId,
    date,
    now,
  );
}

/**
 * How recently "fresh" means -- generous enough for one real turn (call
 * get_workday_status, then check one or two workers' activity) to
 * complete without re-checking per tool call, but far shorter than the
 * ~1 hour gap between real wake fires. This is deliberately a time
 * window, not "checked today" -- a session that checked once this
 * morning must NOT be considered fresh for the rest of the day. Each
 * real fire is a separate turn, separated by much more than this window,
 * so each one is structurally forced to re-check.
 */
const FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

/**
 * Has THIS session called get_workday_status fresh -- for `date`, and
 * recently, per FRESHNESS_WINDOW_MS -- right now? Used by
 * get_worker_activity to refuse answering on a conditional day until the
 * agent has actually re-verified the day's status THIS turn -- never
 * trusting that a confirmation seen earlier in a long-lived session
 * (even earlier the same day) still holds now.
 */
export async function hasFreshWorkdayStatusCheck(
  sessionId: string,
  date: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await getDb().get<{ work_date: string; checked_at: string }>(
    'SELECT work_date, checked_at FROM maintenance_workday_status_checks WHERE session_id = ?',
    sessionId,
  );
  if (!row || row.work_date !== date) return false;
  return now.getTime() - new Date(row.checked_at).getTime() <= FRESHNESS_WINDOW_MS;
}
