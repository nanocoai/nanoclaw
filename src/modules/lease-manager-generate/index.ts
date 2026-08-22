/**
 * Lease Manager PDF-generation module — admin-approved, operator-triggered
 * generation of Fixed-Term lease PDFs via the frozen v1 Python generator
 * (Templates/generate_fixed_term_lease.py). One guarded delivery action;
 * no test variant (unlike lease-manager-write's production/test split) --
 * generating a PDF has a fundamentally different risk profile than mutating
 * a live Excel workbook in place: every run produces a brand-new, versioned
 * file (never overwrites), never touches the workbook, and the generator's
 * own fail-closed checks (allowlist, cross-contamination blocklist,
 * coordinate, template-integrity) already ran against fictional data
 * extensively during development. A "test" MCP tool would just be this same
 * action pointed at fictional tenant names, which any caller can already do
 * directly.
 *
 * On install the module registers:
 *   - Its guard-catalog entry (./guard.ts): unconditional hold from the
 *     container path.
 *   - One guard-wrapped delivery action: the agent-group check + plan-shape
 *     validation + Fixed-Term-only preflight run as the wrapper's precheck
 *     (./request.ts), the hold builder cards the admin with the complete
 *     assembled field set (cross-checked against the workbook when the
 *     address is on file), and the handler body (./apply.ts) runs only on
 *     approve -- i.e. an approved replay -- writing an audit copy of the
 *     plan, shelling out to the Python generator, and independently
 *     confirming the resulting file exists before reporting success.
 *   - One approval handler that re-enters the wrapped action with the
 *     approval row as the grant (replay semantics -- the guard re-checks
 *     the structural checks live).
 *
 * Without this module: the MCP tool still writes an outbound system
 * message, but delivery logs "Unknown system action" and drops it. Admin
 * never sees a card; nothing is generated.
 *
 * Ported from old commit 59de60dc -- the registerDeliveryAction wiring
 * shape confirmed unchanged from current upstream. No migration here:
 * this module has no table of its own, it only reads/writes
 * lease_generated_documents, owned and self-registered by
 * lease-document-delivery.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyLeaseManagerGenerate } from './apply.js';
import { leaseManagerGenerate } from './guard.js';
import { requestLeaseManagerGenerateHold, validateLeaseManagerGenerate } from './request.js';

registerDeliveryAction('lease_manager_generate', applyLeaseManagerGenerate, {
  guardAction: leaseManagerGenerate,
  precheck: validateLeaseManagerGenerate,
  requestHold: requestLeaseManagerGenerateHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `lease_manager_generate denied: ${reason}`),
});
registerApprovalHandler('lease_manager_generate', reenterGuardedDeliveryAction('lease_manager_generate'));
