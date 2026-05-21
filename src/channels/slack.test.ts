import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
  GROUPS_DIR: '/tmp/test-groups',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock image processing
vi.mock('../image.js', () => ({
  processImageBuffer: vi.fn(async (_buf: Buffer, _mime: string) => ({
    mediaType: 'image/jpeg' as const,
    data: 'ZmFrZS1iYXNlNjQ=',
  })),
  isSupportedImageMime: (m: string) =>
    [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/heic',
      'image/heif',
      'image/avif',
    ].includes(m),
}));

// Mock media — keep tests off real disk by stubbing materializeAttachment.
const materializeMock = vi.hoisted(() =>
  vi.fn(async (opts: { relName: string }) => `inbox/${opts.relName}`),
);
vi.mock('../media.js', () => ({
  isSupportedVideoMime: (m: string) =>
    ['video/mp4', 'video/quicktime'].includes(m),
  mediaExtForMime: (m: string) => {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.jpg',
      'image/gif': '.jpg',
      'image/webp': '.jpg',
      'image/heic': '.jpg',
      'image/heif': '.jpg',
      'image/avif': '.jpg',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
    };
    const ext = map[m];
    if (!ext) throw new Error(`mock: bad mime ${m}`);
    return ext;
  },
  inboxFilename: (opts: { timestamp: Date; fileId: string; mime: string }) => {
    if (!/^[A-Z0-9]+$/.test(opts.fileId)) throw new Error('mock: bad file ID');
    const extMap: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
    };
    return `mock-${opts.fileId}${extMap[opts.mime] ?? '.jpg'}`;
  },
  materializeAttachment: materializeMock,
  MAX_VIDEO_BYTES: 100 * 1024 * 1024,
}));

// Mock fs — sendImage uses fs.createReadStream to attach files to uploadV2.
// We stub it to return a path-tagged object so tests can avoid real filesystem access.
const fsStub = vi.hoisted(() => ({
  createReadStream: vi.fn((p: string) => ({ __path: p })),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      createReadStream: fsStub.createReadStream,
    },
    createReadStream: fsStub.createReadStream,
  };
});

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue(undefined),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
  files?: Array<{
    id?: string;
    mimetype?: string;
    url_private_download?: string;
    name?: string;
  }>;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
    files: overrides.files,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

// --- Tests ---

