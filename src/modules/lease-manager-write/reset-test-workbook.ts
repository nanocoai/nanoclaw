/**
 * Reset/teardown for the synthetic test workbook. Unguarded (see ./guard.ts
 * header) -- no admin approval needed, since the only possible effect is
 * restoring a known-safe fictional baseline. Registered in ./index.ts.
 *
 * Takes no parameters at all, from the agent or otherwise -- both paths are
 * TEST_* constants from ./config.ts. There is structurally no way to point
 * this at the production workbook: no argument exists that could carry a
 * path to it.
 *
 * Ported from old commit 59de60dc, adapted to await notifyAgent (now
 * async). No DB access at all -- nothing else to adapt.
 */
import fs from 'node:fs';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { LEASE_MANAGER_AGENT_GROUP_ID, TEST_BASELINE_PATH_WSL, TEST_WORKBOOK_PATH_WSL } from './config.js';

export async function resetLeaseTestWorkbook(_content: Record<string, unknown>, session: Session): Promise<void> {
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    log.warn('reset_lease_test_workbook: rejected non-Lease-Manager caller', { agentGroupId: session.agent_group_id });
    return;
  }

  if (!fs.existsSync(TEST_BASELINE_PATH_WSL)) {
    await notifyAgent(
      session,
      `reset_lease_test_workbook failed: no baseline found at ${TEST_BASELINE_PATH_WSL}. ` +
        `Run the create-test-workbook script once to generate it.`,
    );
    return;
  }

  fs.copyFileSync(TEST_BASELINE_PATH_WSL, TEST_WORKBOOK_PATH_WSL);
  log.info('reset_lease_test_workbook: restored baseline', { path: TEST_WORKBOOK_PATH_WSL });
  await notifyAgent(session, 'Test workbook reset to its clean synthetic baseline. Ready for another test.');
}
