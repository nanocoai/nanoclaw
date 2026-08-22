/**
 * Lease Manager write module — admin-approved, operator-triggered writes to
 * the Lease Manager Excel workbook's Write sheet only. Two parallel guarded
 * actions (production, test) share all real logic via ./targets.ts; plus
 * one unguarded reset action for the test workbook only.
 *
 * On install the module registers:
 *   - Its guard-catalog entries (./guard.ts): unconditional hold from the
 *     container path, for both lease_manager_write and lease_manager_write_test.
 *   - Two guard-wrapped delivery actions: the agent-group check + row-shape
 *     validation run as the wrapper's precheck (./request.ts), the hold
 *     builder cards the admin with a summary + sample + a pointer to the
 *     full plan on disk (TEST cards carry an explicit banner), and the
 *     handler body (./apply.ts) runs only on allow -- i.e. an approved
 *     replay -- backing up the target workbook, applying the write via
 *     Excel COM, verifying the file still opens, and independently
 *     re-reading it to confirm the Read sheet is untouched and the Write
 *     sheet matches the approved plan exactly.
 *   - Two approval handlers that re-enter their wrapped action with the
 *     approval row as the grant (one replay semantics -- the guard
 *     re-checks the structural checks live).
 *   - One unguarded delivery action (reset_lease_test_workbook): no admin
 *     approval, since it only ever restores a known-safe fictional baseline
 *     over the test workbook path -- see ./guard.ts and
 *     ./reset-test-workbook.ts for why this one has no guarded action at all.
 *
 * No automatic or scheduled trigger exists anywhere in this module -- the
 * only path in is an MCP tool call (+ human approval for the two write
 * actions). There is deliberately no equivalent of self-mod's
 * container-restart step: nothing about any of these actions changes
 * container state, so there's nothing to restart.
 *
 * Without this module: the MCP tools still write outbound system messages,
 * but delivery logs "Unknown system action" and drops them. Admin never
 * sees a card; nothing changes.
 *
 * Ported from old commit 59de60dc -- the registerDeliveryAction/unguarded
 * wiring shape confirmed unchanged from current upstream. No migration
 * here: this module has no table of its own (workbook writes go through
 * PowerShell/Excel COM, not the central DB).
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyLeaseManagerWrite, applyLeaseManagerWriteTest } from './apply.js';
import { leaseManagerWrite, leaseManagerWriteTest } from './guard.js';
import {
  requestLeaseManagerWriteHold,
  requestLeaseManagerWriteTestHold,
  validateLeaseManagerWrite,
  validateLeaseManagerWriteTest,
} from './request.js';
import { resetLeaseTestWorkbook } from './reset-test-workbook.js';

registerDeliveryAction('lease_manager_write', applyLeaseManagerWrite, {
  guardAction: leaseManagerWrite,
  precheck: validateLeaseManagerWrite,
  requestHold: requestLeaseManagerWriteHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_manager_write denied: ${reason}`),
});
registerApprovalHandler('lease_manager_write', reenterGuardedDeliveryAction('lease_manager_write'));

registerDeliveryAction('lease_manager_write_test', applyLeaseManagerWriteTest, {
  guardAction: leaseManagerWriteTest,
  precheck: validateLeaseManagerWriteTest,
  requestHold: requestLeaseManagerWriteTestHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_manager_write_test denied: ${reason}`),
});
registerApprovalHandler('lease_manager_write_test', reenterGuardedDeliveryAction('lease_manager_write_test'));

registerDeliveryAction(
  'reset_lease_test_workbook',
  resetLeaseTestWorkbook,
  unguarded('restores a hardcoded, fictional test-only workbook to a known-safe baseline; cannot target production'),
);
