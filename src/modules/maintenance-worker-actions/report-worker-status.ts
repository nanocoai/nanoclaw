/**
 * report_worker_status -- a worker reporting their own location/transport
 * status, OR reporting it on behalf of a co-worker they're transporting
 * (e.g. Elehazar: "dropping Ivan at Edgewood, heading to Lowe's" updates
 * both his own state and Ivan's). Writes worker_activity_log (durable
 * history) and refreshes worker_state (current snapshot).
 *
 * Data capture only -- no dispatch/scheduling logic here. Whether a
 * pattern is worth flagging (e.g. a worker riding around who could be
 * working) is the agent's own reasoning, guided by instructions, using
 * what this records.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent/
 * resolveActingWorkerUserId/findWorker/findPropertyByFreeText/
 * getLatestTrelloSuggestion/recordTrelloSuggestion are all now async
 * (awaited; findWorker returns { ok, worker, reason }); getDb().prepare/
 * get/run -> await getDb().get/run.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { findWorker, resolveActingWorkerUserId } from './identity.js';
import { findPropertyByFreeText } from './properties.js';
import {
  getLatestTrelloSuggestion,
  propertyDestinationKey,
  rawDestinationKey,
  recordTrelloSuggestion,
} from './trello-suggestion-log.js';

interface TrelloSuggestionShown {
  /** The dedup key from the property-match info this same tool already surfaced -- `property:<id>` for a resolved property, `raw:<normalized text>` when nothing matched. Always required; this, not property_id, is what dedup is keyed on. */
  destination_key: string;
  /** The resolved property id, when there was one -- kept for auditing/future property intelligence, never used for dedup. Omit for a raw-text (unmatched) destination. */
  property_id?: string;
  card_ids: string[];
}

interface StatusPayload {
  /** Defaults to the reporting worker themself if omitted. */
  about_worker?: string;
  location?: string;
  active_job_reference?: string;
  transport_mode?: 'self_driven' | 'transported';
  transported_by?: string;
  awaiting_pickup?: boolean;
  note?: string;
  source_message_id?: string;
  /**
   * Set this on its own (location/etc. can be omitted) right after you've
   * actually told the worker about relevant Trello cards at their
   * destination -- records what was shown so the same suggestion isn't
   * repeated next time nothing's changed. Never set this preemptively;
   * only after the suggestion was actually delivered.
   */
  trello_suggestion_shown?: TrelloSuggestionShown;
}

function isValidTrelloSuggestionShown(v: unknown): v is TrelloSuggestionShown {
  if (typeof v !== 'object' || v === null) return false;
  const row = v as Record<string, unknown>;
  if (typeof row.destination_key !== 'string' || !row.destination_key) return false;
  if (row.property_id !== undefined && (typeof row.property_id !== 'string' || !row.property_id)) return false;
  if (!Array.isArray(row.card_ids) || !row.card_ids.every((c) => typeof c === 'string')) return false;
  return true;
}

function isValid(p: unknown): p is StatusPayload {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (row.about_worker !== undefined && typeof row.about_worker !== 'string') return false;
  if (row.location !== undefined && typeof row.location !== 'string') return false;
  if (row.active_job_reference !== undefined && typeof row.active_job_reference !== 'string') return false;
  if (row.transport_mode !== undefined && row.transport_mode !== 'self_driven' && row.transport_mode !== 'transported')
    return false;
  if (row.transported_by !== undefined && typeof row.transported_by !== 'string') return false;
  if (row.awaiting_pickup !== undefined && typeof row.awaiting_pickup !== 'boolean') return false;
  if (row.note !== undefined && typeof row.note !== 'string') return false;
  if (row.source_message_id !== undefined && typeof row.source_message_id !== 'string') return false;
  if (row.trello_suggestion_shown !== undefined && !isValidTrelloSuggestionShown(row.trello_suggestion_shown))
    return false;
  return true;
}

export async function validateReportWorkerStatus(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'report_worker_status failed: not permitted for this agent.');
    return false;
  }
  if (!isValid(content.status)) {
    await notifyAgent(session, 'report_worker_status failed: malformed status payload.');
    return false;
  }
  return true;
}