describe('SlackChannel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as Record<string, unknown>).fetch;
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('flattens threaded replies into channel messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Threaded replies are delivered as regular channel messages
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
        }),
      );
    });

    it('delivers thread parent messages normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
      });
      await triggerMessageEvent(event);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 4000 chars
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 4000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Should not throw — Slack has no bot typing indicator API
      await expect(
        channel.setTyping('slack:C0123456789', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });

  // --- Image inbound ---

  describe('image inbound', () => {
    function okFetch() {
      fetchMock.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    }

    it('delivers an images-only message with marker block and materialized path', async () => {
      okFetch();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: undefined as unknown as string,
          files: [
            {
              id: 'F1',
              mimetype: 'image/png',
              url_private_download: 'https://files.slack.com/F1/download',
              name: 'pic.png',
            },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining('[Attached files in inbox/:]'),
          images: [
            expect.objectContaining({
              mediaType: 'image/jpeg',
              data: 'ZmFrZS1iYXNlNjQ=',
              path: expect.stringMatching(/^inbox\/mock-F1\.jpg$/),
            }),
          ],
        }),
      );
    });

    it('delivers a text+images message with multiple images', async () => {
      okFetch();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'Look at these',
          files: [
            {
              id: 'F1',
              mimetype: 'image/png',
              url_private_download: 'https://u/1',
              name: 'a.png',
            },
            {
              id: 'F2',
              mimetype: 'image/jpeg',
              url_private_download: 'https://u/2',
              name: 'b.jpg',
            },
          ],
        }),
      );

      const call = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as {
        images: unknown[];
      };
      expect(call.images.length).toBe(2);
    });

    it('skips unsupported mime types but keeps supported ones', async () => {
      okFetch();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'mixed',
          files: [
            {
              id: 'F1',
              mimetype: 'application/pdf',
              url_private_download: 'https://u/1',
            },
            {
              id: 'F2',
              mimetype: 'image/png',
              url_private_download: 'https://u/2',
            },
          ],
        }),
      );

      const call = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as {
        images: unknown[];
      };
      expect(call.images.length).toBe(1);
    });

    it('continues when an image fetch fails', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'hi',
          files: [
            {
              id: 'F1',
              mimetype: 'image/png',
              url_private_download: 'https://u/1',
            },
            {
              id: 'F2',
              mimetype: 'image/png',
              url_private_download: 'https://u/2',
            },
          ],
        }),
      );

      const call = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as {
        images: unknown[];
      };
      expect(call.images.length).toBe(1);
    });

    it('drops messages with no text and no processable images', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: undefined as unknown as string,
          files: [
            {
              id: 'F1',
              mimetype: 'application/pdf',
              url_private_download: 'https://u/1',
            },
          ],
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses bot token as Authorization header for url_private_download', async () => {
      okFetch();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'x',
          files: [
            {
              id: 'F1',
              mimetype: 'image/png',
              url_private_download: 'https://u/1',
            },
          ],
        }),
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://u/1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-test-token',
          }),
        }),
      );
    });
  });

  // --- Video inbound + mixed media + marker block ---

  describe('video inbound', () => {
    function okFetchVideo(bytes = 1024) {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(bytes) }),
        arrayBuffer: async () => new ArrayBuffer(bytes),
      });
    }

    it('accepts a video/mp4 and materializes it under inbox/', async () => {
      okFetchVideo();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'extend this',
          files: [
            {
              id: 'F999',
              mimetype: 'video/mp4',
              url_private_download: 'https://files.slack.com/F999/download',
              name: 'clip.mp4',
            },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining('[Attached files in inbox/:]'),
          videos: [
            expect.objectContaining({
              mediaType: 'video/mp4',
              path: expect.stringMatching(/^inbox\/mock-F999\.mp4$/),
            }),
          ],
        }),
      );
      // No inline base64 for video
      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as { images?: unknown };
      expect(payload.images).toBeUndefined();
    });

    it('accepts a video/quicktime (iPhone .mov)', async () => {
      okFetchVideo();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'animate this',
          files: [
            {
              id: 'F123',
              mimetype: 'video/quicktime',
              url_private_download: 'https://u/v',
              name: 'IMG_1234.MOV',
            },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          videos: [
            expect.objectContaining({
              mediaType: 'video/quicktime',
              path: expect.stringMatching(/^inbox\/mock-F123\.mov$/),
            }),
          ],
        }),
      );
    });

    it('delivers a mixed image+video message with both in the marker', async () => {
      okFetchVideo();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'use these',
          files: [
            {
              id: 'F1',
              mimetype: 'image/jpeg',
              url_private_download: 'https://u/img',
              name: 'a.jpg',
            },
            {
              id: 'F2',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/vid',
              name: 'b.mp4',
            },
          ],
        }),
      );

      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as {
        content: string;
        images?: unknown[];
        videos?: unknown[];
      };
      expect(payload.images?.length).toBe(1);
      expect(payload.videos?.length).toBe(1);
      expect(payload.content).toContain('use these');
      expect(payload.content).toContain('[Attached files in inbox/:]');
      expect(payload.content).toContain('inbox/mock-F1.jpg');
      expect(payload.content).toContain('inbox/mock-F2.mp4');
    });

    it('skips video/webm with a warn log (unsupported MIME)', async () => {
      okFetchVideo();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'try this',
          files: [
            {
              id: 'F1',
              mimetype: 'video/webm',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as { content: string; videos?: unknown[] };
      expect(payload.videos).toBeUndefined();
      // Text preserved, no marker (nothing materialized, no oversize)
      expect(payload.content).toBe('try this');
    });

    it('rejects oversize videos via Content-Length without consuming body', async () => {
      const oversize = 200 * 1024 * 1024;
      const arrayBufferMock = vi.fn(async () => new ArrayBuffer(1));
      fetchMock.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(oversize) }),
        arrayBuffer: arrayBufferMock,
      });
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'big one',
          files: [
            {
              id: 'F1',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      // Body never consumed when Content-Length exceeds cap
      expect(arrayBufferMock).not.toHaveBeenCalled();

      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as { content: string; videos?: unknown[] };
      expect(payload.videos).toBeUndefined();
      expect(payload.content).toContain('attachment skipped: too large');
    });

    it('rejects oversize videos via buffer-size fallback when Content-Length is missing', async () => {
      const oversizeBytes = 200 * 1024 * 1024;
      fetchMock.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(oversizeBytes),
      });
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'huge',
          files: [
            {
              id: 'F1',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as { content: string; videos?: unknown[] };
      expect(payload.videos).toBeUndefined();
      expect(payload.content).toContain('attachment skipped: too large');
    });

    it('skips files with path-traversal-shaped file IDs (inboxFilename throws)', async () => {
      okFetchVideo();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'evil',
          files: [
            {
              id: '../escape',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      // File ID rejected -> no video pushed, content unchanged.
      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as { content: string; videos?: unknown[] };
      expect(payload.videos).toBeUndefined();
      expect(payload.content).toBe('evil');
    });

    it('uses bot token Bearer auth for the video fetch', async () => {
      okFetchVideo();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'x',
          files: [
            {
              id: 'F999',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://u/v',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-test-token',
          }),
        }),
      );
    });

    it('drops messages with no text, no images, no videos, no oversize skips', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: undefined as unknown as string,
          files: [
            {
              id: 'F1',
              mimetype: 'video/webm', // unsupported
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('passes the registered group folder to materializeAttachment', async () => {
      okFetchVideo();
      materializeMock.mockClear();
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'x',
          files: [
            {
              id: 'F1',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      expect(materializeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'test-channel',
          groupsRoot: '/tmp/test-groups',
        }),
      );
    });

    it('marker block has the expected shape for a single video', async () => {
      okFetchVideo(8192);
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          text: 'see',
          files: [
            {
              id: 'F1',
              mimetype: 'video/mp4',
              url_private_download: 'https://u/v',
            },
          ],
        }),
      );

      const payload = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0][1] as { content: string };
      // Trailing block, blank line separator, single bullet line.
      const lines = payload.content.split('\n');
      expect(lines[0]).toBe('see');
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe('[Attached files in inbox/:]');
      expect(lines[3]).toMatch(
        /^- inbox\/mock-F1\.mp4 \(video\/mp4, [\d.]+ KB\)$/,
      );
    });
  });

  // --- sendImage (outbound) ---

  describe('sendImage', () => {
    it('uploads a single image via files.uploadV2', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendImage!('slack:C0123456789', ['/abs/a.png'], 'hi');

      expect(currentApp().client.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C0123456789',
          initial_comment: 'hi',
          file_uploads: [expect.objectContaining({ filename: 'a.png' })],
        }),
      );
    });

    it('uploads multiple images as an album', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendImage!(
        'slack:C0123456789',
        ['/abs/a.png', '/abs/b.jpg'],
        undefined,
      );

      const call = (
        currentApp().client.files.uploadV2 as unknown as {
          mock: { calls: unknown[][] };
        }
      ).mock.calls[0][0] as { file_uploads: Array<{ filename: string }> };
      expect(call.file_uploads.length).toBe(2);
      expect(call.file_uploads[0].filename).toBe('a.png');
      expect(call.file_uploads[1].filename).toBe('b.jpg');
    });

    it('queues when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.sendImage!('slack:C0123456789', ['/abs/a.png']);
      expect(currentApp().client.files.uploadV2).not.toHaveBeenCalled();
    });

    it('queues on upload failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.files.uploadV2.mockRejectedValueOnce(
        new Error('boom'),
      );
      await expect(
        channel.sendImage!('slack:C0123456789', ['/abs/a.png']),
      ).resolves.toBeUndefined();
    });

    it('flushes queued images on reconnect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.sendImage!('slack:C0123456789', ['/abs/a.png'], 'caption');
      await channel.connect();

      expect(currentApp().client.files.uploadV2).toHaveBeenCalled();
    });
  });

  // --- sendVideo (outbound) ---

  describe('sendVideo', () => {
    it('uploads a single video via files.uploadV2', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendVideo!('slack:C0123456789', ['/abs/clip.mp4'], 'hey');

      expect(currentApp().client.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C0123456789',
          initial_comment: 'hey',
          file_uploads: [expect.objectContaining({ filename: 'clip.mp4' })],
        }),
      );
    });

    it('uploads multiple videos in a single call', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendVideo!(
        'slack:C0123456789',
        ['/abs/a.mp4', '/abs/b.mp4', '/abs/c.mp4'],
        undefined,
      );

      const call = (
        currentApp().client.files.uploadV2 as unknown as {
          mock: { calls: unknown[][] };
        }
      ).mock.calls[0][0] as { file_uploads: Array<{ filename: string }> };
      expect(call.file_uploads.length).toBe(3);
      expect(call.file_uploads.map((f) => f.filename)).toEqual([
        'a.mp4',
        'b.mp4',
        'c.mp4',
      ]);
    });

    it('omits initial_comment when caption is undefined', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendVideo!('slack:C0123456789', ['/abs/clip.mp4']);

      const call = (
        currentApp().client.files.uploadV2 as unknown as {
          mock: { calls: unknown[][] };
        }
      ).mock.calls[0][0] as { initial_comment?: string };
      expect(call.initial_comment).toBeUndefined();
    });

    it('queues when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.sendVideo!('slack:C0123456789', ['/abs/clip.mp4']);
      expect(currentApp().client.files.uploadV2).not.toHaveBeenCalled();
    });

    it('flushes queued videos on reconnect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.sendVideo!('slack:C0123456789', ['/abs/clip.mp4'], 'cap');
      await channel.connect();

      expect(currentApp().client.files.uploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C0123456789',
          initial_comment: 'cap',
          file_uploads: [expect.objectContaining({ filename: 'clip.mp4' })],
        }),
      );
    });

    it('queues on upload failure (does not throw)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.files.uploadV2.mockRejectedValueOnce(
        new Error('boom'),
      );
      await expect(
        channel.sendVideo!('slack:C0123456789', ['/abs/clip.mp4']),
      ).resolves.toBeUndefined();
    });
  });
});
