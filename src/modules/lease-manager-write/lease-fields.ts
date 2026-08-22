/**
 * Lease-field resolution: three-state semantics (absent = untouched, null =
 * clear, value = set), status-driven defaults, and the "must show every
 * change" approval-card line builder. Pure functions, no I/O -- request.ts
 * supplies the existing (pre-write) values it reads from the live sheet.
 *
 * This is the single place these rules live. apply.ts and the .ps1 writer
 * only ever see the fully-resolved output of resolveLeaseFields(); neither
 * re-derives status-driven defaults or reminder dates.
 *
 * Ported verbatim from old commit 59de60dc -- pure functions, no DB access,
 * nothing to adapt for the async DB migration.
 */

export type LeaseStatus = 'Fixed Term' | 'Month-to-Month' | 'Vacant';
const VALID_LEASE_STATUS = new Set<string>(['Fixed Term', 'Month-to-Month', 'Vacant']);

export interface RawLeaseRow {
  // Only the four fields this module resolves. Present-but-undefined and
  // absent are the same in JS object semantics, so callers must use
  // `key in row` (via has()) to distinguish "field omitted" from "field
  // explicitly null" -- do not destructure these with default values.
  LeaseStartDate?: string | null;
  LeaseEndDate?: string | null;
  LeaseReminderDate?: string | null;
  LeaseStatus?: LeaseStatus | null;
}

export type ResolvedLeaseFields = Partial<{
  LeaseStartDate: string | null;
  LeaseEndDate: string | null;
  LeaseReminderDate: string | null;
  LeaseStatus: LeaseStatus | null;
}>;

export interface ExistingLeaseFields {
  LeaseStartDate: string | null;
  LeaseEndDate: string | null;
  LeaseReminderDate: string | null;
  LeaseStatus: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Format check + real-calendar-date check (rejects e.g. 2026-02-30), UTC-anchored to avoid timezone day-shift. */
export function isValidDateString(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDaysUTC(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function has(row: RawLeaseRow, key: keyof RawLeaseRow): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

export class LeaseFieldValidationError extends Error {}

/**
 * Resolve one row's lease fields against 3-state input + status-driven
 * defaults. Throws LeaseFieldValidationError for the one hard rule (Fixed
 * Term requires an explicit end date in the same row) -- everything else
 * ("only set Month-to-Month when Kirk says so") is a process rule enforced
 * by the approval card being visible, not something checkable from data
 * alone.
 *
 * Returned object only contains keys that are actually being touched --
 * exactly the 3-state contract the .ps1 writer and the verifier depend on.
 */
export function resolveLeaseFields(raw: RawLeaseRow): ResolvedLeaseFields {
  const resolved: ResolvedLeaseFields = {};

  if (has(raw, 'LeaseStatus') && raw.LeaseStatus === 'Fixed Term') {
    if (!has(raw, 'LeaseEndDate') || raw.LeaseEndDate === null) {
      throw new LeaseFieldValidationError(
        'Fixed Term requires an explicitly supplied Lease End Date in the same row -- never inferred.',
      );
    }
  }

  const settingM2M = has(raw, 'LeaseStatus') && raw.LeaseStatus === 'Month-to-Month';
  const settingVacant = has(raw, 'LeaseStatus') && raw.LeaseStatus === 'Vacant';

  // Lease Start Date: pure passthrough; Vacant clears it by default (no
  // tenant-specific info should remain), Month-to-Month keeps it untouched
  // by default ("keep Start Date unless instructed otherwise").
  if (has(raw, 'LeaseStartDate')) {
    resolved.LeaseStartDate = raw.LeaseStartDate ?? null;
  } else if (settingVacant) {
    resolved.LeaseStartDate = null;
  }

  // Lease End Date: pure passthrough; both Month-to-Month and Vacant clear
  // it by default unless the row explicitly overrides.
  if (has(raw, 'LeaseEndDate')) {
    resolved.LeaseEndDate = raw.LeaseEndDate ?? null;
  } else if (settingM2M || settingVacant) {
    resolved.LeaseEndDate = null;
  }

  // Lease Reminder Date: explicit override always wins. Otherwise, only
  // touched when End Date is also being touched in this resolved plan --
  // derived (End Date - 60 days) when set to a real date, cleared when End
  // Date is being cleared, left alone when End Date isn't part of this row.
  if (has(raw, 'LeaseReminderDate')) {
    resolved.LeaseReminderDate = raw.LeaseReminderDate ?? null;
  } else if ('LeaseEndDate' in resolved) {
    const endDate = resolved.LeaseEndDate ?? null;
    resolved.LeaseReminderDate = endDate === null ? null : addDaysUTC(endDate, -60);
  }

  if (has(raw, 'LeaseStatus')) {
    resolved.LeaseStatus = raw.LeaseStatus ?? null;
  }

  return resolved;
}

const FIELD_LABELS: Record<keyof ResolvedLeaseFields, string> = {
  LeaseStartDate: 'Lease Start Date',
  LeaseEndDate: 'Lease End Date',
  LeaseReminderDate: 'Lease Reminder Date',
  LeaseStatus: 'Lease Status',
};

/**
 * One "field: before → after" line per touched field whose resolved value
 * actually differs from the existing sheet value. Untouched fields (absent
 * from `resolved`) never produce a line. A resolved value of null against a
 * non-null existing value renders as "(cleared)", matching the requirement
 * that every clear is explicitly visible on the approval card.
 */
export function buildLeaseChangeLines(resolved: ResolvedLeaseFields, existing: ExistingLeaseFields | null): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(resolved) as (keyof ResolvedLeaseFields)[]) {
    const newVal = resolved[key] ?? null;
    const oldVal = existing ? (existing[key] ?? null) : null;
    if (newVal === oldVal) continue;
    const oldDisplay = oldVal ?? '(none)';
    const newDisplay = newVal === null ? '(cleared)' : newVal;
    lines.push(`${FIELD_LABELS[key]}: ${oldDisplay} → ${newDisplay}`);
  }
  return lines;
}

export function isValidLeaseStatus(v: unknown): v is LeaseStatus {
  return typeof v === 'string' && VALID_LEASE_STATUS.has(v);
}
