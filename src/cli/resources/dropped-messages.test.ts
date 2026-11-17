/**
 * `ncl dropped-messages` must expose every reason the router and access gate
 * record, and nothing the host never writes. Unknown-sender drops are tagged
 * `unknown_sender_<policy>`, so the enum is derived from
 * UNKNOWN_SENDER_POLICIES and cannot fall behind it — except `public`, which
 * admits every sender before the gate records a drop.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { UNKNOWN_SENDER_POLICIES } from '../../types.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { dispatch } from '../dispatch.js';
import { getResource } from '../crud.js';
import { DROPPED_MESSAGE_REASONS } from './dropped-messages.js';

registerResourceHelpCommands();

describe('dropped-messages CLI reason enum', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
  });

  it('derives one unknown_sender_* reason per policy that records a drop', () => {
    const column = getResource('dropped-messages')!.columns.find((c) => c.name === 'reason')!;
    expect(column.enum).toBe(DROPPED_MESSAGE_REASONS);
    expect(DROPPED_MESSAGE_REASONS).toEqual([
      'no_agent_wired',
      'no_agent_engaged',
      ...UNKNOWN_SENDER_POLICIES.filter((policy) => policy !== 'public').map((policy) => `unknown_sender_${policy}`),
    ]);
    expect(DROPPED_MESSAGE_REASONS).toContain('unknown_sender_decline_notify');
  });

  it('omits unknown_sender_public: a public group admits before the gate records a drop', () => {
    expect(UNKNOWN_SENDER_POLICIES).toContain('public');
    expect(DROPPED_MESSAGE_REASONS).not.toContain('unknown_sender_public');
    expect(DROPPED_MESSAGE_REASONS).toEqual(
      expect.arrayContaining([
        'unknown_sender_strict',
        'unknown_sender_request_approval',
        'unknown_sender_decline_notify',
      ]),
    );
  });

  it('lists a decline_notify drop recorded the way the access gate records it', async () => {
    const policy: (typeof UNKNOWN_SENDER_POLICIES)[number] = 'decline_notify';
    await recordDroppedMessage({
      channel_type: 'telegram',
      platform_id: 'dm-1',
      user_id: 'telegram:u1',
      sender_name: 'Stranger',
      reason: `unknown_sender_${policy}`,
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
    });

    const resp = await dispatch(
      { id: 'req-1', command: 'dropped-messages-list', args: { reason: 'unknown_sender_decline_notify' } },
      { caller: 'host' },
    );
    if (!resp.ok) throw new Error(resp.error.message);
    expect((resp.data as Array<{ platform_id: string }>).map((r) => r.platform_id)).toEqual(['dm-1']);
  });

  it('help lists the recorded unknown_sender_* reasons and not unknown_sender_public', async () => {
    const resp = await dispatch({ id: 'req-2', command: 'dropped-messages-help', args: {} }, { caller: 'host' });
    if (!resp.ok) throw new Error(resp.error.message);
    const help = String(resp.data);
    expect(help).toContain('unknown_sender_strict');
    expect(help).toContain('unknown_sender_request_approval');
    expect(help).toContain('unknown_sender_decline_notify');
    expect(help).not.toContain('unknown_sender_public');
  });
});
