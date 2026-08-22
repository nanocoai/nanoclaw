/**
 * Maintenance Coordinator: worker identity + durable time/activity history.
 *
 * Currently just the prerequisite slice for the Pepper->MC historical-query
 * capabilities (identity.ts's findWorker, history.ts's
 * getWorkerTimeHistory / getWorkerActivityHistory) -- pulled forward from
 * old commit 824318ff's much larger maintenance-worker-actions module
 * (worker-facing action tools: record_time_event, report_worker_status,
 * record_job_completion, etc.) because those tools' own durable tables are
 * exactly what the read-only history queries need as their source of
 * truth. The action-tool handlers themselves stay deferred to the full
 * MC/Trello reconciliation (Priority 5) -- this module does not add any
 * worker-facing write path.
 *
 * Migration order matters: module-maintenance-transportation.ts ALTERs the
 * worker_state table that module-maintenance-worker-state.ts creates, so
 * it MUST register second. registerMigration() preserves this via import
 * order, not each migration's own `version` field -- see
 * src/db/migrations/registry.test.ts's FK-dependency ordering test.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleMaintenanceCompletions } from '../../db/migrations/module-maintenance-completions.js';
import { moduleMaintenanceReportedIssues } from '../../db/migrations/module-maintenance-reported-issues.js';
import { moduleMaintenanceTransportation } from '../../db/migrations/module-maintenance-transportation.js';
import { moduleMaintenanceWorkerState } from '../../db/migrations/module-maintenance-worker-state.js';

registerMigration(moduleMaintenanceWorkerState);
registerMigration(moduleMaintenanceTransportation);
registerMigration(moduleMaintenanceCompletions);
registerMigration(moduleMaintenanceReportedIssues);

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
