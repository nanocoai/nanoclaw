/**
 * get_worker_info -- lets Maintenance Coordinator look up a worker's
 * language/driving-capability/transport-dependency (its own, or a
 * co-worker's, by name). Read-only. This is what lets the agent reason
 * about transportation ("Ivan doesn't drive, Elehazar usually takes him")
 * without hardcoding names/facts into its instructions -- the workers
 * table is the source of truth, editable without touching agent behavior.
 *
 * Ported from old commit 824318ff, adapted: validateGetWorkerInfo's
 * signature changes boolean -> Promise<boolean> (notifyAgent now async,
 * awaited); resolveActingWorkerUserId and findWorker are now async
 * (findWorker returns { ok, worker, reason } rather than
 * WorkerRow | undefined).
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { findWorker, resolveActingWorkerUserId, type WorkerRow } from './identity.js';

interface InfoPayload {
  /** A worker's name, or "self" / omitted for the reporting worker themself. */
  worker?: string;
  source_message_id?: string;
}

export async function validateGetWorkerInfo(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    await notifyAgent(session, 'get_worker_info failed: not permitted for this agent.');
    return false;
  }
  const p = content.info as InfoPayload | undefined;
  if (p?.worker !== undefined && typeof p.worker !== 'string') {
    await notifyAgent(session, 'get_worker_info failed: worker must be a string if provided.');
    return false;
  }
  if (p?.source_message_id !== undefined && typeof p.source_message_id !== 'string') {
    await notifyAgent(session, 'get_worker_info failed: source_message_id must be a string if provided.');
    return false;
  }
  return true;
}

function formatWorker(w: WorkerRow): string {
  const transport =
    w.can_drive_independently === 1
      ? 'drives independently'
      : `does not drive independently -- usually transported by ${w.usual_transport_provider ?? '(not set)'}`;
  return `${w.name} (${w.user_id}): language=${w.preferred_language}, role=${w.role}, ${transport}.`;
}

export async function applyGetWorkerInfo(payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== MAINTENANCE_COORDINATOR_AGENT_GROUP_ID) {
    log.error('get_worker_info apply: rejected non-Maintenance-Coordinator session', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const info = payload.info as InfoPayload;
  let target = info.worker;
  if (!target || target.toLowerCase() === 'self') {
    const identity = await resolveActingWorkerUserId(session, info.source_message_id);
    if (!identity.ok || !identity.userId) {
      await notifyAgent(session, `get_worker_info failed: ${identity.reason}`);
      return;
    }
    target = identity.userId;
  }

  const found = await findWorker(target);
  if (!found.ok || !found.worker) {
    await notifyAgent(session, `get_worker_info: no known worker matches "${target}".`);
    return;
  }

  await notifyAgent(session, formatWorker(found.worker));
}
