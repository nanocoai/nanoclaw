/**
 * Shared audit-log helpers for lease_fs_operations -- one row per attempted
 * move/copy/mkdir, written at request time (status 'pending') and updated
 * through 'approved'/'rejected'/'applied'/'failed' as the operation
 * actually proceeds. This is the "log every attempted file operation,
 * including failures" requirement -- a row exists even for an operation
 * that never gets approved.
 *
 * Ported from old commit 59de60dc, adapted from sync
 * `getDb().prepare(sql).run(...)` to the current async DbDriver
 * (`await getDb().run(sql, ...)`) -- no behavior change.
 */
import { getDb } from '../../db/connection.js';

export interface RecordRequestedInput {
  id: string;
  operationType: 'move' | 'copy' | 'mkdir';
  sourceRelativePath: string | null;
  destRelativePath: string;
  contextNote: string | null;
  requestedByAgentGroupId: string;
  requestedBySessionId: string | null;
  relatedIntakeId: string | null;
}

export async function recordFsOperationRequested(input: RecordRequestedInput): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO lease_fs_operations
       (id, operation_type, source_relative_path, dest_relative_path, context_note,
        requested_by_agent_group_id, requested_by_session_id, requested_at, status, related_intake_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    input.id,
    input.operationType,
    input.sourceRelativePath,
    input.destRelativePath,
    input.contextNote,
    input.requestedByAgentGroupId,
    input.requestedBySessionId,
    now,
    input.relatedIntakeId,
    now,
  );
}

export async function markFsOperationApproved(id: string, approvedBy: string): Promise<void> {
  await getDb().run(
    `UPDATE lease_fs_operations SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`,
    approvedBy,
    new Date().toISOString(),
    id,
  );
}

export async function markFsOperationRejected(id: string, rejectedBy: string): Promise<void> {
  await getDb().run(
    `UPDATE lease_fs_operations SET status = 'rejected', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'pending'`,
    rejectedBy,
    new Date().toISOString(),
    id,
  );
}

export async function markFsOperationApplied(id: string): Promise<void> {
  await getDb().run(`UPDATE lease_fs_operations SET status = 'applied', applied_at = ? WHERE id = ?`, new Date().toISOString(), id);
}

export async function markFsOperationFailed(id: string, error: string): Promise<void> {
  await getDb().run(
    `UPDATE lease_fs_operations SET status = 'failed', error = ?, applied_at = ? WHERE id = ?`,
    error,
    new Date().toISOString(),
    id,
  );
}
