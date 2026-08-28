/**
 * Maintenance Coordinator: worker identity, durable time/activity history,
 * and ten guard-wrapped delivery actions for Maintenance Coordinator's
 * routine worker-facing actions (status/time/completion/info/key-binder
 * custody/workday-status) plus Pepper's read-only status query. All
 * ALLOW-only (no hold) -- none of these are consequential by themselves;
 * the one consequential path, report_maintenance_issue, lives in its own
 * module (../maintenance-issue-report/) and always routes Kirk's real
 * decision through a structured card.
 *
 * Migration order matters: module-maintenance-transportation.ts ALTERs the
 * worker_state table that module-maintenance-worker-state.ts creates, so
 * it MUST register second. registerMigration() preserves this via import
 * order, not each migration's own `version` field -- see
 * src/db/migrations/registry.test.ts's FK-dependency ordering test.
 *
 * Ported from old commit 824318ff, adapted: notifyAgent is now async, so
 * unreachableHold's inner function is awaited.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerMigration } from '../../db/migrations/index.js';
import { moduleMaintenanceCompletions } from '../../db/migrations/module-maintenance-completions.js';
import { moduleMaintenanceReportedIssues } from '../../db/migrations/module-maintenance-reported-issues.js';
import { moduleMaintenanceTransportation } from '../../db/migrations/module-maintenance-transportation.js';
import { moduleMaintenanceTrelloSuggestionLog } from '../../db/migrations/module-maintenance-trello-suggestion-log.js';
import { moduleMaintenanceWorkerState } from '../../db/migrations/module-maintenance-worker-state.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { maintenanceStatusQuery, maintenanceWorkerAction } from './guard.js';
import { applyRecordTimeEvent, validateRecordTimeEvent } from './record-time-event.js';
import { applyReportWorkerStatus, validateReportWorkerStatus } from './report-worker-status.js';
import { applyRecordJobCompletion, validateRecordJobCompletion } from './record-job-completion.js';
import { applyGetWorkerInfo, validateGetWorkerInfo } from './get-worker-info.js';
import { applyQueryMaintenanceStatus, validateQueryMaintenanceStatus } from './query-maintenance-status.js';
import { applyRecordKeyBinderCustody, validateRecordKeyBinderCustody } from './record-key-binder-custody.js';
import { applyGetKeyBinderStatus, validateGetKeyBinderStatus } from './get-key-binder-status.js';
import { applyGetWorkdayStatus, validateGetWorkdayStatus } from './get-workday-status.js';
import { applyMarkWorkdayActive, validateMarkWorkdayActive } from './mark-workday-active.js';
import { applyGetWorkerActivity, validateGetWorkerActivity } from './get-worker-activity.js';

registerMigration(moduleMaintenanceWorkerState);
registerMigration(moduleMaintenanceTransportation);
registerMigration(moduleMaintenanceCompletions);
registerMigration(moduleMaintenanceReportedIssues);
// trello_suggestion_log.property_id forward-references properties(id) (owned
// by ../maintenance-properties/), which loads after this module in the
// barrel -- fine: SQLite allows CREATE TABLE with a not-yet-existing FK
// target, it only enforces on DML, by which point every migration has run.
registerMigration(moduleMaintenanceTrelloSuggestionLog);

export { findWorker, type WorkerLookupResult, type WorkerRow } from './identity.js';
export {
  getWorkerActivityHistory,
  getWorkerTimeHistory,
  type ActivityHistoryEntry,
  type DayTimeSummary,
  type TimeHistoryEvent,
  type WorkerActivityHistoryError,
  type WorkerActivityHistoryOptions,
  type WorkerActivityHistoryResult,
  type WorkerTimeHistoryError,
  type WorkerTimeHistoryResult,
} from './history.js';

// Unreachable in practice for all ten actions below -- guard.ts's decide()
// functions only ever return allow/deny, never hold.
const unreachableHold = (action: string) => async (_content: Record<string, unknown>, session: Session) => {
  await notifyAgent(session, `${action} failed: unexpected approval hold. This has been logged as a bug.`);
};

registerDeliveryAction('record_time_event', applyRecordTimeEvent, {
  guardAction: maintenanceWorkerAction,
  precheck: validateRecordTimeEvent,
  requestHold: unreachableHold('record_time_event'),
  onDeny: (_content, session, reason) => notifyAgent(session, `record_time_event denied: ${reason}`),
});

registerDeliveryAction('report_worker_status', applyReportWorkerStatus, {
  guardAction: maintenanceWorkerAction,
  precheck: validateReportWorkerStatus,
  requestHold: unreachableHold('report_worker_status'),
  onDeny: (_content, session, reason) => notifyAgent(session, `report_worker_status denied: ${reason}`),
});

registerDeliveryAction('record_job_completion', applyRecordJobCompletion, {
  guardAction: maintenanceWorkerAction,
  precheck: validateRecordJobCompletion,
  requestHold: unreachableHold('record_job_completion'),
  onDeny: (_content, session, reason) => notifyAgent(session, `record_job_completion denied: ${reason}`),
});

registerDeliveryAction('get_worker_info', applyGetWorkerInfo, {
  guardAction: maintenanceWorkerAction,
  precheck: validateGetWorkerInfo,
  requestHold: unreachableHold('get_worker_info'),
  onDeny: (_content, session, reason) => notifyAgent(session, `get_worker_info denied: ${reason}`),
});

registerDeliveryAction('query_maintenance_status', applyQueryMaintenanceStatus, {
  guardAction: maintenanceStatusQuery,
  precheck: validateQueryMaintenanceStatus,
  requestHold: unreachableHold('query_maintenance_status'),
  onDeny: (_content, session, reason) => notifyAgent(session, `query_maintenance_status denied: ${reason}`),
});

registerDeliveryAction('record_key_binder_custody', applyRecordKeyBinderCustody, {
  guardAction: maintenanceWorkerAction,
  precheck: validateRecordKeyBinderCustody,
  requestHold: unreachableHold('record_key_binder_custody'),
  onDeny: (_content, session, reason) => notifyAgent(session, `record_key_binder_custody denied: ${reason}`),
});

registerDeliveryAction('get_key_binder_status', applyGetKeyBinderStatus, {
  guardAction: maintenanceWorkerAction,
  precheck: validateGetKeyBinderStatus,
  requestHold: unreachableHold('get_key_binder_status'),
  onDeny: (_content, session, reason) => notifyAgent(session, `get_key_binder_status denied: ${reason}`),
});

registerDeliveryAction('get_workday_status', applyGetWorkdayStatus, {
  guardAction: maintenanceWorkerAction,
  precheck: validateGetWorkdayStatus,
  requestHold: unreachableHold('get_workday_status'),
  onDeny: (_content, session, reason) => notifyAgent(session, `get_workday_status denied: ${reason}`),
});

registerDeliveryAction('mark_workday_active', applyMarkWorkdayActive, {
  guardAction: maintenanceWorkerAction,
  precheck: validateMarkWorkdayActive,
  requestHold: unreachableHold('mark_workday_active'),
  onDeny: (_content, session, reason) => notifyAgent(session, `mark_workday_active denied: ${reason}`),
});

registerDeliveryAction('get_worker_activity', applyGetWorkerActivity, {
  guardAction: maintenanceWorkerAction,
  precheck: validateGetWorkerActivity,
  requestHold: unreachableHold('get_worker_activity'),
  onDeny: (_content, session, reason) => notifyAgent(session, `get_worker_activity denied: ${reason}`),
});
