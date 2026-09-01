/**
 * Guard for the `ncl messaging-groups send-welcome` verb registration.
 *
 * Drives the real dispatcher: the side-effect import of the messaging-groups
 * resource registers the verb, and dispatch() invokes it end-to-end against an
 * in-memory central DB (router mocked — no container machinery). Goes red if
 * the customOperations entry is deleted, the command name drifts, or the
 * handler's call into sendWelcome breaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sendWelcome lazy-imports ../../router.js — mock routeInbound so no real
// routing/container machinery runs. Partial mock: dispatch()'s import graph
// (approvals reason-capture) needs the router's other exports for real.
vi.mock(import('../../router.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, routeInbound: vi.fn() };
});
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { upsertUserDm } from '../../modules/permissions/db/user-dms.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { routeInbound } from '../../router.js';
import { DEFAULT_WELCOME } from '../../send-welcome.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the messaging-groups resource (and its
// send-welcome verb) on the command registry.
import './messaging-groups.js';

const MG_ID = 'mg-dm-guard';
const now = '2026-07-01T00:00:00.000Z';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  vi.clearAllMocks();
});

describe('ncl messaging-groups send-welcome', () => {
  it('is registered and sends the welcome into a provisioned DM via dispatch()', async () => {
    await createMessagingGroup({
      id: MG_ID,
      channel_type: 'slack',
      platform_id: 'slack:D9',
      name: 'Dana',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    await upsertUser({ id: 'slack:U9', kind: 'slack', display_name: 'Dana', created_at: now });
    await upsertUserDm({ user_id: 'slack:U9', channel_type: 'slack', messaging_group_id: MG_ID, resolved_at: now });

    const resp = await dispatch(
      { id: 'req-welcome', command: 'messaging-groups-send-welcome', args: { id: MG_ID } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.data).toMatchObject({ sent: true });
      expect((resp.data as { message_id: string }).message_id).toMatch(/^welcome-/);
    }
    expect(routeInbound).toHaveBeenCalledTimes(1);
    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    expect(event.platformId).toBe('slack:D9');
    const content = JSON.parse(event.message.content) as { text: string; senderId: string };
    expect(content.text).toBe(DEFAULT_WELCOME);
    expect(content.senderId).toBe('slack:U9');
  });

  it('surfaces sendWelcome errors for an unknown messaging group', async () => {
    const resp = await dispatch(
      { id: 'req-welcome-miss', command: 'messaging-groups-send-welcome', args: { id: 'nope' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      // The handler's own error — an unregistered verb would say "unknown command".
      expect(resp.error.message).toContain('messaging group not found');
    }
    expect(routeInbound).not.toHaveBeenCalled();
  });
});
