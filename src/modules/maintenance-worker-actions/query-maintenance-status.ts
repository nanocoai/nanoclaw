/**
 * query_maintenance_status -- Pepper's narrow, read-only window into
 * Maintenance Coordinator's shared state, so Kirk can ask Pepper "who's
 * clocked in?" / "what's still open?" without Pepper ever seeing raw
 * worker chat. Reads worker_state/workers/reported_issues directly,
 * host-side, and returns a structured summary.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent is now async
 * (awaited); getDb().prepare/all -> await getDb().all.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { PEPPER_AGENT_GROUP_ID } from './config.js';

export async function validateQueryMaintenanceStatus(
  _content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  if (session.agent_group_id !== PEPPER_AGENT_GROUP_ID) {
    await notifyAgent(session, 'query_maintenance_status failed: not permitted for this agent.');
    return false;
  }
  return true;
}

interface StateRow {
  worker_user_id: string;
  name: string | null;
  clocked_in: number;
  current_location_reported: string | null;
  active_job_reference: string | null;
  pending_clarification: string | null;
  transport_mode: string | null;
  transported_by: string | null;
  awaiting_pickup: number;
}

interface IssueRow {
  id: string;
  worker_user_id: string;
  property_reference: string;
  unit: string | null;
  description: string;
  urgency: string;
  status: string;
  kirk_decision: string | null;
}

export async function applyQueryMaintenanceStatus(_payload: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== PEPPER_AGENT_GROUP_ID) {
    log.error('query_maintenance_status apply: rejected non-Pepper session', { agentGroupId: session.agent_group_id });
    return;
  }

  const db = getDb();
  const states = await db.all<StateRow>(
    `SELECT ws.worker_user_id, w.name, ws.clocked_in, ws.current_location_reported, ws.active_job_reference,
            ws.pending_clarification, ws.transport_mode, ws.transported_by, ws.awaiting_pickup
     FROM worker_state ws LEFT JOIN workers w ON w.user_id = ws.worker_user_id`,
  );

  const openIssues = await db.all<IssueRow>(
    `SELECT id, worker_user_id, property_reference, unit, description, urgency, status, kirk_decision
     FROM reported_issues WHERE status != 'kirk_decided' ORDER BY reported_at DESC`,
  );

  const lines: string[] = [];
  lines.push('Workers:');
  if (states.length === 0) {
    lines.push('  (no worker state recorded yet)');
  }
  for (const s of states) {
    const label = s.name ?? s.worker_user_id;
    const clock = s.clocked_in ? 'clocked in' : 'clocked out';
    const loc = s.current_location_reported ? `, at/heading to ${s.current_location_reported}` : '';
    const job = s.active_job_reference ? `, working on ${s.active_job_reference}` : '';
    const transport = s.transport_mode === 'transported' ? `, transported by ${s.transported_by ?? 'unknown'}` : '';
    const pickup = s.awaiting_pickup ? ', awaiting pickup' : '';
    const pending = s.pending_clarification ? `, awaiting their answer to: "${s.pending_clarification}"` : '';
    lines.push(`  - ${label}: ${clock}${loc}${job}${transport}${pickup}${pending}`);
  }

  lines.push('');
  lines.push(`Open issues not yet decided (${openIssues.length}):`);
  for (const i of openIssues) {
    const urgent = i.urgency === 'urgent' ? '[URGENT] ' : '';
    lines.push(
      `  - ${urgent}${i.property_reference}${i.unit ? ` unit ${i.unit}` : ''}: ${i.description} (reported by ${i.worker_user_id}, status=${i.status})`,
    );
  }

  await notifyAgent(session, lines.join('\n'));
  log.info('query_maintenance_status: applied', { workerCount: states.length, openIssueCount: openIssues.length });
}
