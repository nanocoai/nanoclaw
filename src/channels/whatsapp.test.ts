import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/nanoclaw-test-store',
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
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
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

// Mock child_process (used for osascript notification)
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Build a fake WASocket that's an EventEmitter with the methods we need
function createFakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        ev.on(event, handler);
      },
    },
    user: {
      id: '1234567890:1@s.whatsapp.net',
      lid: '9876543210:1@lid',
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    // Expose the event emitter for triggering events in tests
    _ev: ev,
  };
  return sock;
}

let fakeSocket: ReturnType<typeof createFakeSocket>;

// Mock Baileys
vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: vi.fn(() => fakeSocket),
    Browsers: { macOS: vi.fn(() => ['macOS', 'Chrome', '']) },
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      connectionClosed: 428,
      connectionLost: 408,
      connectionReplaced: 440,
      timedOut: 408,
      restartRequired: 515,
    },
    fetchLatestWaWebVersion: vi
      .fn()
      .mockResolvedValue({ version: [2, 3000, 0] }),
    normalizeMessageContent: vi.fn((content: unknown) => content),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    useMultiFileAuthState: vi.fn().mockResolvedValue({
      state: {
        creds: {},
        keys: {},
      },
      saveCreds: vi.fn(),
    }),
  };
});

import { WhatsAppChannel, WhatsAppChannelOpts } from './whatsapp.js';
import { getLastGroupSync, updateChatName, setLastGroupSync } from '../db.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<WhatsAppChannelOpts>,
): WhatsAppChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'registered@g.us': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function triggerConnection(state: string, extra?: Record<string, unknown>) {
  fakeSocket._ev.emit('connection.update', { connection: state, ...extra });
}

function triggerDisconnect(statusCode: number) {
  fakeSocket._ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode } },
    },
  });
}

