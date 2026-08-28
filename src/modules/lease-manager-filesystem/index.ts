/**
 * Lease Manager's scoped filesystem module.
 *
 * Four guarded delivery actions:
 *   - lease_fs_move / lease_fs_copy / lease_fs_mkdir: Lease Manager only,
 *     always require admin approval (./guard.ts, ./write-ops.ts, ./mkdir.ts).
 *   - stage_signed_lease_upload: Pepper only, no approval needed (./stage.ts)
 *     -- copying an uploaded file into a private staging area is low-risk;
 *     the consequential step is the lease_fs_move that follows.
 *
 * A single registerApprovalResolvedHandler below keeps lease_fs_operations
 * accurate for BOTH outcomes of a held action: on approve it marks the row
 * 'approved' (the apply handler then separately advances it to
 * 'applied'/'failed' once the operation actually runs or fails); on reject
 * it marks the row 'rejected' directly, since no apply ever runs.
 *
 * The container mount for Lease Manager stays read-only throughout --
 * nothing in this module writes from inside a container. Every actual
 * filesystem write happens here, host-side, only after either an admin
 * approval (move/copy/mkdir) or a low-risk allow (stage).
 *
 * Ported from old commit 59de60dc -- the registerDeliveryAction/
 * DeliveryGuardSpec wiring shape (precheck/requestHold/onDeny) is confirmed
 * unchanged from current upstream (see self-mod/index.ts for the same
 * pattern). Only addition versus the old file: the migration
 * self-registration call, matching the current registerMigration()
 * architecture (see src/db/migrations/module-lease-manager-filesystem.ts).
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleLeaseManagerFilesystem } from '../../db/migrations/module-lease-manager-filesystem.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { registerApprovalResolvedHandler, type ApprovalResolvedEvent } from '../approvals/primitive.js';
import { markFsOperationApproved, markFsOperationRejected } from './audit.js';
import { applyLeaseFsCopy, requestLeaseFsCopyHold, validateLeaseFsCopy } from './copy.js';
import { applyLeaseFsMkdir, requestLeaseFsMkdirHold, validateLeaseFsMkdir } from './mkdir.js';
import { applyLeaseFsMove, requestLeaseFsMoveHold, validateLeaseFsMove } from './move.js';
import { leaseFsCopy, leaseFsMkdir, leaseFsMove, leaseSignedLeaseStage } from './guard.js';
import { applyStageSignedLeaseUpload, validateStageSignedLeaseUpload } from './stage.js';

registerMigration(moduleLeaseManagerFilesystem);

const FS_WRITE_ACTIONS = new Set(['lease_fs_move', 'lease_fs_copy', 'lease_fs_mkdir']);

registerDeliveryAction('lease_fs_move', applyLeaseFsMove, {
  guardAction: leaseFsMove,
  precheck: validateLeaseFsMove,
  requestHold: requestLeaseFsMoveHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_fs_move denied: ${reason}`),
});
registerApprovalHandler('lease_fs_move', reenterGuardedDeliveryAction('lease_fs_move'));

registerDeliveryAction('lease_fs_copy', applyLeaseFsCopy, {
  guardAction: leaseFsCopy,
  precheck: validateLeaseFsCopy,
  requestHold: requestLeaseFsCopyHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_fs_copy denied: ${reason}`),
});
registerApprovalHandler('lease_fs_copy', reenterGuardedDeliveryAction('lease_fs_copy'));

registerDeliveryAction('lease_fs_mkdir', applyLeaseFsMkdir, {
  guardAction: leaseFsMkdir,
  precheck: validateLeaseFsMkdir,
  requestHold: requestLeaseFsMkdirHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_fs_mkdir denied: ${reason}`),
});
registerApprovalHandler('lease_fs_mkdir', reenterGuardedDeliveryAction('lease_fs_mkdir'));

registerDeliveryAction('stage_signed_lease_upload', applyStageSignedLeaseUpload, {
  guardAction: leaseSignedLeaseStage,
  precheck: validateStageSignedLeaseUpload,
  requestHold: async (_content, session) => {
    await notifyAgent(session, 'stage_signed_lease_upload failed: unexpected approval hold. This has been logged as a bug.');
  },
  onDeny: (_content, session, reason) => notifyAgent(session, `stage_signed_lease_upload denied: ${reason}`),
});

registerApprovalResolvedHandler(async (event: ApprovalResolvedEvent) => {
  if (!FS_WRITE_ACTIONS.has(event.approval.action)) return;
  let payload: { requestId?: string };
  try {
    payload = JSON.parse(event.approval.payload);
  } catch {
    return;
  }
  if (!payload.requestId) return;
  if (event.outcome === 'approve') {
    await markFsOperationApproved(payload.requestId, event.userId);
  } else {
    await markFsOperationRejected(payload.requestId, event.userId);
  }
});
