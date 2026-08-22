/**
 * The two write targets -- production and test -- packaged into one shape
 * request.ts/apply.ts consume. Adding a target here (hypothetically) would
 * still require its own guard/delivery-action/MCP-tool registration; this
 * file only removes the need to duplicate the *logic* in request.ts/apply.ts.
 *
 * Ported verbatim from old commit 59de60dc.
 */
import {
  BACKUP_DIR_WIN,
  TEST_BACKUP_DIR_WIN,
  TEST_WORKBOOK_PATH_WIN,
  TEST_WORKBOOK_PATH_WSL,
  WORKBOOK_PATH_WIN,
  WORKBOOK_PATH_WSL,
} from './config.js';

export interface WriteTarget {
  name: 'production' | 'test';
  workbookPathWin: string;
  workbookPathWsl: string;
  backupDirWin: string;
  /** Subdirectory under groups/<folder>/write-requests* for audit files. */
  auditSubdir: string;
  /** Prepended to the approval card when non-empty. */
  cardBanner: string;
  /** Distinguishes the two delivery actions / approval-handler registrations. */
  action: string;
}

export const PRODUCTION_TARGET: WriteTarget = {
  name: 'production',
  workbookPathWin: WORKBOOK_PATH_WIN,
  workbookPathWsl: WORKBOOK_PATH_WSL,
  backupDirWin: BACKUP_DIR_WIN,
  auditSubdir: 'write-requests',
  cardBanner: '',
  action: 'lease_manager_write',
};

export const TEST_TARGET: WriteTarget = {
  name: 'test',
  workbookPathWin: TEST_WORKBOOK_PATH_WIN,
  workbookPathWsl: TEST_WORKBOOK_PATH_WSL,
  backupDirWin: TEST_BACKUP_DIR_WIN,
  auditSubdir: 'write-requests-test',
  cardBanner: '⚠️ TEST / SYNTHETIC WORKBOOK -- fictional data, no real tenant consequences ⚠️\n\n',
  action: 'lease_manager_write_test',
};