async function triggerMessages(messages: unknown[]) {
  fakeSocket._ev.emit('messages.upsert', { messages });
  // Flush microtasks so the async messages.upsert handler completes
  await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ---

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    fakeSocket = createFakeSocket();
    vi.mocked(getLastGroupSync).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: start connect, flush microtasks so event handlers are registered,
   * then trigger the connection open event. Returns the resolved promise.
   */
  async function connectChannel(channel: WhatsAppChannel): Promise<void> {
    const p = channel.connect();
    // Flush microtasks so connectInternal completes its await and registers handlers
    await new Promise((r) => setTimeout(r, 0));
    triggerConnection('open');
    return p;
  }

  // --- Version fetch ---

  describe('version fetch', () => {
    it('connects with fetched version', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      const { fetchLatestWaWebVersion } =
        await import('@whiskeysockets/baileys');
      expect(fetchLatestWaWebVersion).toHaveBeenCalledWith({});
    });

    it('falls back gracefully when version fetch fails', async () => {
      const { fetchLatestWaWebVersion } =
        await import('@whiskeysockets/baileys');
      vi.mocked(fetchLatestWaWebVersion).mockRejectedValueOnce(
        new Error('network error'),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);
      await connectChannel(channel);

      // Should still connect successfully despite fetch failure
      expect(channel.isConnected()).toBe(true);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when connection opens', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('sets up LID to phone mapping on open', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // The channel should have mapped the LID from sock.user
      // We can verify by sending a message from a LID JID
      // and checking the translated JID in the callback
    });

    it('flushes outgoing queue on reconnect', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect
      (channel as any).connected = false;

      // Queue a message while disconnected
      await channel.sendMessage('test@g.us', 'Queued message');
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();

      // Reconnect
      (channel as any).connected = true;
      await (channel as any).flushOutgoingQueue();

      // Group messages get prefixed when flushed
      expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
        text: 'Andy: Queued message',
      });
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeSocket.end).toHaveBeenCalled();
    });
  });

  // --- QR code and auth ---

  describe('authentication', () => {
    it('exits process when QR code is emitted (no auth state)', async () => {
      vi.useFakeTimers();
      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Start connect but don't await (it won't resolve - process exits)
      channel.connect().catch(() => {});

      // Flush microtasks so connectInternal registers handlers
      await vi.advanceTimersByTimeAsync(0);

      // Emit QR code event
      fakeSocket._ev.emit('connection.update', { qr: 'some-qr-data' });

      // Advance timer past the 1000ms setTimeout before exit
      await vi.advanceTimersByTimeAsync(1500);

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
      vi.useRealTimers();
    });
  });

  // --- Reconnection behavior ---

  describe('reconnection', () => {
    it('reconnects on non-loggedOut disconnect', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);

      // Disconnect with a non-loggedOut reason (e.g., connectionClosed = 428)
      triggerDisconnect(428);

      expect(channel.isConnected()).toBe(false);
      // The channel should attempt to reconnect (calls connectInternal again)
    });

    it('exits on loggedOut disconnect', async () => {
      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect with loggedOut reason (401)
      triggerDisconnect(401);

      expect(channel.isConnected()).toBe(false);
      expect(mockExit).toHaveBeenCalledWith(0);
      mockExit.mockRestore();
    });

    it('retries reconnection after 5s on failure', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Disconnect with stream error 515
      triggerDisconnect(515);

      // The channel sets a 5s retry — just verify it doesn't crash
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-1',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Hello Andy' },
          pushName: 'Alice',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'registered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          id: 'msg-1',
          content: 'Hello Andy',
          sender_name: 'Alice',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-2',
            remoteJid: 'unregistered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Hello' },
          pushName: 'Bob',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'unregistered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores status@broadcast messages', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-3',
            remoteJid: 'status@broadcast',
            fromMe: false,
          },
          message: { conversation: 'Status update' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages with no content', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-4',
            remoteJid: 'registered@g.us',
            fromMe: false,
          },
          message: null,
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts text from extendedTextMessage', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-5',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            extendedTextMessage: { text: 'A reply message' },
          },
          pushName: 'Charlie',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ content: 'A reply message' }),
      );
    });

    it('extracts caption from imageMessage', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-6',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            imageMessage: {
              caption: 'Check this photo',
              mimetype: 'image/jpeg',
            },
          },
          pushName: 'Diana',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ content: 'Check this photo' }),
      );
    });

    it('extracts caption from videoMessage', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-7',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            videoMessage: { caption: 'Watch this', mimetype: 'video/mp4' },
          },
          pushName: 'Eve',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ content: 'Watch this' }),
      );
    });

    it('handles message with no extractable text (e.g. voice note without caption)', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-8',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: {
            audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
          },
          pushName: 'Frank',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      // Skipped — no text content to process
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses sender JID when pushName is absent', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-9',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'No push name' },
          // pushName is undefined
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({ sender_name: '5551234' }),
      );
    });
  });

  // --- LID ↔ JID translation ---

  describe('LID to JID translation', () => {
    it('translates known LID to phone JID', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          '1234567890@s.whatsapp.net': {
            name: 'Self Chat',
            folder: 'self-chat',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // The socket has lid '9876543210:1@lid' → phone '1234567890@s.whatsapp.net'
      // Send a message from the LID
      await triggerMessages([
        {
          key: {
            id: 'msg-lid',
            remoteJid: '9876543210@lid',
            fromMe: false,
          },
          message: { conversation: 'From LID' },
          pushName: 'Self',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      // Should be translated to phone JID
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '1234567890@s.whatsapp.net',
        expect.any(String),
        undefined,
        'whatsapp',
        false,
      );
    });

    it('passes through non-LID JIDs unchanged', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-normal',
            remoteJid: 'registered@g.us',
            participant: '5551234@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Normal JID' },
          pushName: 'Grace',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'registered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
    });

    it('passes through unknown LID JIDs unchanged', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await triggerMessages([
        {
          key: {
            id: 'msg-unknown-lid',
            remoteJid: '0000000000@lid',
            fromMe: false,
          },
          message: { conversation: 'Unknown LID' },
          pushName: 'Unknown',
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ]);

      // Unknown LID passes through unchanged
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '0000000000@lid',
        expect.any(String),
        undefined,
        'whatsapp',
        false,
      );
    });
  });

  // --- Outgoing message queue ---

  describe('outgoing message queue', () => {
    it('sends message directly when connected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('test@g.us', 'Hello');
      // Group messages get prefixed with assistant name
      expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
        text: 'Andy: Hello',
      });
    });

    it('prefixes direct chat messages on shared number', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.sendMessage('123@s.whatsapp.net', 'Hello');
      // Shared number: DMs also get prefixed (needed for self-chat distinction)
      expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
        '123@s.whatsapp.net',
        { text: 'Andy: Hello' },
      );
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Don't connect — channel starts disconnected
      await channel.sendMessage('test@g.us', 'Queued');
      expect(fakeSocket.sendMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Make sendMessage fail
      fakeSocket.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      await channel.sendMessage('test@g.us', 'Will fail');

      // Should not throw, message queued for retry
      // The queue should have the message
    });

    it('flushes multiple queued messages in order', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('test@g.us', 'First');
      await channel.sendMessage('test@g.us', 'Second');
      await channel.sendMessage('test@g.us', 'Third');

      // Connect — flush happens automatically on open
      await connectChannel(channel);

      // Give the async flush time to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeSocket.sendMessage).toHaveBeenCalledTimes(3);
      // Group messages get prefixed
      expect(fakeSocket.sendMessage).toHaveBeenNthCalledWith(1, 'test@g.us', {
        text: 'Andy: First',
      });
      expect(fakeSocket.sendMessage).toHaveBeenNthCalledWith(2, 'test@g.us', {
        text: 'Andy: Second',
      });
      expect(fakeSocket.sendMessage).toHaveBeenNthCalledWith(3, 'test@g.us', {
        text: 'Andy: Third',
      });
    });
  });

  // --- Group metadata sync ---

  describe('group metadata sync', () => {
    it('syncs group metadata on first connection', async () => {
      fakeSocket.groupFetchAllParticipating.mockResolvedValue({
        'group1@g.us': { subject: 'Group One' },
        'group2@g.us': { subject: 'Group Two' },
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Wait for async sync to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeSocket.groupFetchAllParticipating).toHaveBeenCalled();
      expect(updateChatName).toHaveBeenCalledWith('group1@g.us', 'Group One');
      expect(updateChatName).toHaveBeenCalledWith('group2@g.us', 'Group Two');
      expect(setLastGroupSync).toHaveBeenCalled();
    });

    it('skips sync when synced recently', async () => {
      // Last sync was 1 hour ago (within 24h threshold)
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await new Promise((r) => setTimeout(r, 50));

      expect(fakeSocket.groupFetchAllParticipating).not.toHaveBeenCalled();
    });

    it('forces sync regardless of cache', async () => {
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      fakeSocket.groupFetchAllParticipating.mockResolvedValue({
        'group@g.us': { subject: 'Forced Group' },
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.syncGroupMetadata(true);

      expect(fakeSocket.groupFetchAllParticipating).toHaveBeenCalled();
      expect(updateChatName).toHaveBeenCalledWith('group@g.us', 'Forced Group');
    });

    it('handles group sync failure gracefully', async () => {
      fakeSocket.groupFetchAllParticipating.mockRejectedValue(
        new Error('Network timeout'),
      );

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Should not throw
      await expect(channel.syncGroupMetadata(true)).resolves.toBeUndefined();
    });

    it('skips groups with no subject', async () => {
      fakeSocket.groupFetchAllParticipating.mockResolvedValue({
        'group1@g.us': { subject: 'Has Subject' },
        'group2@g.us': { subject: '' },
        'group3@g.us': {},
      });

      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      // Clear any calls from the automatic sync on connect
      vi.mocked(updateChatName).mockClear();

      await channel.syncGroupMetadata(true);

      expect(updateChatName).toHaveBeenCalledTimes(1);
      expect(updateChatName).toHaveBeenCalledWith('group1@g.us', 'Has Subject');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns @g.us JIDs (WhatsApp groups)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(true);
    });

    it('owns @s.whatsapp.net JIDs (WhatsApp DMs)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends composing presence when typing', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('test@g.us', true);
      expect(fakeSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        'composing',
        'test@g.us',
      );
    });

    it('sends paused presence when stopping', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      await channel.setTyping('test@g.us', false);
      expect(fakeSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        'paused',
        'test@g.us',
      );
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new WhatsAppChannel(opts);

      await connectChannel(channel);

      fakeSocket.sendPresenceUpdate.mockRejectedValueOnce(new Error('Failed'));

      // Should not throw
      await expect(
        channel.setTyping('test@g.us', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "whatsapp"', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect(channel.name).toBe('whatsapp');
    });

    it('does not expose prefixAssistantName (prefix handled internally)', () => {
      const channel = new WhatsAppChannel(createTestOpts());
      expect('prefixAssistantName' in channel).toBe(false);
    });
  });
});
