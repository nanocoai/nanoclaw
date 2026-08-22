/**
 * Hardcoded, host-side-only configuration for Away Mode decision requests.
 * Same convention as lease-manager-generate/config.ts and
 * lease-document-delivery/config.ts: not agent-configurable.
 *
 * Ported verbatim from old commit 0fb28c04 -- real production values,
 * unchanged.
 */

/** Pepper's agent group -- used only to look up its live session for card-delivery routing. */
export const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';

/** The only valid approver for an Away Mode decision card. */
export const KIRK_APPROVER_USER_ID = 'telegram:8855929473';

/** The pending_approvals `action` name for every Away Mode decision request. */
export const AWAY_MODE_DECISION_ACTION = 'away_mode_decision';

/**
 * Fixed card title -- every Away Mode decision card reads exactly this,
 * never a caller-supplied title. This is what makes "cards must be clearly
 * labeled" a structural guarantee instead of a writing convention someone
 * could forget.
 */
export const AWAY_MODE_DECISION_CARD_TITLE = 'Away Mode — Claude Needs Your Decision';
