/**
 * Mattermost mention-sticky engagement, end to end below the socket: real
 * adapter frames, the real Chat SDK bridge, the real router and its DB.
 * One top-level @mention must not make later top-level posts wake the agent;
 * a reply in the mentioned thread still does. Containers are mocked.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { MattermostAdapter } from './mattermost-adapter/adapter.js';
import type { MattermostWebSocketEvent } from './mattermost-adapter/types.js';
import { MATTERMOST_DEFAULTS } from './mattermost.js';

const { dataDir } = vi.hoisted(() => ({
  dataDir: `${process.env.TMPDIR ?? '/tmp'}/nanoclaw-mm-engage-${process.pid}`,
}));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => ({ ...(await vi.importActual('../config.js')), DATA_DIR: dataDir }));

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const BOT_ID = '7g4f95dymtrjmqnoozdyi57xbw';
const USER_ID = '7mx5jdcrnby18yrpnzont8ggwo';
const CHANNEL_ID = 'tyzg1xpaeinqzypmh6h9j9ysyy';
const MENTION_ID = 'mjhbignk4inf7kh9w5wi8snchw';
const PLAIN_ID = 'c7ad5obm3fn7byqnhqskc3b8so';
const REPLY_ID = 'or6atyakftywuq6jjo44oytu7h';
const CHATTER_REPLY_ID = 'k3w9qzx1bfgd8n5rjtpmyec4ha';
const PLATFORM_ID = `mattermost:${CHANNEL_ID}`;

function posted(id: string, message: string, options: { mention?: boolean; rootId?: string } = {}) {
  const post = {
    channel_id: CHANNEL_ID,
    create_at: Date.now(),
    id,
    message,
    user_id: USER_ID,
    ...(options.rootId ? { root_id: options.rootId } : {}),
  };
  return {
    broadcast: { channel_id: CHANNEL_ID },
    data: {
      channel_type: 'O',
      mentions: JSON.stringify(options.mention ? [BOT_ID] : []),
      post: JSON.stringify(post),
      sender_name: '@operator',
    },
    event: 'posted',
  } as MattermostWebSocketEvent;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());

  const { createAgentGroup } = await import('../db/agent-groups.js');
  const { createMessagingGroup, createMessagingGroupAgent } = await import('../db/messaging-groups.js');
  const createdAt = new Date().toISOString();
  await createAgentGroup({
    id: 'ag-mm',
    name: 'MM Agent',
    folder: 'mm-agent',
    agent_provider: null,
    created_at: createdAt,
  });
  await createMessagingGroup({
    id: 'mg-mm',
    channel_type: 'mattermost',
    platform_id: PLATFORM_ID,
    name: 'town-square',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  // The wiring a channel-registration approval creates.
  await createMessagingGroupAgent({
    id: 'mga-mm',
    messaging_group_id: 'mg-mm',
    agent_group_id: 'ag-mm',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: createdAt,
  });
});

afterEach(async () => {
  const { teardownChannelAdapters } = await import('./channel-registry.js');
  await teardownChannelAdapters();
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Mattermost mention-sticky engagement', () => {
  it('stays silent on top-level posts after one @mention, and follows replies in the mentioned thread', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/users/me')) return jsonResponse({ id: BOT_ID, is_bot: true, username: 'nanoclaw-bot' });
      if (url.endsWith(`/users/${USER_ID}`)) return jsonResponse({ id: USER_ID, is_bot: false, username: 'operator' });
      return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const mm = new MattermostAdapter({ fetchImpl, skipSocket: true, token: 'bot-token', url: 'https://mm.example' });

    const { registerChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');
    const { routeInbound } = await import('../router.js');
    registerChannelAdapter('mattermost', {
      factory: () => createChatSdkBridge({ adapter: mm, supportsThreads: true, defaults: MATTERMOST_DEFAULTS }),
      defaults: MATTERMOST_DEFAULTS,
    });

    // Same mapping as the host's onInbound in src/index.ts.
    const routed: { threadId: string | null; done: Promise<void> }[] = [];
    await initChannelAdapters((adapter: ChannelAdapter) => ({
      onInbound(platformId: string, threadId: string | null, message: InboundMessage) {
        const done = routeInbound({
          channelType: adapter.channelType,
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
            isSubscribed: message.isSubscribed,
          },
        });
        routed.push({ threadId, done });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    const { wakeContainer } = await import('../container-runner.js');
    const wake = wakeContainer as unknown as ReturnType<typeof vi.fn>;
    wake.mockClear();
    const { getDb } = await import('../db/connection.js');
    const send = async (event: MattermostWebSocketEvent, count: number): Promise<string | null> => {
      mm.handleSocketEvent(event);
      await vi.waitFor(() => expect(routed).toHaveLength(count));
      await routed[count - 1].done;
      return routed[count - 1].threadId;
    };

    const mentionThread = await send(posted(MENTION_ID, '@nanoclaw-bot hello', { mention: true }), 1);
    expect(wake).toHaveBeenCalledTimes(1);
    // The router subscribes the thread fire-and-forget; wait for the row.
    await vi.waitFor(async () => {
      const rows = await getDb().all<{ thread_id: string }>('SELECT thread_id FROM chat_sdk_subscriptions');
      expect(rows.map((r) => r.thread_id)).toContain(mentionThread);
    });

    const plainThread = await send(posted(PLAIN_ID, 'just chatting with the team'), 2);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(plainThread).not.toBe(mentionThread);

    const replyThread = await send(posted(REPLY_ID, 'and one more thing', { rootId: MENTION_ID }), 3);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(replyThread).toBe(mentionThread);

    // The plain post was stored as context; a reply under it is still chatter.
    const chatterThread = await send(posted(CHATTER_REPLY_ID, 'agreed', { rootId: PLAIN_ID }), 4);
    expect(chatterThread).toBe(plainThread);
    expect(wake).toHaveBeenCalledTimes(2);
  });
});
