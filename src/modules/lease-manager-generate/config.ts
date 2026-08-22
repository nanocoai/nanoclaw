/**
 * Hardcoded, host-side-only configuration for the Lease Manager PDF
 * generation flow.
 *
 * Deliberately not agent-configurable, same reasoning as
 * ../lease-manager-write/config.ts: the whole point of this module is that
 * a container can never choose where a lease PDF is written or what it's
 * named. The Python generator itself also hardcodes its own output
 * directory (Templates/generate_fixed_term_lease.py's DRAFTS_DIR) --
 * this file's PYTHON_BIN/GENERATOR_SCRIPT_PATH_WSL just point at that
 * script; the path decision is enforced twice, independently, on purpose.
 *
 * Re-declares LEASE_MANAGER_AGENT_GROUP_ID and WORKBOOK_PATH_WSL locally
 * rather than importing them from ../lease-manager-write/config.ts, per
 * this codebase's one-module-one-config convention (each module's config
 * is self-contained; the values happen to be identical because it's the
 * same physical agent group and workbook).
 *
 * Ported verbatim from old commit 59de60dc -- real production values,
 * unchanged.
 */

/** Only this agent group may use submit_lease_generation_plan. */
export const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';

/**
 * Absolute path to the venv's python3 -- pikepdf + pymupdf installed there,
 * not in the system Python. Absolute path for the same reason
 * POWERSHELL_EXE_WSL is absolute in lease-manager-write/config.ts: the
 * NanoClaw systemd user service sets a narrow, explicit PATH with no
 * venv/bin entries.
 */
export const PYTHON_BIN = '/home/kirk/.venvs/leasepdf/bin/python3';

/** The frozen v1 generator script -- see FIXED_TERM_LEASE_V1_SPEC.md alongside it. */
export const GENERATOR_SCRIPT_PATH_WSL =
  '/mnt/c/Users/Owner/Desktop/Lease Manager/Templates/generate_fixed_term_lease.py';

/** Read-only re-derivation of the workbook path, for the pre-generation lookup/diff -- never opened for write here. */
export const WORKBOOK_PATH_WSL = '/mnt/c/Users/Owner/Desktop/Lease Manager/Lease Manager Excel.xlsx';

/** Where generated drafts land -- shown on the approval card as host-truth, never derived from agent input. */
export const DRAFTS_DIR_WIN = String.raw`C:\Users\Owner\Desktop\Lease Manager\Leases\Drafts`;

export const GENERATION_TIMEOUT_MS = 30_000;
