/**
 * Worker-reported maintenance issue capture. On install the module
 * registers one guard-wrapped delivery action, `report_maintenance_issue`:
 * the agent-group check + payload validation run as the wrapper's precheck
 * (./request.ts), the guard (./guard.ts) allows only Maintenance
 * Coordinator's own agent group (no hold — recording a report isn't
 * consequential by itself), and the handler body (./apply.ts) resolves
 * the reporting worker, durably copies any photo, records the report, and
 * immediately routes Kirk's actual decision through the structured
 * maintenance_decision card (../maintenance-decisions/).
 *
 * No approval handler is registered: this action can never hold.
 *
 * No migration here: this module only reads/writes reported_issues,
 * owned and self-registered by maintenance-worker-actions.
 *
 * Ported from old commit 824318ff -- the registerDeliveryAction wiring
 * shape confirmed unchanged from current upstream (see the same finding
 * repeated across every Lease Manager sub-module).
 */
import { registerDeliveryAction } from '../../delivery.js';
import { notifyAgent } from '../approvals/index.js';
import { applyReportMaintenanceIssue } from './apply.js';
import { reportMaintenanceIssue } from './guard.js';
import { validateReportMaintenanceIssue } from './request.js';

registerDeliveryAction('report_maintenance_issue', applyReportMaintenanceIssue, {
  guardAction: reportMaintenanceIssue,
  precheck: validateReportMaintenanceIssue,
  requestHold: async (_content, session) => {
    // Unreachable -- guard.ts's decide() never returns hold for this action.
    await notifyAgent(session, 'report_maintenance_issue failed: unexpected approval hold. This has been logged as a bug.');
  },
  onDeny: (_content, session, reason) => notifyAgent(session, `report_maintenance_issue denied: ${reason}`),
});
