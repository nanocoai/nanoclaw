/**
 * Records Kirk's resolution of a Maintenance Coordinator decision card
 * back onto the exact reported_issues row it was created for. Same
 * discipline as away-mode-decisions/resolve.ts: this only records what
 * Kirk actually said, never decides what it means for the issue's
 * workflow. "Reject with reason" is Kirk's real instructions on what to
 * do, not a rejection of the report itself -- the captured text becomes
 * `kirk_decision` verbatim.
 *
 * Ported from old commit 824318ff, adapted from sync
 * `getDb().prepare(sql).get/run(...)` to the current async DbDriver, and
 * `notify(...)` (now async) is awaited.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  type ApprovalResolvedEvent,
} from '../approvals/primitive.js';
import { MAINTENANCE_DECISION_ACTION } from './config.js';

function decisionTextFor(event: ApprovalResolvedEvent): string {
  if (event.outcome === 'approve') return 'approve';
  if (event.reason && event.reason.trim()) return event.reason.trim();
  return 'reject';
}

async function recordResolution(event: ApprovalResolvedEvent): Promise<void> {
  const payload = JSON.parse(event.approval.payload) as { issueId?: string; questionId?: string };
  if (!payload.issueId) {
    log.error('maintenance_decision resolved with malformed payload', { approvalId: event.approval.approval_id });
    return;
  }

  const row = await getDb().get<{ id: string }>('SELECT id FROM reported_issues WHERE id = ?', payload.issueId);
  if (!row) {
    log.error('maintenance_decision resolved but its reported_issues row no longer exists', {
      issueId: payload.issueId,
    });
    return;
  }

  const now = new Date().toISOString();
  await getDb().run(
    'UPDATE reported_issues SET kirk_decision = ?, decided_at = ?, status = ? WHERE id = ?',
    decisionTextFor(event),
    now,
    'kirk_decided',
    payload.issueId,
  );

  log.info('maintenance_decision resolved and recorded', {
    issueId: payload.issueId,
    outcome: event.outcome,
    hadReason: Boolean(event.reason),
  });
}

registerApprovalResolvedHandler(async (event) => {
  if (event.approval.action !== MAINTENANCE_DECISION_ACTION) return;
  await recordResolution(event);
});

// Approve-path notify only -- the DB write happens in the resolved
// observer above (fires for approve/reject/reject-with-reason alike).
registerApprovalHandler(MAINTENANCE_DECISION_ACTION, async ({ notify }) => {
  await notify('Kirk responded to the maintenance decision card.');
});