export async function applyReportWorkerStatus(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('report_worker_status apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const status = payload.status as StatusPayload;
  const identity = await resolveActingWorkerUserId(session, status.source_message_id);
  if (!identity.ok || !identity.userId) {
    await notifyAgent(session, `report_worker_status failed: ${identity.reason}`);
    return;
  }
  const reporterUserId = identity.userId;

  let subjectUserId = reporterUserId;
  if (status.about_worker) {
    const found = await findWorker(status.about_worker);
    if (!found.ok || !found.worker) {
      await notifyAgent(session, `report_worker_status failed: no known worker matches "${status.about_worker}".`);
      return;
    }
    subjectUserId = found.worker.user_id;
  }

  // Resolve transported_by by name too, if given.
  let transportedBy: string | null = null;
  if (status.transported_by) {
    const found = await findWorker(status.transported_by);
    transportedBy = found.ok && found.worker ? found.worker.user_id : status.transported_by;
  }

  const now = new Date().toISOString();
  const db = getDb();

  // A call that ONLY carries trello_suggestion_shown (no other status
  // field) is pure suggestion-tracking, not a real status update -- skip
  // the activity-log/worker-state writes so it doesn't create a phantom
  // empty "location_report" entry or bump last_activity_at for nothing.
  const hasStatusUpdate =
    status.about_worker !== undefined ||
    status.location !== undefined ||
    status.active_job_reference !== undefined ||
    status.transport_mode !== undefined ||
    status.transported_by !== undefined ||
    status.awaiting_pickup !== undefined ||
    status.note !== undefined;

  // awaiting_pickup is NOT NULL (unlike the other optional fields below, which
  // are nullable columns where a NULL bind + COALESCE naturally means "leave
  // unchanged"). Resolve it in code first so an unspecified value preserves
  // whatever was already there instead of silently resetting it to 0.
  const existing = await db.get<{ awaiting_pickup: number; current_location_reported: string | null }>(
    'SELECT awaiting_pickup, current_location_reported FROM worker_state WHERE worker_user_id = ?',
    subjectUserId,
  );
  const destinationChanged = status.location !== undefined && status.location !== existing?.current_location_reported;

  if (hasStatusUpdate) {
    await db.run(
      `INSERT INTO worker_activity_log (id, worker_user_id, activity_type, detail, occurred_at)
       VALUES (?, ?, 'location_report', ?, ?)`,
      randomUUID(),
      subjectUserId,
      status.note ?? status.location ?? '',
      now,
    );

    const nextAwaitingPickup =
      status.awaiting_pickup !== undefined ? (status.awaiting_pickup ? 1 : 0) : (existing?.awaiting_pickup ?? 0);

    await db.run(
      `INSERT INTO worker_state (worker_user_id, current_location_reported, current_location_reported_at, active_job_reference, transport_mode, transported_by, awaiting_pickup, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worker_user_id) DO UPDATE SET
         current_location_reported = COALESCE(excluded.current_location_reported, worker_state.current_location_reported),
         current_location_reported_at = COALESCE(excluded.current_location_reported_at, worker_state.current_location_reported_at),
         active_job_reference = COALESCE(excluded.active_job_reference, worker_state.active_job_reference),
         transport_mode = COALESCE(excluded.transport_mode, worker_state.transport_mode),
         transported_by = COALESCE(excluded.transported_by, worker_state.transported_by),
         awaiting_pickup = excluded.awaiting_pickup,
         last_activity_at = excluded.last_activity_at`,
      subjectUserId,
      status.location ?? null,
      status.location ? now : null,
      status.active_job_reference ?? null,
      status.transport_mode ?? null,
      transportedBy,
      nextAwaitingPickup,
      now,
    );
  }

  const responseLines: string[] = [];
  if (hasStatusUpdate) {
    responseLines.push(`Status recorded for ${subjectUserId === reporterUserId ? 'you' : subjectUserId}.`);
  }

  // Destination resolution: only on a genuine location change, and only
  // ever from the durable properties/aliases reference -- never a guess.
  if (destinationChanged && status.location) {
    const resolution = await findPropertyByFreeText(status.location);
    if (resolution.status === 'matched') {
      const propertyIds = resolution.properties.map((p) => p.id);
      const suggestionKeyPropertyId = [...propertyIds].sort()[0];
      const destinationKey = propertyDestinationKey(suggestionKeyPropertyId);
      responseLines.push(
        `Property match: ${resolution.address} (property id(s): ${propertyIds.join(', ')}; use property_id "${suggestionKeyPropertyId}" and destination_key "${destinationKey}" for trello_suggestion_shown).`,
      );
      const lastSuggestion = await getLatestTrelloSuggestion(subjectUserId, destinationKey);
      responseLines.push(
        lastSuggestion
          ? `Last Trello suggestion already shown for this property: card(s) ${lastSuggestion.card_ids.join(', ')} at ${lastSuggestion.shown_at} -- only mention Trello work here if something's changed since then.`
          : 'No prior Trello suggestion recorded for this property -- fine to search and mention anything genuinely relevant.',
      );
    } else if (resolution.status === 'ambiguous') {
      const addresses = [...new Set(resolution.candidates.map((c) => c.address))];
      responseLines.push(
        `Property match: ambiguous between ${addresses.join(' / ')} -- ask which one before searching Trello, don't guess.`,
      );
    } else {
      const destinationKey = rawDestinationKey(status.location);
      responseLines.push(
        `Property match: no known property matches "${status.location}". Still fine to search Trello using the raw destination text -- use destination_key "${destinationKey}" (no property_id) for trello_suggestion_shown.`,
      );
      const lastSuggestion = await getLatestTrelloSuggestion(subjectUserId, destinationKey);
      responseLines.push(
        lastSuggestion
          ? `Last Trello suggestion already shown for this destination: card(s) ${lastSuggestion.card_ids.join(', ')} at ${lastSuggestion.shown_at} -- only mention Trello work here if something's changed since then.`
          : 'No prior Trello suggestion recorded for this destination -- fine to search and mention anything genuinely relevant.',
      );
    }
  }

  if (status.trello_suggestion_shown) {
    await recordTrelloSuggestion(
      subjectUserId,
      status.trello_suggestion_shown.destination_key,
      status.trello_suggestion_shown.card_ids,
      status.trello_suggestion_shown.property_id ?? null,
    );
    responseLines.push(
      `Trello suggestion recorded (${status.trello_suggestion_shown.card_ids.length} card(s)) for ${subjectUserId === reporterUserId ? 'you' : subjectUserId}.`,
    );
  }

  if (responseLines.length === 0) responseLines.push('report_worker_status: nothing to record (empty payload).');
  await notifyAgent(session, responseLines.join('\n'));
  log.info('report_worker_status: applied', {
    reporterUserId,
    subjectUserId,
    location: status.location,
    hasStatusUpdate,
    destinationChanged,
  });
}
