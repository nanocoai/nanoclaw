/**
 * Hardcoded, host-side-only configuration for Maintenance Coordinator's
 * routine worker-facing actions (status/time/completion/info) and
 * Pepper's status query. Not agent-configurable, same convention as every
 * other module's config.ts in this system.
 *
 * Ported verbatim from old commit 824318ff -- real production values,
 * unchanged. (maintenance-issue-report/config.ts and
 * maintenance-decisions/config.ts carry the same two agent-group
 * constants for their own narrower needs -- duplicated per-module by
 * convention throughout this codebase, not shared, so each module's
 * guard stays self-contained.)
 */

/** Only this agent group's workers may call the worker-facing actions. */
export const MAINTENANCE_COORDINATOR_AGENT_GROUP_ID = 'ag-0bed629f-db95-4547-bd12-41eea5e6fbe5';

/** Only Pepper may call query_maintenance_status. */
export const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';

/** Where completion photos are durably copied out of the ephemeral session inbox. */
export const MAINTENANCE_PHOTOS_DIR = 'data/maintenance-photos';
