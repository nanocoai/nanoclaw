/**
 * Hardcoded, host-side-only targets for the Lease Manager write flow.
 *
 * Deliberately not agent-configurable: the whole point of this module is
 * that a container can never choose which file gets written. If Lease
 * Manager's agent group id or the workbook location ever change, update
 * these constants directly rather than adding a settings surface for them.
 *
 * Two independent target sets live here -- production and test -- with no
 * derivation between them. See ./targets.ts for how they're packaged into
 * the WriteTarget objects request.ts/apply.ts actually consume.
 *
 * Ported verbatim from old commit 59de60dc -- real production values,
 * unchanged.
 */

/** Only this agent group may use either submit_lease_write_plan tool. */
export const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';

/**
 * Absolute WSL-visible path to the Windows PowerShell binary. Used instead
 * of a bare "powershell.exe" execFile() call because the NanoClaw systemd
 * user service sets an explicit, narrow Environment=PATH= (no /mnt/c/...
 * entries) and has no WSL_INTEROP in its environment either -- both by
 * design, not a bug to route around by broadening the unit's PATH or
 * importing the interactive shell's environment. An absolute path sidesteps
 * PATH lookup entirely; WSL's Windows-binary interop (binfmt_misc) works
 * from an absolute path regardless of WSL_INTEROP, confirmed empirically.
 */
export const POWERSHELL_EXE_WSL = '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';

/** The one .ps1 apply script, shared by both targets (it's parameterized by -WorkbookPath/-BackupDir). */
export const APPLY_SCRIPT_DIR_WIN = String.raw`C:\Users\Owner\AppData\Local\NanoClaw\lease-manager-write`;
export const APPLY_SCRIPT_PATH_WIN = String.raw`C:\Users\Owner\AppData\Local\NanoClaw\lease-manager-write\apply-write-plan.ps1`;
export const APPLY_SCRIPT_DIR_WSL = '/mnt/c/Users/Owner/AppData/Local/NanoClaw/lease-manager-write';

// ── Production target ──────────────────────────────────────────────────
export const WORKBOOK_PATH_WIN = String.raw`C:\Users\Owner\Desktop\Lease Manager\Lease Manager Excel.xlsx`;
export const BACKUP_DIR_WIN = String.raw`C:\Users\Owner\Desktop\Lease Manager\backups`;
export const WORKBOOK_PATH_WSL = '/mnt/c/Users/Owner/Desktop/Lease Manager/Lease Manager Excel.xlsx';

// ── Test target -- entirely separate, synthetic workbook, never real data ──
const TEST_ROOT_WIN = String.raw`C:\Users\Owner\AppData\Local\NanoClaw\lease-manager-write-test`;
const TEST_ROOT_WSL = '/mnt/c/Users/Owner/AppData/Local/NanoClaw/lease-manager-write-test';
export const TEST_WORKBOOK_PATH_WIN = `${TEST_ROOT_WIN}\\test-workbook.xlsx`;
export const TEST_WORKBOOK_PATH_WSL = `${TEST_ROOT_WSL}/test-workbook.xlsx`;
export const TEST_BASELINE_PATH_WIN = `${TEST_ROOT_WIN}\\test-workbook-baseline.xlsx`;
export const TEST_BASELINE_PATH_WSL = `${TEST_ROOT_WSL}/test-workbook-baseline.xlsx`;
export const TEST_BACKUP_DIR_WIN = `${TEST_ROOT_WIN}\\backups`;

export const BACKUP_RETENTION_COUNT = 10;
export const MAX_PLAN_ROWS = 500;
