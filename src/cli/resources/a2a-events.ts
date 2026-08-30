/**
 * `ncl a2a-events [--since <cursor>] --json` — read-only activity feed over
 * the agent-to-agent seam, built for external dashboards (e.g. the governance
 * service) to poll via the standard `ncl` frame.
 *
 * Semantics:
 *   - Without `--since`: returns the current snapshot (agents + pending
 *     gates), empty event arrays, and `cursor` = the host's "now". Clients
 *     store the cursor and pass it back verbatim on the next poll.
 *   - With `--since <cursor>`: event arrays contain rows with ts > cursor;
 *     `cursor` advances to the max event ts seen (or echoes `--since` when
 *     nothing new happened).
 *
 * All timestamps are ISO-8601 UTC from the HOST clock — clients must compute
 * ages against `now`, never their own clock.
 *
 * Strictly read-only and best-effort: session DBs are opened read-only, one
 * pass over active sessions, sessions without an inbound.db are skipped, and
 * any per-session read failure degrades to "no events from that session"
 * rather than failing the whole call.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getContainerState, getProcessingClaims, openOutboundDb } from '../../mailbox/sqlite/session-db.js';
import { getActiveSessions, getPendingApprovalsByAction, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { A2A_MESSAGE_GATE_ACTION } from '../../modules/agent-to-agent/agent-route.js';
import { getMessagePolicy } from '../../modules/agent-to-agent/db/agent-message-policies.js';
import { heartbeatPath } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { register } from '../registry.js';

const GATE_PREVIEW_MAX = 120;

interface AgentSnapshot {
  id: string;
  name: string;
  folder: string;
  container_status: 'running' | 'stopped';
  /** null = no .heartbeat file for any of the agent's active sessions. */
  heartbeat_age_ms: number | null;
  /** From outbound.db container_state — best-effort, null when idle/unreadable. */
  current_tool: string | null;
  /** Preview of the in-flight message the agent claimed (processing_ack →
   *  messages_in) — the Slack home's Developer tab renders it as "working on
   *  now". Best-effort, null when idle. */
  current_work: string | null;
}

interface DeliveryEvent {
  ts: string;
  /** Source agent group id (via source_session_id, falling back to the row's platform_id). */
  from: string | null;
  to: string;
  /** Best-effort: true when the from→to edge currently has an approval policy. */
  was_gated: boolean;
  /** First ~120 chars of the message text — powers hover previews in the org chart. */
  preview: string;
}

interface ChannelOutEvent {
  ts: string;
  from: string;
  platform_id: string;
}

interface PendingGate {
  id: string;
  from: string;
  to: string;
  approver: string;
  created_at: string;
  preview: string;
}

interface RejectionEvent {
  ts: string;
  from: string;
  to: string;
}

interface EventBuckets {
  deliveries: DeliveryEvent[];
  channel_out: ChannelOutEvent[];
  rejections: RejectionEvent[];
}

/** A container is "alive" for snapshot purposes when running or idle. */
function isContainerAlive(session: Session): boolean {
  return session.container_status === 'running' || session.container_status === 'idle';
}

