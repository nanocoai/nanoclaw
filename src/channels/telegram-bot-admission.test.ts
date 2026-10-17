/**
 * Tests for the Telegram bot-to-bot admission policy ("doorman").
 *
 * With Telegram's Bot-to-Bot Communication Mode enabled, bot-authored group
 * messages reach the gateway and engage like human mentions. The doorman is
 * the bridge inbound policy for channelType 'telegram': bot-authored messages
 * are admitted only in explicitly allowlisted chat+topic pairs and only when
 * addressed (platform mention OR direct reply to the bot's own message);
 * everything else is dropped with a host-side observability line. Human
 * traffic is strictly untouched.
 *
 * The gate order under the doorman is: bridge policy → pairing interceptor →
 * router (unknown-sender/members gate → engage). An ADMITTED bot message that
 * fails the members gate lands in dropped_messages as before — the doorman
 * only removes messages that fail chat/topic/addressing/throttle.
 *
 * Trunk note: ./telegram.ts does not exist on trunk (channel adapters ship on
 * the channels branch). The describe block that tests the real
 * extractReplyContext is preserved as a commented section below and belongs
 * to the channels-branch payload; the integration tests here run against a
 * minimal inline fake extractor with the same output shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge, registerBridgeInboundPolicy, type ReplyContext } from './chat-sdk-bridge.js';
import {
  buildTelegramBotAdmission,
  createTelegramBotAdmissionWrap,
  parseBotInboundEnv,
} from './telegram-bot-admission.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';

// The log mock is file-scoped; drop-reason assertions read it per test.
beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseBotInboundEnv
// ---------------------------------------------------------------------------

describe('parseBotInboundEnv', () => {
  it('parses chat:topic with type fidelity — chat stays string (negative ok), topic becomes a number', () => {
    expect(parseBotInboundEnv('-1003001999:175')).toEqual([{ chatId: '-1003001999', topic: 175 }]);
  });

  it('parses comma-separated entries', () => {
    expect(parseBotInboundEnv('-1003001999:175, -42:23')).toEqual([
      { chatId: '-1003001999', topic: 175 },
      { chatId: '-42', topic: 23 },
    ]);
  });

  it('skips malformed entries with a warning and keeps valid ones', () => {
    const entries = parseBotInboundEnv('-1003001999:175, noSep, -5:notanumber, -6:');
    expect(entries).toEqual([{ chatId: '-1003001999', topic: 175 }]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('parses a bare chatId (no topic) as anywhere-in-chat', () => {
    expect(parseBotInboundEnv('-1003001999')).toEqual([{ chatId: '-1003001999', topic: undefined }]);
    expect(parseBotInboundEnv('-1003001999:175, -42')).toEqual([
      { chatId: '-1003001999', topic: 175 },
      { chatId: '-42', topic: undefined },
    ]);
  });

  it('returns empty for absent or blank values', () => {
    expect(parseBotInboundEnv(undefined)).toEqual([]);
    expect(parseBotInboundEnv('')).toEqual([]);
    expect(parseBotInboundEnv('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTelegramBotAdmissionWrap — unit tests against the raw onInbound
// ---------------------------------------------------------------------------

/** The allowed chat/topic pair every unit test shares. */
const ALLOW = [{ chatId: '-1003001999', topic: 175 }];
const BOT_USER_ID = '1111111';
const BOT_USERNAME = 'TestBot';

