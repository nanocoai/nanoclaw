/**
 * Guard adapters for Lease Manager's scoped filesystem module — composed at
 * the module edge (imported by ./index.ts).
 *
 * Two shapes:
 *   - leaseFsMove / leaseFsCopy / leaseFsMkdir: unconditional HOLD, same
 *     reasoning as lease-manager-write's guard -- every write operation
 *     requires admin approval from the container path, no exceptions in v1.
 *     "Must be Lease Manager's own agent group" is domain validation, kept
 *     in the precheck (./write-ops.ts / ./mkdir.ts), matching
 *     lease-manager-write's guard.
 *   - leaseSignedLeaseStage: ALLOW/DENY only, never HOLD -- staging an
 *     uploaded file into Incoming touches nothing consequential yet (no
 *     move into Current, no workbook write), same risk tier as
 *     record_job_completion's photo copy. Only Pepper may call it.
 *
 * Ported verbatim from old commit 59de60dc -- confirmed the guard seam
 * (defineGuardedAction/ALLOW/DENY/HOLD/GuardInput from ../../guard/index.js)
 * is structurally unchanged from current upstream.
 */
import { ALLOW, DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import { PEPPER_AGENT_GROUP_ID } from './config.js';

function holdDecide(label: string) {
  return (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY(`${label} is a container-originated action.`);
    }
    return HOLD(`${label} always requires admin approval from the container path`);
  };
}

export const leaseFsMove = defineGuardedAction({
  action: 'lease_fs_move.submit',
  grantActionName: 'lease_fs_move',
  decide: holdDecide('lease_fs_move'),
});

export const leaseFsCopy = defineGuardedAction({
  action: 'lease_fs_copy.submit',
  grantActionName: 'lease_fs_copy',
  decide: holdDecide('lease_fs_copy'),
});

export const leaseFsMkdir = defineGuardedAction({
  action: 'lease_fs_mkdir.submit',
  grantActionName: 'lease_fs_mkdir',
  decide: holdDecide('lease_fs_mkdir'),
});

function stageDecide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('stage_signed_lease_upload is a container-originated action.');
  }
  if (input.actor.agentGroupId !== PEPPER_AGENT_GROUP_ID) {
    return DENY('stage_signed_lease_upload is only usable by Pepper.');
  }
  return ALLOW('Staging an uploaded file into Incoming is low-risk and reversible -- no card needed.');
}

export const leaseSignedLeaseStage = defineGuardedAction({
  action: 'lease_signed_lease_stage.submit',
  decide: stageDecide,
});
