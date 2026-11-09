/**
 * `ncl approvals` must expose every status the host writes to
 * pending_approvals, including the "Reject with reason…" hold, so a
 * `--status` filter and the help text agree with the rows that exist.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, markApprovalAwaitingReason } from '../../db/sessions.js';
import { PENDING_APPROVAL_STATUSES } from '../../types.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { dispatch } from '../dispatch.js';
import { getResource } from '../crud.js';
// Side-effect import: registers the `approvals-*` commands.
import './approvals.js';

registerResourceHelpCommands();

describe('approvals CLI status enum', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
  });

  it('declares every status the PendingApproval type allows', () => {
    const column = getResource('approvals')!.columns.find((c) => c.name === 'status')!;
    expect(column.enum).toEqual([...PENDING_APPROVAL_STATUSES]);
    expect(column.enum).toContain('awaiting_reason');
  });

  it('lists a row parked in awaiting_reason by the host', async () => {
    await createPendingApproval({
      approval_id: 'apr-1',
      request_id: 'apr-1',
      action: 'test.action',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Test approval',
      options_json: '[]',
    });
    expect(await markApprovalAwaitingReason('apr-1', new Date(Date.now() + 60_000).toISOString())).toBe(true);

    const resp = await dispatch(
      { id: 'req-1', command: 'approvals-list', args: { status: 'awaiting_reason' } },
      { caller: 'host' },
    );
    if (!resp.ok) throw new Error(resp.error.message);
    expect((resp.data as Array<{ approval_id: string; status: string }>).map((r) => r.approval_id)).toEqual(['apr-1']);
  });

  it('help lists awaiting_reason as a status value', async () => {
    const resp = await dispatch({ id: 'req-2', command: 'approvals-help', args: {} }, { caller: 'host' });
    if (!resp.ok) throw new Error(resp.error.message);
    expect(String(resp.data)).toContain('values: pending | approved | rejected | expired | awaiting_reason');
  });
});
