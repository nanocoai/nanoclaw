/**
 * Maintenance Coordinator structured decision requests -- see ./request.ts
 * and ./resolve.ts. Importing this registers the approval-resolved
 * observer + approve-path notify handler at module load time.
 *
 * No migration here: this module only reads/writes reported_issues,
 * owned and self-registered by maintenance-worker-actions
 * (module-maintenance-reported-issues.ts).
 *
 * Ported from old commit 824318ff.
 */
import './resolve.js';

export { requestMaintenanceDecision } from './request.js';
