import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sendWelcome lazy-imports ./router.js — mock it so no real routing/container
// machinery runs; we assert on the synthetic event it would route.
vi.mock('./router.js', () => ({ routeInbound: vi.fn() }));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// The governance-home branch lazy-imports these two modules (the typed import
// paths are build-guarded); mock them so the suite controls whether the home
// surface is enabled without threading real config/env or Slack tokens.
vi.mock('./channels/home-events-forward.js', () => ({ homeForwardingEnabled: vi.fn(() => false) }));
vi.mock('./templates/app-home.js', () => ({ slackAppHomeDeepLink: vi.fn(async () => null) }));

import { homeForwardingEnabled } from './channels/home-events-forward.js';
import { closeDb, initTestDb } from './db/connection.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { upsertUserDm } from './modules/permissions/db/user-dms.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { routeInbound } from './router.js';
import { DEFAULT_WELCOME, sendWelcome } from './send-welcome.js';
import { slackAppHomeDeepLink } from './templates/app-home.js';

const MG_ID = 'mg-dm-1';
const now = '2026-07-01T00:00:00.000Z';

/** Seed a provisioned DM: a messaging group, its member user, and the user_dms
 *  row that ties them together (what `user-dms ensure` creates). */
async function seedProvisionedDm(): Promise<void> {
  await createMessagingGroup({
    id: MG_ID,
    channel_type: 'slack',
    platform_id: 'slack:D1',
    name: 'Dana',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUser({ id: 'slack:U1', kind: 'slack', display_name: 'Dana', email: null, created_at: now });
  await upsertUserDm({ user_id: 'slack:U1', channel_type: 'slack', messaging_group_id: MG_ID, resolved_at: now });
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  vi.clearAllMocks();
});

describe('sendWelcome', () => {
  it('routes the default /welcome instruction into the DM, attributed to the DM member', async () => {
    await seedProvisionedDm();

    const res = await sendWelcome({ messagingGroupId: MG_ID });

    expect(res.messageId).toMatch(/^welcome-/);
    expect(routeInbound).toHaveBeenCalledTimes(1);
    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    expect(event.channelType).toBe('slack');
    expect(event.platformId).toBe('slack:D1');
    expect(event.threadId).toBe('slack:D1');
    expect(event.message.isGroup).toBe(false);

    const content = JSON.parse(event.message.content) as { text: string; sender: string; senderId: string };
    expect(content.text).toBe(DEFAULT_WELCOME);
    // Attributed to the DM's member so the access gate lets it through (a
    // 'system' sender would be dropped as unknown on the strict DM group).
    expect(content.senderId).toBe('slack:U1');
    expect(content.sender).toBe('Dana');
  });

  it('honors a custom text override', async () => {
    await seedProvisionedDm();

    await sendWelcome({ messagingGroupId: MG_ID, text: 'Custom greeting instruction' });

    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    const content = JSON.parse(event.message.content) as { text: string };
    expect(content.text).toBe('Custom greeting instruction');
  });

  it('falls back to the default when the override is blank', async () => {
    await seedProvisionedDm();

    await sendWelcome({ messagingGroupId: MG_ID, text: '   ' });

    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    const content = JSON.parse(event.message.content) as { text: string };
    expect(content.text).toBe(DEFAULT_WELCOME);
  });

  it('uses client-neutral Slack App Home directions when the governance home surface is on', async () => {
    await seedProvisionedDm();
    vi.mocked(homeForwardingEnabled).mockReturnValueOnce(true);
    vi.mocked(slackAppHomeDeepLink).mockResolvedValueOnce('slack://app?team=T1&id=A1&tab=home');

    await sendWelcome({ messagingGroupId: MG_ID });

    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    const content = JSON.parse(event.message.content) as { text: string };
    expect(content.text.startsWith(DEFAULT_WELCOME)).toBe(true);
    expect(content.text).toContain('connecting their accounts');
    expect(content.text).toContain(`open this app's details and select "Home"`);
    expect(content.text).toContain('[Open my Home tab](slack://app?team=T1&id=A1&tab=home)');
    expect(content.text).not.toContain('top of this conversation');
  });

  it('keeps the Home-tab instruction but omits the link when the deep link cannot be resolved', async () => {
    await seedProvisionedDm();
    vi.mocked(homeForwardingEnabled).mockReturnValueOnce(true);
    vi.mocked(slackAppHomeDeepLink).mockResolvedValueOnce(null);

    await sendWelcome({ messagingGroupId: MG_ID });

    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    const content = JSON.parse(event.message.content) as { text: string };
    expect(content.text).toContain('select "Home"');
    expect(content.text).not.toContain('slack://');
  });

  it('does not extend the welcome when a custom text override is given', async () => {
    await seedProvisionedDm();
    vi.mocked(homeForwardingEnabled).mockReturnValue(true);

    await sendWelcome({ messagingGroupId: MG_ID, text: 'Custom greeting instruction' });

    const event = vi.mocked(routeInbound).mock.calls[0]![0];
    const content = JSON.parse(event.message.content) as { text: string };
    expect(content.text).toBe('Custom greeting instruction');
    vi.mocked(homeForwardingEnabled).mockReturnValue(false);
  });

  it('throws when the messaging group does not exist', async () => {
    await expect(sendWelcome({ messagingGroupId: 'nope' })).rejects.toThrow(/messaging group not found/);
    expect(routeInbound).not.toHaveBeenCalled();
  });

  it('throws when no user maps to the messaging group (DM not provisioned for a user)', async () => {
    // Messaging group exists but no user_dms row ties a user to it.
    await createMessagingGroup({
      id: MG_ID,
      channel_type: 'slack',
      platform_id: 'slack:D1',
      name: 'Orphan DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });

    await expect(sendWelcome({ messagingGroupId: MG_ID })).rejects.toThrow(/no user maps to messaging group/);
    expect(routeInbound).not.toHaveBeenCalled();
  });
});