interface InboundCall {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

function makeSetup(): { setup: ChannelSetup; calls: InboundCall[] } {
  const calls: InboundCall[] = [];
  const setup: ChannelSetup = {
    onInbound: (platformId, threadId, message) => {
      calls.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  return { setup, calls };
}

let nextId = 0;

function makeInbound(
  overrides: {
    text?: string;
    isBot?: boolean | null;
    isMention?: boolean;
    replyToUserId?: string;
    replyAnchor?: boolean;
  } = {},
): InboundMessage {
  const { text = 'ping', isBot = true, isMention = false, replyToUserId } = overrides;
  const content: Record<string, unknown> = { text };
  if (isBot !== null) {
    content.author = { userId: '2222222', userName: 'other_bot', fullName: 'Other', isBot, isMe: false };
  }
  if (replyToUserId !== undefined) {
    content.replyTo = {
      text: 'earlier message',
      sender: 'Someone',
      senderUserId: replyToUserId,
      ...(overrides.replyAnchor ? { replyToForumTopicAnchor: true } : {}),
    };
  }
  return {
    id: `m${++nextId}`,
    kind: 'chat-sdk',
    content,
    timestamp: new Date(0).toISOString(),
    isMention,
    isGroup: true,
  };
}

async function apply2(wrap: ReturnType<typeof createTelegramBotAdmissionWrap>) {
  const { setup, calls } = makeSetup();
  return { policy: await wrap(setup, 'telegram'), calls };
}

/** Build a wrap wired to a controllable clock; returns handles to advance it. */
function makeWrap(gapMs = 30_000) {
  let t = 1_000_000;
  const wrap = createTelegramBotAdmissionWrap({
    allow: ALLOW,
    botUserIdFor: () => BOT_USER_ID,
    botUsernameFor: async () => BOT_USERNAME,
    minGapMs: gapMs,
    now: () => t,
  });
  return {
    apply: async () => {
      const { setup, calls } = makeSetup();
      return { policy: await wrap(setup, 'telegram'), calls };
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function dropReasons(): string[] {
  return vi
    .mocked(log.info)
    .mock.calls.filter(([msg]) => msg === 'Telegram bot inbound dropped')
    .map(([, data]) => (data as { reason?: string }).reason ?? '<no-reason>');
}

describe('createTelegramBotAdmissionWrap', () => {
  it('passes human messages through untouched, anywhere, mention state preserved (strictly additive)', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    const elsewhere = makeInbound({ isBot: false, isMention: true });
    await policy.onInbound('telegram:-9999', 'telegram:-9999:7', elsewhere);

    expect(calls).toHaveLength(1);
    expect(calls[0].message.isMention).toBe(true);
    expect(dropReasons()).toEqual([]);
  });

  it('passes messages without a chat-sdk author through (non-chat-sdk kinds are not bot-classifiable)', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound('telegram:-9999', 'telegram:-9999:7', makeInbound({ isBot: null }));

    expect(calls).toHaveLength(1);
  });

  it('drops bot messages in other chats with reason wrong_chat', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound('telegram:-42', 'telegram:-42:175', makeInbound({ isMention: true }));

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['wrong_chat']);
  });

  it('drops bot messages in the allowed chat but wrong topic, including General (no topic)', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:23', makeInbound({ isMention: true }));
    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999', makeInbound({ isMention: true }));

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['wrong_topic', 'wrong_topic']);
  });

  it('admits a start-of-text bot command in the allowed chat+topic', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: '/ping@TestBot status', isMention: true }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message.isMention).toBe(true);
  });

  it('admits a start-of-text @username mention, case-insensitively', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: '@testbot status please', isMention: true }),
    );

    expect(calls).toHaveLength(1);
  });

  it('drops mid-text command quotes (prose or code spans) as not_addressed', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: 'note: run /ping@TestBot at 15:03', isMention: true }),
    );
    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: '`/ping@TestBot` — quoting it', isMention: true }),
    );

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['not_addressed', 'not_addressed']);
  });

  it('a bare-chatId entry admits addressed messages in any topic of that chat, including General', async () => {
    const wrap = createTelegramBotAdmissionWrap({
      allow: [{ chatId: '-1003001999', topic: undefined }],
      botUserIdFor: () => BOT_USER_ID,
      botUsernameFor: async () => BOT_USERNAME,
      now: () => 1_000_000,
    });

    const { policy, calls } = await apply2(wrap);
    const inTopic = makeInbound({ text: '/ping@TestBot', isMention: true });
    const inGeneral = makeInbound({ text: '/ping@TestBot', isMention: true });
    (inGeneral.content as Record<string, unknown>).author = {
      userId: '4444444',
      userName: 'other_bot',
      fullName: 'Other',
      isBot: true,
      isMe: false,
    };
    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', inTopic);
    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999', inGeneral);

    expect(calls).toHaveLength(2);
  });

  it('drops commands addressed to other bots', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: '/ping@OtherBot now', isMention: true }),
    );

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['not_addressed']);
  });

  it('admits a reply to the bot own message and stamps isMention so mention-mode wirings engage', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ isMention: false, replyToUserId: BOT_USER_ID }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message.isMention).toBe(true);
  });

  it('drops a reply to the forum-topic anchor as not_addressed even when the anchor is authored by the bot', async () => {
    // Forum topics overload reply_to_message: plain topic posts carry the
    // topic-anchor service message (authored by whoever created the topic —
    // here, the bot itself). That is topic plumbing, not addressing.
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ isMention: false, replyToUserId: BOT_USER_ID, replyAnchor: true }),
    );

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['not_addressed']);
  });

  it('still admits a real reply to bot message content (anchor flag absent)', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ isMention: false, replyToUserId: BOT_USER_ID, replyAnchor: false }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message.isMention).toBe(true);
  });

  it('drops a reply to someone else as not_addressed', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ isMention: false, replyToUserId: '9999999' }),
    );

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['not_addressed']);
  });

  it('drops an unaddressed bot message (no mention, no reply) as not_addressed', async () => {
    const { apply } = makeWrap();
    const { policy, calls } = await apply();

    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', makeInbound({ isMention: false }));

    expect(calls).toHaveLength(0);
    expect(dropReasons()).toEqual(['not_addressed']);
  });

  it('throttles admitted bot turns to one per gap window; the window anchors to the last admission', async () => {
    const { apply, advance } = makeWrap(30_000);
    const { policy, calls } = await apply();

    const addressed = () => makeInbound({ text: '/ping@TestBot', isMention: true });

    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', addressed());
    advance(5_000);
    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', addressed());
    expect(calls).toHaveLength(1);
    expect(dropReasons()).toEqual(['throttled']);

    // 5s + 25s = exactly the gap after the FIRST admission → passes again,
    // proving throttled drops do not extend the window.
    advance(25_000);
    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', addressed());
    expect(calls).toHaveLength(2);
  });

  it('throttles per sender, not globally: two different peers each get their own window', async () => {
    const { apply } = makeWrap(30_000);
    const { policy, calls } = await apply();

    const peerA = makeInbound({ text: '/ping@TestBot', isMention: true });
    const peerB = {
      ...makeInbound({ text: '/ping@TestBot', isMention: true }),
    };
    (peerB.content as Record<string, unknown>).author = {
      userId: '4444444',
      userName: 'other_bot',
      fullName: 'Other',
      isBot: true,
      isMe: false,
    };

    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', peerA);
    await policy.onInbound('telegram:-1003001999', 'telegram:-1003001999:175', peerB);

    expect(calls).toHaveLength(2);
  });

  it('keeps per-instance throttle state: each wrap application throttles independently', async () => {
    const { apply } = makeWrap(30_000);
    const first = await apply();
    const second = await apply();

    await first.policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: '/ping@TestBot', isMention: true }),
    );
    await second.policy.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ text: '/ping@TestBot', isMention: true }),
    );

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildTelegramBotAdmission — env-driven construction
// ---------------------------------------------------------------------------

