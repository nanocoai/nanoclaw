/**
 * Worker identity resolution for Maintenance Coordinator.
 *
 * Ported (findWorker only) from old commit 824318ff's identity.ts, adapted
 * to the async DbDriver. The rest of that file (resolveActingWorkerUserId,
 * resolveWorkerUserId, resolveVerifiedSenderIdForMessage) is about
 * attributing a WORKER-SENT action to the right person and stays deferred
 * to the full Priority 5 MC/Trello port -- the read-only historical-query
 * tools in this module never attribute an action, they only look one up by
 * name/id on Maintenance Coordinator's own behalf.
 */
import { getDb } from '../../db/connection.js';

export interface WorkerRow {
  user_id: string;
  name: string;
  preferred_language: string;
  role: string;
  can_drive_independently: number;
  usual_transport_provider: string | null;
}

export interface WorkerLookupResult {
  ok: boolean;
  worker?: WorkerRow;
  reason?: string;
}

/**
 * Resolve a worker by user_id, or by a case-insensitive name match (how a
 * caller naturally refers to a co-worker, e.g. "Elehazar"). Fails closed
 * (never silently picks one) if a name matches more than one worker --
 * "one worker's records cannot be confused with another's" is a hard
 * requirement for the historical-query tools this feeds.
 */
export async function findWorker(reference: string): Promise<WorkerLookupResult> {
  const byId = await getDb().get<WorkerRow>('SELECT * FROM workers WHERE user_id = ?', reference);
  if (byId) return { ok: true, worker: byId };

  const matches = await getDb().all<WorkerRow>('SELECT * FROM workers WHERE lower(name) = lower(?)', reference);
  if (matches.length === 0) {
    return { ok: false, reason: `no worker found matching "${reference}"` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `"${reference}" matches ${matches.length} workers (${matches.map((w) => w.user_id).join(', ')}) -- ambiguous, refusing to guess. Use the worker's user_id instead.`,
    };
  }
  return { ok: true, worker: matches[0] };
}
