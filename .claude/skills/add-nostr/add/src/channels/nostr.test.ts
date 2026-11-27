import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- nostr-tools/pool mock ---

const poolRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class MockPool {
    subscribeCallbacks: Map<number, (event: any) => void> = new Map();
    private subIndex = 0;
    subscribe = vi.fn((relays: string[], filter: any, opts: any) => {
      const idx = this.subIndex++;
      if (opts?.onevent) this.subscribeCallbacks.set(idx, opts.onevent);
      poolRef.current = this;
      return { close: vi.fn() };
    });
    publish = vi.fn(() => [Promise.resolve()]);
    get = vi.fn().mockResolvedValue(null);
    close = vi.fn();

    constructor() {
      poolRef.current = this;
    }
  },
}));

// --- nostr-tools/nip04 mock ---

vi.mock('nostr-tools/nip04', () => ({
  encrypt: vi.fn((_sk: any, _pk: string, text: string) => `encrypted:${text}`),
  decrypt: vi.fn((_sk: any, _pk: string, data: string) => data.replace('encrypted:', '')),
}));

// --- nostr-tools/nip59 mock ---

const DEFAULT_RUMOR = {
  kind: 14,
  pubkey: 'bb'.repeat(32),
  content: 'Hello from Nostr',
  created_at: Math.floor(Date.now() / 1000),
  tags: [['p', 'aa'.repeat(32)]],
  id: 'rumor-id',
};

vi.mock('nostr-tools/nip59', () => ({
  wrapEvent: vi.fn(() => ({
    kind: 1059,
    id: 'wrapped-id',
    pubkey: 'aa'.repeat(32),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', 'bb'.repeat(32)]],
    content: 'encrypted-content',
    sig: 'fake-sig',
  })),
  unwrapEvent: vi.fn(() => ({ ...DEFAULT_RUMOR })),
}));

// --- @noble/hashes/utils mock ---

vi.mock('@noble/hashes/utils.js', () => ({
  bytesToHex: vi.fn((bytes: Uint8Array) => Buffer.from(bytes).toString('hex')),
  hexToBytes: vi.fn((hex: string) => Buffer.from(hex, 'hex')),
}));

// --- nostr-tools/pure mock for finalizeEvent ---

vi.mock('nostr-tools/pure', () => ({
  generateSecretKey: vi.fn(() => new Uint8Array(32)),
  getPublicKey: vi.fn(() => 'aa'.repeat(32)),
  finalizeEvent: vi.fn((event: any, _sk: any) => ({
    ...event,
    id: 'signed-id',
    sig: 'fake-sig',
  })),
}));

import { NostrChannel, NostrChannelOpts } from './nostr.js';
import * as nip04 from 'nostr-tools/nip04';
import * as nip59 from 'nostr-tools/nip59';

// Access mocked logger via vi.mocked import
const { logger } = await vi.importMock<typeof import('../logger.js')>('../logger.js');

// --- Constants ---

const OUR_PRIVKEY_HEX = '11'.repeat(32); // 64-char hex
const OUR_PUBKEY = 'aa'.repeat(32);      // returned by mocked getPublicKey
const USER_PUBKEY = 'bb'.repeat(32);     // configured user
const TEST_RELAYS = ['wss://relay.example.com'];

// --- Test helpers ---

