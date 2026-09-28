/**
 * Regression test for #2991 — Telegram broadcast-channel posts are
 * anonymous (Bot API attributes them to the channel itself via
 * `sender_chat`, no `from`). `@chat-adapter/telegram` maps that to author
 * userId `chat:<chatId>`. A wiring with sender_scope='known' must still
 * engage for that identity when it matches the wired chat's own id —
 * otherwise a channel wiring can never engage.
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: deliverMock,
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-telegram-channel-scope' };
});

const { wakeContainer } = await import('../../container-runner.js');

const TEST_DIR = '/tmp/nanoclaw-test-telegram-channel-scope';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  await import('./index.js');

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

  createMessagingGroup({
    id: 'mg-channel',
    channel_type: 'telegram',
    platform_id: 'telegram:-1009999',
    name: 'Broadcast Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-known',
    messaging_group_id: 'mg-channel',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  vi.mocked(wakeContainer).mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function channelPost(text: string, chatId: string) {
  return {
    channelType: 'telegram',
    platformId: 'telegram:-1009999',
    threadId: null,
    message: {
      id: `post-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        author: { userId: `chat:${chatId}` },
        senderName: 'Broadcast Channel',
        text,
      }),
      timestamp: now(),
    },
  };
}

describe('sender_scope=known on a Telegram channel wiring', () => {
  it('engages on an anonymous channel post from the wired channel itself', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(channelPost('hello subscribers', '-1009999'));

    expect(wakeContainer).toHaveBeenCalled();
  });

  it('still refuses an anonymous post from a different chat id', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(channelPost('spoofed', '-1000000'));

    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
