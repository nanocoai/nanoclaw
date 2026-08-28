/**
 * Hardcoded, host-side-only configuration for controlled Lease Manager
 * document delivery. Same reasoning as lease-manager-generate/config.ts and
 * lease-manager-write/config.ts: none of this is agent-configurable. Only
 * Lease Manager's own generation flow may register a document; only
 * Pepper's own agent group may request delivery of one; only Kirk's own
 * trusted Telegram conversation is a valid destination for v1.
 *
 * Ported verbatim from old commit 59de60dc -- real production values,
 * unchanged.
 */

/** Only this agent group's generation flow may register a delivered-eligible document. */
export const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';

/** Only this agent group may request delivery of a registered document. */
export const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';

/**
 * WSL-side absolute path to the Drafts directory a delivered file must live
 * inside (canonicalized/realpath-compared at delivery time, not just
 * string-prefix compared, so a symlink can't fool the containment check).
 * Mirrors lease-manager-generate/config.ts's DRAFTS_DIR_WIN -- same physical
 * directory, host-side WSL path form.
 */
export const DRAFTS_DIR_WSL = '/mnt/c/Users/Owner/Desktop/Lease Manager/Leases/Drafts';

/** v1 scope: the only valid Telegram delivery destination is Kirk's own trusted conversation. */
export const KIRK_TELEGRAM_CHANNEL_TYPE = 'telegram';
export const KIRK_TELEGRAM_PLATFORM_ID = 'telegram:8855929473';
