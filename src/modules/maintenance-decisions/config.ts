/**
 * Hardcoded, host-side-only configuration for Maintenance Coordinator
 * decision requests -- same convention as away-mode-decisions/config.ts.
 *
 * Ported verbatim from old commit 824318ff -- real production values,
 * unchanged.
 */

/** Pepper's agent group -- used only to look up its live session for card-delivery routing. */
export const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';

/** The only valid approver for a Maintenance Coordinator decision card. */
export const KIRK_APPROVER_USER_ID = 'telegram:8855929473';

/** The pending_approvals `action` name for every Maintenance Coordinator decision request. */
export const MAINTENANCE_DECISION_ACTION = 'maintenance_decision';

/**
 * Fixed card titles -- never caller-supplied. Two variants so an urgent
 * report (active leak, broken pipe, safety issue) is structurally
 * distinguishable from a routine one, not just worded differently in a
 * question body Kirk might skim past.
 */
export const MAINTENANCE_DECISION_CARD_TITLE = 'Maintenance Coordinator — New Issue Reported';
export const MAINTENANCE_DECISION_CARD_TITLE_URGENT = 'Maintenance Coordinator — URGENT Issue Reported';
