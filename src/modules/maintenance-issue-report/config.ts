/**
 * Hardcoded, host-side-only configuration for worker-reported maintenance
 * issues. Not agent-configurable, same convention as every other module's
 * config.ts this system.
 *
 * Ported verbatim from old commit 824318ff -- real production values,
 * unchanged.
 */

/** Only this agent group's workers may report a new issue. */
export const MAINTENANCE_COORDINATOR_AGENT_GROUP_ID = 'ag-0bed629f-db95-4547-bd12-41eea5e6fbe5';

/** Where completion/report photos are durably copied out of the ephemeral session inbox. */
export const MAINTENANCE_PHOTOS_DIR = 'data/maintenance-photos';
