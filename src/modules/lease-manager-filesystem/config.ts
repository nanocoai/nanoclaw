/**
 * Hardcoded, host-side-only configuration for Lease Manager's scoped
 * filesystem capability. Same reasoning as every other lease-manager-*
 * config.ts: none of this is agent-configurable. The root is the one and
 * only boundary every path-safety check resolves against -- see
 * ./path-safety.ts.
 *
 * Ported verbatim from old commit 59de60dc -- real production values,
 * unchanged.
 */

/** Only this agent group may call lease_fs_move / lease_fs_copy / lease_fs_mkdir. */
export const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';

/** Only this agent group may call stage_signed_lease_upload. */
export const PEPPER_AGENT_GROUP_ID = 'ag-1786232390136-p4dww3';

/**
 * WSL-visible absolute path to the Lease Manager root -- the exact same
 * directory already mounted read-only into Lease Manager's container. Every
 * relative path an agent supplies is resolved and containment-checked
 * against this constant; nothing else is ever accepted as a root.
 */
export const LEASE_MANAGER_ROOT_WSL = '/mnt/c/Users/Owner/Desktop/Lease Manager';

/** Windows-side display form, shown on approval cards as host-truth context. */
export const LEASE_MANAGER_ROOT_WIN = String.raw`C:\Users\Owner\Desktop\Lease Manager`;

/** Staging area for files handed in through Pepper -- inside the existing mount, so Lease Manager sees it with zero new mount/permission. */
export const INCOMING_DIR_RELATIVE = 'Leases/Incoming';
