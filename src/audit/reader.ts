/** PostgreSQL newest-first reader used by `ncl audit list` and NDJSON output. */
import { AUDIT_ENABLED } from './config.js';
import { getAuditStore, type AuditStore } from './store.js';
import type { AuditEvent, AuditOutcome } from './types.js';

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failure', 'denied', 'pending', 'approved']);
const DEFAULT_LIMIT = 100;
const PAGE_SIZE = 256;

export interface AuditQuery {
  actor?: string;
  action?: string;
  resource?: string;
  outcome?: AuditOutcome;
  sinceMs?: number;
  untilMs?: number;
  correlation?: string;
  limit: number;
}

export function parseTimeFlag(value: string, flag: string): number {
  const relative = /^(\d+)([dhm])$/.exec(value);
  if (relative) {
    const count = Number(relative[1]);
    const unitMs = relative[2] === 'd' ? 86_400_000 : relative[2] === 'h' ? 3_600_000 : 60_000;
    return Date.now() - count * unitMs;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}T[\d.:]+$/.test(value) ? `${value}Z` : value;
  const absolute = Date.parse(normalized);
  if (!Number.isNaN(absolute)) return absolute;
  throw new Error(`invalid ${flag} value "${value}" — use e.g. 7d, 24h, 30m, or an ISO date`);
}

function matches(event: AuditEvent, query: AuditQuery): boolean {
  const dimensions = event.dimensions ?? {};
  if (query.actor !== undefined && event.actor?.id !== query.actor) return false;
  if (
    query.action !== undefined &&
    dimensions.action !== query.action &&
    !dimensions.action?.startsWith(`${query.action}.`)
  ) return false;
  if (query.outcome !== undefined && dimensions.outcome !== query.outcome) return false;
  if (query.correlation !== undefined && dimensions.correlation_id !== query.correlation) return false;
  if (query.resource !== undefined) {
    const hit = (dimensions.resource_refs ?? []).some(
      (ref) => ref === query.resource || ref.startsWith(`${query.resource}:`) || ref.endsWith(`:${query.resource}`),
    );
    if (!hit) return false;
  }
  const timestamp = Date.parse(event.occurred_at);
  if (query.sinceMs !== undefined && !(timestamp >= query.sinceMs)) return false;
  if (query.untilMs !== undefined && !(timestamp <= query.untilMs)) return false;
  return true;
}

export async function queryAuditEvents(
  query: AuditQuery,
  store: AuditStore = getAuditStore(),
): Promise<{ events: AuditEvent[]; lines: string[] }> {
  const events: AuditEvent[] = [];
  const lines: string[] = [];
  let beforeSeq: number | null = null;

  while (events.length < query.limit) {
    const rows = await store.readNewest(beforeSeq, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      beforeSeq = row.event.seq;
      if (!matches(row.event, query)) continue;
      events.push(row.event);
      lines.push(row.line);
      if (events.length >= query.limit) break;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { events, lines };
}

export async function listAuditEvents(
  args: Record<string, unknown>,
  store: AuditStore = getAuditStore(),
): Promise<string | Array<Record<string, unknown>>> {
  if (!AUDIT_ENABLED) throw new Error('audit log is disabled — set AUDIT_ENABLED=true');
  const format = args.format !== undefined ? String(args.format) : '';
  if (format && format !== 'ndjson') throw new Error(`invalid --format "${format}" — only "ndjson" is supported`);
  const outcome = args.outcome !== undefined ? String(args.outcome) : undefined;
  if (outcome !== undefined && !OUTCOMES.has(outcome)) {
    throw new Error(`invalid --outcome "${outcome}" — one of: ${[...OUTCOMES].join(', ')}`);
  }
  let limit: number;
  if (args.limit !== undefined) {
    const parsed = Number(args.limit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`invalid --limit "${String(args.limit)}" — use a non-negative integer`);
    }
    limit = parsed;
  } else {
    limit = format === 'ndjson' ? Number.MAX_SAFE_INTEGER : DEFAULT_LIMIT;
  }
  const query: AuditQuery = {
    actor: args.actor !== undefined ? String(args.actor) : undefined,
    action: args.action !== undefined ? String(args.action) : undefined,
    resource: args.resource !== undefined ? String(args.resource) : undefined,
    outcome: outcome as AuditOutcome | undefined,
    correlation: args.correlation !== undefined ? String(args.correlation) : undefined,
    sinceMs: args.since !== undefined ? parseTimeFlag(String(args.since), '--since') : undefined,
    untilMs: args.until !== undefined ? parseTimeFlag(String(args.until), '--until') : undefined,
    limit,
  };
  const { events, lines } = await queryAuditEvents(query, store);
  if (format === 'ndjson') return lines.join('\n');
  return events.map((event) => ({
    time: event.occurred_at,
    actor: event.actor?.id ?? '',
    action: event.dimensions.action ?? event.event_type,
    resources: (event.dimensions.resource_refs ?? []).join(' '),
    outcome: event.dimensions.outcome ?? '',
    correlation: event.dimensions.correlation_id ?? '',
    event_id: event.event_id,
    seq: event.seq,
  }));
}