describe('buildTelegramBotAdmission', () => {
  it('returns null when TELEGRAM_BOT_INBOUND is absent (feature fully off)', () => {
    expect(buildTelegramBotAdmission({})).toBeNull();
  });

  it('resolves the bot user id from the token prefix so reply-to-me admission works end to end', async () => {
    const policy = buildTelegramBotAdmission(
      {
        TELEGRAM_BOT_INBOUND: '-1003001999:175',
        TELEGRAM_BOT_TOKEN: '1111111:secret-part-not-used',
      },
      async () => BOT_USERNAME,
    );
    expect(policy).not.toBeNull();

    const { setup, calls } = makeSetup();
    const applied = await policy!(setup, 'telegram');

    await applied.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ isMention: false, replyToUserId: '1111111' }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].message.isMention).toBe(true);
  });

  it('admits per-instance tokens: a named instance resolves its own suffixed token', async () => {
    const policy = buildTelegramBotAdmission(
      {
        TELEGRAM_BOT_INBOUND: '-1003001999:175',
        TELEGRAM_BOT_TOKEN: '1111111:default',
        TELEGRAM_BOT_TOKEN_SECOND: '999777333003:named',
      },
      async () => BOT_USERNAME,
    );
    expect(policy).not.toBeNull();

    const { setup, calls } = makeSetup();
    const applied = await policy!(setup, 'telegram-second');

    await applied.onInbound(
      'telegram:-1003001999',
      'telegram:-1003001999:175',
      makeInbound({ isMention: false, replyToUserId: '999777333003' }),
    );
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MOVED TO THE CHANNELS-BRANCH PAYLOAD — telegram.ts extractReplyContext
// ---------------------------------------------------------------------------
// Trunk ships no channel adapters: ./telegram.ts lives on the `channels`
// branch, so this describe block cannot compile or run here. It tests the
// channels-branch extractReplyContext extension (senderUserId +
// replyToForumTopicAnchor) and belongs to the channels-branch payload (see
// telegram-adapter-doorman-registration.patch). The integration tests below
// cover the same bridge path on trunk through a minimal fake extractor with
// the identical output shape.
//
// describe('telegram extractReplyContext senderUserId', () => {
//   it('carries the replied-to author id so the doorman can match reply-to-me', () => {
//     const ctx = extractReplyContext({
//       reply_to_message: { text: 'leg one', from: { id: 1111111, username: 'TestBot', first_name: 'Test' } },
//     });
//     expect(ctx).not.toBeNull();
//     expect(ctx!.text).toBe('leg one');
//     expect(ctx!.sender).toBe('Test');
//     expect(ctx!.senderUserId).toBe('1111111');
//   });
//
//   it('marks a forum-topic anchor reply target so the doorman can exclude it from reply-to-me', () => {
//     const ctx = extractReplyContext({
//       reply_to_message: { forum_topic_created: { title: 'general-topic', icon_color: 7322096 }, from: { id: 999777333001 } },
//     });
//     expect(ctx).not.toBeNull();
//     expect(ctx!.senderUserId).toBe('999777333001');
//     expect(ctx!.replyToForumTopicAnchor).toBe(true);
//   });
//
//   it('marks textless reply targets as anchors too (conservative fail-closed)', () => {
//     const ctx = extractReplyContext({ reply_to_message: { sticker: { emoji: 'x' }, from: { id: 42 } } });
//     expect(ctx!.replyToForumTopicAnchor).toBe(true);
//   });
//
//   it('returns null without a reply target and omits senderUserId when the target has no id', () => {
//     expect(extractReplyContext({ text: 'no reply here' })).toBeNull();
//     const ctx = extractReplyContext({ reply_to_message: { text: 'anon' } });
//     expect(ctx).not.toBeNull();
//     expect(ctx!.senderUserId).toBeUndefined();
//   });
// });

// ---------------------------------------------------------------------------
// Integration: the real bridge dispatch funnels through the policy
// ---------------------------------------------------------------------------

// Trunk stand-in for the channels-branch extractor: same ReplyContext shape
// telegram.ts produces (see the moved describe block above), which is all the
// bridge path needs to exercise the doorman end to end.
/* eslint-disable @typescript-eslint/no-explicit-any */
const fakeExtractReplyContext = (raw: Record<string, any>): ReplyContext | null => {
  const reply = raw.reply_to_message as Record<string, any> | undefined;
  if (!reply) return null;
  const text: string = reply.text || reply.caption || '';
  return {
    text,
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    senderUserId: reply.from?.id !== undefined && reply.from?.id !== null ? String(reply.from.id) : undefined,
    replyToForumTopicAnchor: reply.forum_topic_created !== undefined || text === '',
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Registered LAST on purpose: on the channels branch, importing ./telegram.js
// may register the production env-driven policy when the real .env carries
// the flag; this registration overwrites it so the test drives a fixed wrap.
registerBridgeInboundPolicy(
  'telegram',
  createTelegramBotAdmissionWrap({
    allow: ALLOW,
    botUserIdFor: () => BOT_USER_ID,
    botUsernameFor: async () => BOT_USERNAME,
    now: () => 1_000_000,
  }),
);

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

function makeStubAdapter(name: string): { adapter: Adapter; chat: () => ChatDriver } {
  let captured: ChatDriver | null = null;
  const adapter = {
    name,
    initialize: async (chat: ChatDriver) => {
      captured = chat;
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;
  return {
    adapter,
    chat: () => {
      if (!captured) throw new Error('adapter not initialized — call bridge.setup() first');
      return captured;
    },
  };
}

let nextSdkId = 0;

function makeSdkMessage(opts: {
  text: string;
  isBot: boolean;
  isMention?: boolean;
  raw?: Record<string, unknown>;
}): Record<string, unknown> {
  const id = `sdk-${++nextSdkId}`;
  const payload = {
    id,
    text: opts.text,
    author: {
      userId: opts.isBot ? '2222222' : 'U-HUMAN',
      userName: 'sender',
      fullName: 'Sender',
      isBot: opts.isBot,
      isMe: false,
    },
  };
  return {
    ...payload,
    attachments: [],
    isMention: opts.isMention ?? false,
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw: opts.raw,
    toJSON: () => ({ ...payload }),
  };
}

describe('doorman through the real bridge path', () => {
  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  function makeBridge() {
    const { adapter, chat } = makeStubAdapter('telegram');
    const calls: InboundCall[] = [];
    const hostConfig: ChannelSetup = {
      onInbound: (platformId, threadId, message) => {
        calls.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    };
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: false,
      extractReplyContext: fakeExtractReplyContext,
    });
    return { adapter, chat, calls, hostConfig, bridge };
  }

  it('admitted reply-to-me bot message reaches the host stamped as mention, with reply context attached', async () => {
    const { adapter, chat, calls, hostConfig, bridge } = makeBridge();
    await bridge.setup(hostConfig);

    await chat().processMessage(
      adapter,
      'telegram:-1003001999:175',
      makeSdkMessage({
        text: 'leg one complete',
        isBot: true,
        raw: { reply_to_message: { text: 'go', from: { id: 1111111, username: 'TestBot' } } },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message.isMention).toBe(true);
    const content = calls[0].message.content as Record<string, unknown>;
    expect((content.replyTo as Record<string, unknown>).senderUserId).toBe('1111111');

    await bridge.teardown();
  });

  it('bot messages outside the admitted pair never reach the host; human traffic flows untouched', async () => {
    const { adapter, chat, calls, hostConfig, bridge } = makeBridge();
    await bridge.setup(hostConfig);

    // Bot firehose in another topic — dropped by the doorman.
    await chat().processMessage(
      adapter,
      'telegram:-1003001999:23',
      makeSdkMessage({ text: 'firehose chatter', isBot: true }),
    );
    expect(calls).toHaveLength(0);

    // Human plain message (no mention) in the same other topic — flows through.
    await chat().processMessage(
      adapter,
      'telegram:-1003001999:23',
      makeSdkMessage({ text: 'human chatting', isBot: false }),
    );
    expect(calls).toHaveLength(1);
    expect((calls[0].message.content as Record<string, unknown>).text).toBe('human chatting');

    await bridge.teardown();
  });
});