function createTestOpts(overrides?: Partial<NostrChannelOpts>): NostrChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      [`nostr:${'bb'.repeat(32)}`]: {
        name: 'Nostr User',
        folder: 'nostr-user',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createChannel(
  opts: NostrChannelOpts,
  userPubkey: string = USER_PUBKEY,
): NostrChannel {
  return new NostrChannel(OUR_PRIVKEY_HEX, userPubkey, TEST_RELAYS, opts);
}

// subIndex: 0 = gift wrap (kind 1059), 1 = NIP-04 (kind 4)
async function triggerOnevent(event: any = { kind: 1059 }, subIndex = 0): Promise<void> {
  const pool = poolRef.current;
  const cb = pool?.subscribeCallbacks.get(subIndex);
  if (cb) {
    await cb(event);
    // Allow microtasks (handlers are async via .catch)
    await new Promise((r) => setTimeout(r, 0));
  }
}

// --- Tests ---

describe('NostrChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolRef.current = null;
    // Reset unwrapEvent to default rumor
    vi.mocked(nip59.unwrapEvent).mockReturnValue({ ...DEFAULT_RUMOR } as any);
    // Reset wrapEvent to default (returns a valid wrapped event)
    vi.mocked(nip59.wrapEvent).mockReturnValue({
      kind: 1059,
      id: 'wrapped-id',
      pubkey: OUR_PUBKEY,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', USER_PUBKEY]],
      content: 'encrypted-content',
      sig: 'fake-sig',
    } as any);
    // Reset NIP-04 mocks
    vi.mocked(nip04.encrypt).mockImplementation((_sk: any, _pk: string, text: string) => `encrypted:${text}`);
    vi.mocked(nip04.decrypt).mockImplementation((_sk: any, _pk: string, data: string) => data.replace('encrypted:', ''));
  });

  afterEach(() => {
    // Note: do NOT use vi.restoreAllMocks() here — it undoes vi.mock() factories
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when pool is created', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();

      expect(poolRef.current).not.toBeNull();
    });

    it('subscribes to kind 1059 events with our pubkey filter', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();

      expect(poolRef.current.subscribe).toHaveBeenCalledWith(
        TEST_RELAYS,
        { kinds: [1059], '#p': [OUR_PUBKEY] },
        expect.objectContaining({ onevent: expect.any(Function) }),
      );
    });

    it('emits chat metadata for configured user pubkey on connect', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        `nostr:${USER_PUBKEY}`,
        expect.any(String),
        undefined,
        'nostr',
        false,
      );
    });

    it('logs user pubkey in connect info', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ pubkey: OUR_PUBKEY, userPubkey: USER_PUBKEY }),
        expect.any(String),
      );
    });

    it('does not emit metadata when no user pubkey configured', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts, '');

      await channel.connect();

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('disconnects cleanly (closes subscriptions and pool)', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();
      const pool = poolRef.current;
      const sub = pool.subscribe.mock.results[0].value;

      await channel.disconnect();

      expect(sub.close).toHaveBeenCalled();
      expect(pool.close).toHaveBeenCalledWith(TEST_RELAYS);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns true after connect', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false after disconnect', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Inbound DM handling ---

  describe('inbound DM handling', () => {
    it('unwraps gift-wrapped DM and delivers to onMessage for registered chat', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(nip59.unwrapEvent).toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        `nostr:${USER_PUBKEY}`,
        expect.objectContaining({
          content: 'Hello from Nostr',
          chat_jid: `nostr:${USER_PUBKEY}`,
        }),
      );
    });

    it('calls onChatMetadata for all validated DMs (even unregistered)', async () => {
      // registeredGroups returns empty map — but metadata should still fire
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        `nostr:${USER_PUBKEY}`,
        expect.any(String),
        expect.any(String),
        'nostr',
        false,
      );
    });

    it('does not deliver message for unregistered chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-kind-14 rumors (e.g. kind 1)', async () => {
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        kind: 1,
      } as any);

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips own messages (rumor.pubkey === our pubkey)', async () => {
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        pubkey: OUR_PUBKEY,
      } as any);

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips empty content messages', async () => {
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        content: '   ',
      } as any);

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses truncated pubkey as sender name (first 8...last 4)', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      const expectedName = `${USER_PUBKEY.slice(0, 8)}...${USER_PUBKEY.slice(-4)}`;
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sender_name: expectedName }),
      );
    });

    it('constructs correct nostr: JID from sender pubkey', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).toHaveBeenCalledWith(
        `nostr:${USER_PUBKEY}`,
        expect.objectContaining({ chat_jid: `nostr:${USER_PUBKEY}` }),
      );
    });

    it('converts created_at unix timestamp to ISO string', async () => {
      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        created_at: unixTime,
      } as any);

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timestamp: '2024-01-01T00:00:00.000Z' }),
      );
    });

    it('handles unwrap failure gracefully (logs debug, does not throw)', async () => {
      vi.mocked(nip59.unwrapEvent).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      // Should not throw
      await expect(triggerOnevent({ kind: 1059 })).resolves.toBeUndefined();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        expect.stringContaining('Failed to unwrap'),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Sender validation ---

  describe('sender validation', () => {
    it('accepts DMs from configured user pubkey', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts, USER_PUBKEY);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('rejects DMs from unknown pubkey when user pubkey is configured', async () => {
      const strangerPubkey = 'cc'.repeat(32);
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        pubkey: strangerPubkey,
      } as any);

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          [`nostr:${strangerPubkey}`]: {
            name: 'Stranger',
            folder: 'stranger',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = createChannel(opts, USER_PUBKEY);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('accepts DMs from any registered pubkey when no user pubkey configured', async () => {
      const anyPubkey = 'dd'.repeat(32);
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        pubkey: anyPubkey,
      } as any);

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          [`nostr:${anyPubkey}`]: {
            name: 'Anyone',
            folder: 'anyone',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      // empty string userPubkey = accept all
      const channel = createChannel(opts, '');
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('logs rejection with expected vs actual pubkey', async () => {
      const strangerPubkey = 'ee'.repeat(32);
      vi.mocked(nip59.unwrapEvent).mockReturnValue({
        ...DEFAULT_RUMOR,
        pubkey: strangerPubkey,
      } as any);

      const opts = createTestOpts();
      const channel = createChannel(opts, USER_PUBKEY);
      await channel.connect();

      await triggerOnevent({ kind: 1059 });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: strangerPubkey,
          expected: USER_PUBKEY,
        }),
        expect.any(String),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('encrypts and publishes DM via pool using NIP-04', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hello Nostr');

      expect(nip04.encrypt).toHaveBeenCalled();
      expect(poolRef.current.publish).toHaveBeenCalled();
    });

    it('encrypts with recipient pubkey stripped of nostr: prefix', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi');

      expect(nip04.encrypt).toHaveBeenCalledWith(
        expect.anything(),
        USER_PUBKEY,
        'Hi',
      );
    });

    it('queries recipient kind 10050 relay preferences', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi');

      expect(poolRef.current.get).toHaveBeenCalledWith(
        TEST_RELAYS,
        expect.objectContaining({ kinds: [10050], authors: [USER_PUBKEY] }),
      );
    });

    it('falls back to own relays when no 10050 found (default mock returns null)', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      // pool.get returns null by default
      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi');

      expect(poolRef.current.publish).toHaveBeenCalledWith(
        TEST_RELAYS,
        expect.anything(),
      );
    });

    it('handles send failure gracefully (encrypt throws)', async () => {
      vi.mocked(nip04.encrypt).mockImplementation(() => {
        throw new Error('Encrypt failed');
      });

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await expect(
        channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi'),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: `nostr:${USER_PUBKEY}` }),
        expect.any(String),
      );
    });

    it('does nothing when pool is not initialized', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      // Don't call connect
      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'No pool');

      expect(nip04.encrypt).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // --- Recipient relay lookup ---

  describe('recipient relay lookup', () => {
    it('returns relays from kind 10050 event', async () => {
      const recipientRelays = ['wss://recipient-relay.example.com'];
      poolRef.current = null;

      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      // Override pool.get to return an event with relay tags
      poolRef.current.get.mockResolvedValueOnce({
        kind: 10050,
        tags: [['relay', recipientRelays[0]]],
      });

      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi');

      expect(poolRef.current.publish).toHaveBeenCalledWith(
        recipientRelays,
        expect.anything(),
      );
    });

    it('returns own relays when recipient has no 10050', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      // pool.get returns null (default) — fall back to own relays
      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi');

      expect(poolRef.current.publish).toHaveBeenCalledWith(
        TEST_RELAYS,
        expect.anything(),
      );
    });

    it('returns own relays on query error', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      poolRef.current.get.mockRejectedValueOnce(new Error('Query failed'));

      await channel.sendMessage(`nostr:${USER_PUBKEY}`, 'Hi');

      expect(poolRef.current.publish).toHaveBeenCalledWith(
        TEST_RELAYS,
        expect.anything(),
      );
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns nostr: JIDs', () => {
      const channel = createChannel(createTestOpts());
      expect(channel.ownsJid(`nostr:${USER_PUBKEY}`)).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = createChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own @g.us JIDs', () => {
      const channel = createChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own @s.whatsapp.net JIDs', () => {
      const channel = createChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown format JIDs', () => {
      const channel = createChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- generateKeypair ---

  describe('generateKeypair', () => {
    it('returns hex private key and public key', () => {
      const keypair = NostrChannel.generateKeypair();

      expect(keypair).toHaveProperty('privateKey');
      expect(keypair).toHaveProperty('publicKey');
      expect(typeof keypair.privateKey).toBe('string');
      expect(typeof keypair.publicKey).toBe('string');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "nostr"', () => {
      const channel = createChannel(createTestOpts());
      expect(channel.name).toBe('nostr');
    });
  });
});
