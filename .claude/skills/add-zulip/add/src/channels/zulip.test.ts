import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- fetch mock ---

function mockJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Default fetch mock: handles all Zulip API calls needed for connect()
function createFetchMock(opts: {
  events?: unknown[];
  hangOnEvents?: boolean;
} = {}) {
  let eventsCalled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn().mockImplementation(async (url: string, _init?: any) => {
    const u = String(url);

    if (u.includes('/api/v1/users/me')) {
      return mockJsonResponse({
        result: 'success',
        full_name: 'Andy Bot',
        email: 'andy-bot@test.zulipchat.com',
      });
    }

    if (u.includes('/api/v1/register')) {
      return mockJsonResponse({
        result: 'success',
        queue_id: 'test-queue-id',
        last_event_id: 0,
      });
    }

    if (u.includes('/api/v1/events')) {
      if (!eventsCalled && opts.events && opts.events.length > 0) {
        eventsCalled = true;
        return mockJsonResponse({ result: 'success', events: opts.events });
      }
      if (opts.hangOnEvents) {
        // Simulate long-polling: never resolves (until test ends)
        return new Promise(() => {});
      }
      // Return empty events
      return mockJsonResponse({ result: 'success', events: [] });
    }

    if (u.includes('/api/v1/messages')) {
      return mockJsonResponse({ result: 'success', id: 999 });
    }

    if (u.includes('/api/v1/typing')) {
      return mockJsonResponse({ result: 'success' });
    }

    throw new Error(`Unmocked URL: ${url}`);
  });
}

import { ZulipChannel, ZulipChannelOpts } from './zulip.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ZulipChannelOpts>): ZulipChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'zl:general/bot-requests': {
        name: 'Acme > #bot-requests',
        folder: 'general',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeChannel(opts?: Partial<ZulipChannelOpts>) {
  return new ZulipChannel(
    'https://acme.zulipchat.com',
    'andy-bot@acme.zulipchat.com',
    'test-api-key',
    createTestOpts(opts),
  );
}

function streamMessage(overrides: {
  id?: number;
  senderEmail?: string;
  senderName?: string;
  streamName?: string;
  topic?: string;
  content?: string;
  streamId?: number;
  timestamp?: number;
} = {}) {
  return {
    id: overrides.id ?? 101,
    type: 'stream' as const,
    sender_email: overrides.senderEmail ?? 'alice@acme.zulipchat.com',
    sender_full_name: overrides.senderName ?? 'Alice',
    content: overrides.content ?? 'Hello!',
    timestamp: overrides.timestamp ?? 1700000000,
    stream_id: overrides.streamId ?? 42,
    subject: overrides.topic ?? 'bot-requests',
    display_recipient: overrides.streamName ?? 'general',
  };
}

// --- Tests ---

