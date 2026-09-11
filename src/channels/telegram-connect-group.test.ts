import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, getAllMessagingGroups, initTestDb, runMigrations } from '../db/index.js';
import { getUserRoles, grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { InboundMessage } from './adapter.js';
import { createTelegramInboundInterceptor } from './telegram.js';

const token = 'test-token';
const botUsername = 'NanoClawBot';

function message(text: string, userId: string): InboundMessage {
  return {
    id: 'message-1',
    kind: 'chat-sdk',
    content: { text, author: { userId } },
    timestamp: new Date().toISOString(),
  };
}

async function addRole(userId: string, role: 'owner' | 'admin', agentGroupId: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await upsertUser({ id: `telegram:${userId}`, kind: 'telegram', display_name: null, created_at: now });
  await grantRole({
    user_id: `telegram:${userId}`,
    role,
    agent_group_id: agentGroupId,
    granted_by: null,
    granted_at: now,
  });
}

function sentBodies(): Array<Record<string, unknown>> {
  return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe('Telegram /connect_group', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllGlobals();
  });

  it('opens the native group picker for owners and global admins without changing authority', async () => {
    await createAgentGroup({
      id: 'agent-1',
      name: 'One',
      folder: 'one',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await addRole('42', 'owner');
    await addRole('43', 'admin');
    const hostOnInbound = vi.fn();
    const intercept = createTelegramInboundInterceptor(Promise.resolve(botUsername), hostOnInbound, token, 'telegram');

    await intercept('telegram:42', null, message('/connect_group', '42'));
    await intercept('telegram:43', null, message('/connect_group@nanoclawbot', '43'));

    expect(hostOnInbound).not.toHaveBeenCalled();
    expect(sentBodies()).toHaveLength(2);
    for (const body of sentBodies()) {
      expect(body).toMatchObject({
        text: expect.stringContaining('Group Privacy'),
        reply_markup: {
          inline_keyboard: [[{ url: 'https://t.me/NanoClawBot?startgroup=connect' }]],
        },
      });
    }
    expect(await getUserRoles('telegram:42')).toMatchObject([{ role: 'owner', agent_group_id: null }]);
    expect(await getUserRoles('telegram:43')).toMatchObject([{ role: 'admin', agent_group_id: null }]);
    expect(await getAllMessagingGroups()).toEqual([]);
  });

  it('denies scoped admins and unprivileged users without forwarding the control command', async () => {
    await createAgentGroup({
      id: 'agent-1',
      name: 'One',
      folder: 'one',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await addRole('98', 'admin', 'agent-1');
    const hostOnInbound = vi.fn();
    const intercept = createTelegramInboundInterceptor(Promise.resolve(botUsername), hostOnInbound, token, 'telegram');

    await intercept('telegram:98', null, message('/connect_group', '98'));
    await intercept('telegram:99', null, message('/connect_group', '99'));

    expect(hostOnInbound).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([
      { chat_id: '98', text: 'Only a NanoClaw owner or global admin can connect a group.' },
      { chat_id: '99', text: 'Only a NanoClaw owner or global admin can connect a group.' },
    ]);
  });

  it('leaves group messages and near-matches on the normal inbound path', async () => {
    await addRole('42', 'owner');
    const hostOnInbound = vi.fn();
    const intercept = createTelegramInboundInterceptor(Promise.resolve(botUsername), hostOnInbound, token, 'telegram');

    await intercept('telegram:-100', null, message('/connect_group', '42'));
    await intercept('telegram:42', null, message('/connect_group now', '42'));

    expect(hostOnInbound).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns the group-picker start command into a routed welcome prompt', async () => {
    const hostOnInbound = vi.fn();
    const intercept = createTelegramInboundInterceptor(Promise.resolve(botUsername), hostOnInbound, token, 'telegram');
    const inbound = message('/start@NanoClawBot connect', '42');

    await intercept('telegram:-100', null, inbound);

    expect(hostOnInbound).toHaveBeenCalledWith(
      'telegram:-100',
      null,
      expect.objectContaining({
        content: expect.objectContaining({
          text: expect.stringMatching(/welcome skill exactly.*introduce yourself.*back to this same group/),
          author: { userId: '42' },
        }),
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recognizes the group callback after recovering the bot username', async () => {
    await addRole('42', 'owner');
    vi.mocked(fetch).mockImplementation(async (input) => {
      const result = String(input).endsWith('/getMe') ? { ok: true, result: { username: botUsername } } : { ok: true };
      return new Response(JSON.stringify(result), { status: 200 });
    });
    const hostOnInbound = vi.fn();
    const intercept = createTelegramInboundInterceptor(Promise.resolve(null), hostOnInbound, token, 'telegram');

    await intercept('telegram:42', null, message('/connect_group', '42'));
    await intercept('telegram:-100', null, message('/start@NanoClawBot connect', '42'));

    expect(hostOnInbound).toHaveBeenCalledWith(
      'telegram:-100',
      null,
      expect.objectContaining({
        content: expect.objectContaining({ text: expect.stringContaining('introduce yourself in this group first') }),
      }),
    );
  });
});