/** Normalize a DB timestamp (ISO or SQLite `datetime('now')`) to ISO-8601 UTC. */
function toIso(ts: string): string {
  if (ts.includes('T')) return ts;
  const parsed = new Date(`${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? ts : parsed.toISOString();
}

/**
 * ISO cursor → SQLite `datetime('now')` shape ('YYYY-MM-DD HH:MM:SS'), used
 * only as a COARSE SQL lower bound over `delivered_at`: new rows are ms-ISO
 * ('...T...Z' sorts above the space-separated shape for the same date), old
 * pre-migration rows are second-resolution SQLite format. The precise filter
 * is `toIso(delivered_at) > since` in JS.
 */
function isoToSqlUtc(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

/** Extract the human text from a message `content` column ({text: ...} JSON or raw string). */
function textOf(content: unknown): string {
  if (typeof content !== 'string') return '';
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Not JSON — the raw string IS the text.
  }
  return content;
}

function agentSnapshot(group: AgentGroup, sessions: Session[], nowMs: number): AgentSnapshot {
  const running = sessions.some(isContainerAlive);

  let heartbeatAge: number | null = null;
  for (const s of sessions) {
    try {
      const stat = fs.statSync(heartbeatPath(group.id, s.id));
      const age = Math.max(0, nowMs - stat.mtimeMs);
      if (heartbeatAge === null || age < heartbeatAge) heartbeatAge = age;
    } catch {
      // No .heartbeat file for this session — contributes nothing.
    }
  }

  // current_tool / current_work only make sense for a live container; a
  // stopped one would just surface stale rows. Best-effort: unreadable DBs →
  // null. current_work = preview of the in-flight message the agent claimed
  // (processing_ack → messages_in) — the Slack home's Developer tab renders
  // it as "working on now".
  let currentTool: string | null = null;
  let currentWork: string | null = null;
  if (running) {
    for (const s of sessions) {
      if (!isContainerAlive(s)) continue;
      if (!fs.existsSync(outboundDbPath(group.id, s.id))) continue;
      let claimedMessageId: string | null = null;
      try {
        const outDb = openOutboundDb(outboundDbPath(group.id, s.id));
        try {
          currentTool = getContainerState(outDb)?.current_tool ?? currentTool;
          claimedMessageId = getProcessingClaims(outDb)[0]?.message_id ?? null;
        } finally {
          outDb.close();
        }
      } catch (err) {
        log.debug('a2a-events: outbound.db unreadable for current_tool', { sessionId: s.id, err });
        continue;
      }
      if (claimedMessageId && !currentWork) {
        const inPath = inboundDbPath(group.id, s.id);
        if (fs.existsSync(inPath)) {
          try {
            const inDb = new Database(inPath, { readonly: true, fileMustExist: true });
            try {
              const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(claimedMessageId) as
                | { content: string }
                | undefined;
              if (row) {
                const text = textOf(row.content);
                currentWork = (text.length > GATE_PREVIEW_MAX ? text.slice(0, GATE_PREVIEW_MAX) : text) || null;
              }
            } finally {
              inDb.close();
            }
          } catch (err) {
            log.debug('a2a-events: inbound.db unreadable for current_work', { sessionId: s.id, err });
          }
        }
      }
      if (currentTool && currentWork) break;
    }
  }

  return {
    id: group.id,
    name: group.name,
    folder: group.folder,
    container_status: running ? 'running' : 'stopped',
    heartbeat_age_ms: heartbeatAge,
    current_tool: currentTool,
    current_work: currentWork,
  };
}

/**
 * Best-effort target for a rejection note: the note text (`Your
 * a2a_message_gate request was rejected…`) doesn't carry the target, so when
 * the source group has exactly one gated outgoing edge we attribute the
 * rejection to that edge; otherwise ''.
 *
 * Deliberately goes through the agent-to-agent module's own helper
 * (getMessagePolicy) rather than querying agent_message_policies directly, so
 * schema drift in that table surfaces in the owning module, not here. One
 * point lookup per agent group — fine at fleet sizes this feed serves.
 */
async function soleGatedTarget(fromAgentGroupId: string): Promise<string> {
  try {
    const groups = await getAllAgentGroups();
    const targets = (
      await Promise.all(
        groups.map(async (g) => ((await getMessagePolicy(fromAgentGroupId, g.id)) !== undefined ? g.id : null)),
      )
    ).filter((id): id is string => id !== null);
    return targets.length === 1 ? (targets[0] ?? '') : '';
  } catch {
    // agent-to-agent module tables absent — no gated edges to attribute.
    return '';
  }
}

async function collectPendingGates(): Promise<PendingGate[]> {
  let rows;
  try {
    rows = await getPendingApprovalsByAction(A2A_MESSAGE_GATE_ACTION);
  } catch {
    // approvals module tables absent — nothing can be held.
    return [];
  }

  return Promise.all(
    rows.filter((r) => r.status === 'pending').map(async (r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(r.payload) as Record<string, unknown>;
      } catch {
        // Malformed payload — emit the row with empty to/preview.
      }
      const from = (r.session_id ? (await getSession(r.session_id))?.agent_group_id : null) ?? r.agent_group_id ?? '';
      const to = typeof payload.platform_id === 'string' ? payload.platform_id : '';
      const text = textOf(payload.content);
      return {
        id: r.approval_id,
        from,
        to,
        approver: r.approver_user_id ?? '',
        created_at: r.created_at,
        preview: text.length > GATE_PREVIEW_MAX ? text.slice(0, GATE_PREVIEW_MAX) : text,
      };
    }),
  );
}

/**
 * One pass over a single session's inbound.db (and, for channel deliveries,
 * its outbound.db): a2a deliveries, gate-rejection notes, and channel-out
 * delivery confirmations with ts > since. Read-only; failures degrade to
 * "no events from this session".
 */
async function collectSessionEvents(session: Session, since: string, out: EventBuckets): Promise<void> {
  const inPath = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(inPath)) return;

  let db: Database.Database;
  try {
    db = new Database(inPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn('a2a-events: could not open inbound.db read-only', { sessionId: session.id, err });
    return;
  }

  try {
    db.pragma('busy_timeout = 5000');

    // ── a2a deliveries + gate-rejection notes (messages_in) ──
    // SELECT * so pre-migration DBs missing source_session_id still read.
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = db
        .prepare("SELECT * FROM messages_in WHERE channel_type = 'agent' AND timestamp > ? ORDER BY timestamp ASC")
        .all(since) as Array<Record<string, unknown>>;
    } catch (err) {
      log.warn('a2a-events: messages_in read failed', { sessionId: session.id, err });
    }

    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : '';
      const ts = toIso(typeof row.timestamp === 'string' ? row.timestamp : '');

      if (id.startsWith('a2a-')) {
        // Real a2a delivery written by performAgentRoute (system notes use
        // sys-* / appr-note-* ids on the same channel_type).
        const to = session.agent_group_id;
        let from: string | null = null;
        const sourceSessionId = typeof row.source_session_id === 'string' ? row.source_session_id : null;
        if (sourceSessionId) from = (await getSession(sourceSessionId))?.agent_group_id ?? null;
        if (!from && typeof row.platform_id === 'string') from = row.platform_id;
        if (from === to) continue; // self-injected note, not peer traffic
        const wasGated = from !== null && (await getMessagePolicy(from, to)) !== undefined;
        const text = textOf(row.content);
        out.deliveries.push({
          ts,
          from,
          to,
          was_gated: wasGated,
          preview: text.length > GATE_PREVIEW_MAX ? text.slice(0, GATE_PREVIEW_MAX) : text,
        });
      } else if (id.startsWith('appr-note-')) {
        // finalizeReject writes the note into the SOURCE session, so this
        // session's agent group is the rejected sender. The target rides in
        // the note's `a2a_target` field (finalize.ts); older notes without it
        // fall back to the sole-gated-edge guess.
        const text = textOf(row.content);
        if (text.includes('a2a_message_gate request was rejected')) {
          let target = '';
          if (typeof row.content === 'string') {
            try {
              const parsed = JSON.parse(row.content) as { a2a_target?: unknown };
              if (parsed && typeof parsed === 'object' && typeof parsed.a2a_target === 'string') {
                target = parsed.a2a_target;
              }
            } catch {
              // Raw-string note — no embedded target.
            }
          }
          out.rejections.push({
            ts,
            from: session.agent_group_id,
            to: target || (await soleGatedTarget(session.agent_group_id)),
          });
        }
      }
    }

    // ── agent → channel deliveries (delivered ⋈ messages_out) ──
    try {
      // Coarse SQL bound (over-inclusive across formats), then the precise
      // ms-ISO comparison in JS — same-second events must not be dropped.
      const delivered = db
        .prepare('SELECT * FROM delivered WHERE delivered_at >= ? ORDER BY delivered_at ASC')
        .all(isoToSqlUtc(since)) as Array<Record<string, unknown>>;
      const confirmed = delivered.filter(
        (d) =>
          (d.status ?? 'delivered') === 'delivered' &&
          toIso(typeof d.delivered_at === 'string' ? d.delivered_at : '') > since,
      );

      if (confirmed.length > 0 && fs.existsSync(outboundDbPath(session.agent_group_id, session.id))) {
        const outDb = openOutboundDb(outboundDbPath(session.agent_group_id, session.id));
        try {
          const lookup = outDb.prepare('SELECT channel_type, platform_id FROM messages_out WHERE id = ?');
          for (const d of confirmed) {
            const msg = lookup.get(String(d.message_out_id)) as
              | { channel_type: string | null; platform_id: string | null }
              | undefined;
            if (!msg || msg.channel_type === 'agent' || !msg.platform_id) continue;
            out.channel_out.push({
              ts: toIso(typeof d.delivered_at === 'string' ? d.delivered_at : ''),
              from: session.agent_group_id,
              platform_id: msg.platform_id,
            });
          }
        } finally {
          outDb.close();
        }
      }
    } catch (err) {
      log.warn('a2a-events: channel_out read failed', { sessionId: session.id, err });
    }
  } finally {
    db.close();
  }
}

register({
  name: 'a2a-events',
  description:
    'Read-only agent-to-agent activity feed for external dashboards: agents snapshot, a2a deliveries, held message gates, gate rejections, and agent→channel deliveries. Pass --since <cursor> (from a previous response) to tail events; omit it for a snapshot.',
  access: 'open',
  // Carries a resource name so group-scoped agents fail closed in dispatch
  // (feed spans every agent group). Host callers are unaffected.
  resource: 'a2a-events',
  parseArgs: (raw) => ({
    since: typeof raw.since === 'string' && raw.since.length > 0 ? raw.since : null,
  }),
  handler: async (args: { since: string | null }) => {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const sessions = await getActiveSessions();
    const byGroup = new Map<string, Session[]>();
    for (const s of sessions) {
      const bucket = byGroup.get(s.agent_group_id);
      if (bucket) bucket.push(s);
      else byGroup.set(s.agent_group_id, [s]);
    }

    const agents = (await getAllAgentGroups()).map((g) => agentSnapshot(g, byGroup.get(g.id) ?? [], nowMs));
    const pending_gates = await collectPendingGates();

    const buckets: EventBuckets = { deliveries: [], channel_out: [], rejections: [] };
    let cursor = args.since ?? now;

    if (args.since) {
      for (const s of sessions) await collectSessionEvents(s, args.since, buckets);
      const byTs = (a: { ts: string }, b: { ts: string }): number => a.ts.localeCompare(b.ts);
      buckets.deliveries.sort(byTs);
      buckets.channel_out.sort(byTs);
      buckets.rejections.sort(byTs);
      for (const list of [buckets.deliveries, buckets.channel_out, buckets.rejections]) {
        for (const e of list) if (e.ts > cursor) cursor = e.ts;
      }
    }

    return {
      now,
      cursor,
      agents,
      deliveries: buckets.deliveries,
      channel_out: buckets.channel_out,
      pending_gates,
      rejections: buckets.rejections,
    };
  },
});