describe('ZulipChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when credentials are valid', async () => {
      vi.stubGlobal('fetch', createFetchMock({ hangOnEvents: true }));
      const channel = makeChannel();

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      vi.unstubAllGlobals();
    });

    it('isConnected() returns false before connect()', () => {
      const channel = makeChannel();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      vi.stubGlobal('fetch', createFetchMock({ hangOnEvents: true }));
      const channel = makeChannel();

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      vi.unstubAllGlobals();
    });

    it('throws when credentials are invalid', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockJsonResponse({ result: 'error' })),
      );
      const channel = makeChannel();

      await expect(channel.connect()).rejects.toThrow(
        'Zulip authentication failed',
      );
      vi.unstubAllGlobals();
    });
  });

  // --- handleMessage: text messages ---

  describe('text message handling', () => {
    it('delivers message for a registered stream+topic', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(streamMessage({ content: 'Hello there' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.any(String),
        'general > bot-requests',
        'zulip',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.objectContaining({
          id: '101',
          chat_jid: 'zl:general/bot-requests',
          sender: 'alice@acme.zulipchat.com',
          sender_name: 'Alice',
          content: 'Hello there',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered streams', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(
        streamMessage({ streamName: 'other-stream', content: 'Unregistered' }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'zl:other-stream/bot-requests',
        expect.any(String),
        'other-stream > bot-requests',
        'zulip',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages from the bot itself', async () => {
      const opts = createTestOpts();
      const channel = new ZulipChannel(
        'https://acme.zulipchat.com',
        'andy-bot@acme.zulipchat.com', // same as sender below
        'test-api-key',
        opts,
      );

      await channel.handleMessage(
        streamMessage({ senderEmail: 'andy-bot@acme.zulipchat.com' }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores private (DM) messages', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage({
        id: 200,
        type: 'private',
        sender_email: 'alice@acme.zulipchat.com',
        sender_full_name: 'Alice',
        content: 'Hey there',
        timestamp: 1700000000,
        display_recipient: [
          { email: 'alice@acme.zulipchat.com', full_name: 'Alice' },
        ],
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('caches stream_id from received messages', async () => {
      vi.stubGlobal('fetch', createFetchMock());
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(streamMessage({ streamId: 99 }));

      // Verify cache by calling setTyping — should not throw
      await expect(
        channel.setTyping('zl:general/bot-requests', true),
      ).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @**Andy** mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(
        streamMessage({ content: '@**Andy** what time is it?' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.objectContaining({ content: '@Andy what time is it?' }),
      );
    });

    it('translates @**Andy Bot** (with surname) mention', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(
        streamMessage({ content: '@**Andy Bot** help me' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.objectContaining({ content: '@Andy help me' }),
      );
    });

    it('translates @_Andy_ silent mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(
        streamMessage({ content: '@_Andy_ reminder please' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.objectContaining({ content: '@Andy reminder please' }),
      );
    });

    it('does not prepend trigger if message already starts with it', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(
        streamMessage({ content: '@Andy @**Andy** help' }),
      );

      // @**Andy** stripped, but @Andy already present so no double-prefix
      expect(opts.onMessage).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.objectContaining({ content: '@Andy help' }),
      );
    });

    it('passes through messages without a mention unchanged', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(
        streamMessage({ content: 'just a normal message' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'zl:general/bot-requests',
        expect.objectContaining({ content: 'just a normal message' }),
      );
    });
  });

  // --- chatid command ---

  describe('chatid command', () => {
    it('responds with JID when content is "chatid"', async () => {
      const mockFetch = createFetchMock();
      vi.stubGlobal('fetch', mockFetch);
      const channel = makeChannel();

      await channel.handleMessage(streamMessage({ content: 'chatid' }));

      const postCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/messages'),
      );
      expect(postCalls).toHaveLength(1);
      const body = new URLSearchParams(postCalls[0][1].body);
      expect(body.get('content')).toContain('zl:general/bot-requests');
      vi.unstubAllGlobals();
    });

    it('does not deliver chatid command as a regular message', async () => {
      vi.stubGlobal('fetch', createFetchMock());
      const opts = createTestOpts();
      const channel = makeChannel(opts);

      await channel.handleMessage(streamMessage({ content: 'chatid' }));

      expect(opts.onMessage).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends to the correct stream and topic', async () => {
      vi.stubGlobal('fetch', createFetchMock({ hangOnEvents: true }));
      const channel = makeChannel();
      await channel.connect();

      await channel.sendMessage('zl:general/bot-requests', 'Hello!');

      const mockFetch = vi.mocked(fetch);
      const postCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/messages'),
      );
      expect(postCalls).toHaveLength(1);
      const body = new URLSearchParams((postCalls[0][1]!).body as string);
      expect(body.get('to')).toBe('general');
      expect(body.get('subject')).toBe('bot-requests');
      expect(body.get('content')).toBe('Hello!');
      vi.unstubAllGlobals();
    });

    it('handles topics containing slashes', async () => {
      vi.stubGlobal('fetch', createFetchMock({ hangOnEvents: true }));
      const channel = makeChannel();
      await channel.connect();

      await channel.sendMessage('zl:engineering/project/alpha', 'Hi');

      const mockFetch = vi.mocked(fetch);
      const postCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/messages'),
      );
      const body = new URLSearchParams((postCalls[0][1]!).body as string);
      expect(body.get('to')).toBe('engineering');
      expect(body.get('subject')).toBe('project/alpha');
      vi.unstubAllGlobals();
    });

    it('splits messages exceeding 9000 characters', async () => {
      vi.stubGlobal('fetch', createFetchMock({ hangOnEvents: true }));
      const channel = makeChannel();
      await channel.connect();

      const longText = 'x'.repeat(10000);
      await channel.sendMessage('zl:general/bot-requests', longText);

      const mockFetch = vi.mocked(fetch);
      const postCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/messages'),
      );
      expect(postCalls).toHaveLength(2);
      vi.unstubAllGlobals();
    });

    it('does nothing when not connected', async () => {
      vi.stubGlobal('fetch', createFetchMock());
      const channel = makeChannel();

      // Do not call connect()
      await channel.sendMessage('zl:general/bot-requests', 'No-op');

      const mockFetch = vi.mocked(fetch);
      const postCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/messages'),
      );
      expect(postCalls).toHaveLength(0);
      vi.unstubAllGlobals();
    });

    it('handles send failure gracefully', async () => {
      const badFetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('/api/v1/users/me')) {
          return mockJsonResponse({
            result: 'success',
            full_name: 'Andy Bot',
            email: 'andy-bot@test.com',
          });
        }
        if (String(url).includes('/api/v1/register')) {
          return mockJsonResponse({
            result: 'success',
            queue_id: 'q',
            last_event_id: 0,
          });
        }
        if (String(url).includes('/api/v1/events')) {
          return new Promise(() => {});
        }
        return mockJsonResponse({ result: 'error' }, false);
      });
      vi.stubGlobal('fetch', badFetch);
      const channel = makeChannel();
      await channel.connect();

      // Should not throw
      await expect(
        channel.sendMessage('zl:general/bot-requests', 'Will fail'),
      ).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns zl: JIDs', () => {
      const channel = makeChannel();
      expect(channel.ownsJid('zl:general/bot-requests')).toBe(true);
      expect(channel.ownsJid('zl:engineering/standup')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = makeChannel();
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = makeChannel();
      expect(channel.ownsJid('dc:1234567890')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = makeChannel();
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = makeChannel();
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing start when isTyping is true and stream_id is cached', async () => {
      const mockFetch = createFetchMock({ hangOnEvents: true });
      vi.stubGlobal('fetch', mockFetch);
      const channel = makeChannel();
      await channel.connect();

      // Inject stream_id by processing a message first
      await channel.handleMessage(streamMessage({ streamId: 42 }));

      await channel.setTyping('zl:general/bot-requests', true);

      const typingCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/typing'),
      );
      expect(typingCalls).toHaveLength(1);
      const body = new URLSearchParams(typingCalls[0][1].body);
      expect(body.get('op')).toBe('start');
      expect(body.get('stream_id')).toBe('42');
      expect(body.get('topic')).toBe('bot-requests');
      vi.unstubAllGlobals();
    });

    it('sends typing stop when isTyping is false', async () => {
      const mockFetch = createFetchMock({ hangOnEvents: true });
      vi.stubGlobal('fetch', mockFetch);
      const channel = makeChannel();
      await channel.connect();

      await channel.handleMessage(streamMessage({ streamId: 42 }));
      await channel.setTyping('zl:general/bot-requests', false);

      const typingCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/typing'),
      );
      expect(typingCalls).toHaveLength(1);
      const body = new URLSearchParams(typingCalls[0][1].body);
      expect(body.get('op')).toBe('stop');
      vi.unstubAllGlobals();
    });

    it('does nothing when stream_id is not yet cached', async () => {
      const mockFetch = createFetchMock({ hangOnEvents: true });
      vi.stubGlobal('fetch', mockFetch);
      const channel = makeChannel();
      await channel.connect();

      // No message received yet — stream_id unknown
      await channel.setTyping('zl:unknown-stream/topic', true);

      const typingCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/typing'),
      );
      expect(typingCalls).toHaveLength(0);
      vi.unstubAllGlobals();
    });

    it('does nothing when not connected', async () => {
      vi.stubGlobal('fetch', createFetchMock());
      const channel = makeChannel();

      await channel.setTyping('zl:general/bot-requests', true);

      const mockFetch = vi.mocked(fetch);
      const typingCalls = mockFetch.mock.calls.filter((c: any) =>
        String(c[0]).includes('/api/v1/typing'),
      );
      expect(typingCalls).toHaveLength(0);
      vi.unstubAllGlobals();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "zulip"', () => {
      const channel = makeChannel();
      expect(channel.name).toBe('zulip');
    });
  });
});
