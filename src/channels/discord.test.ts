import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createDiscordAdapter } from '@chat-adapter/discord';
import type { Logger, Message } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { unwrapForwardedSnapshot, unwrapForwards } from './discord.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardPayload(snapshotMessage: Record<string, any> | null, overrides: Record<string, any> = {}) {
  return {
    id: '123',
    content: '',
    attachments: [],
    message_reference: { type: 1, channel_id: 'c1', message_id: 'm1' },
    ...(snapshotMessage ? { message_snapshots: [{ message: snapshotMessage }] } : {}),
    ...overrides,
  };
}

describe('unwrapForwardedSnapshot', () => {
  it('unwraps forwarded text into content with a label', () => {
    const data = forwardPayload({ content: 'hello from the past', attachments: [] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\nhello from the past');
    expect(data).not.toHaveProperty('message_snapshots');
  });

  it('unwraps attachment-only forwards: label + merged attachments', () => {
    const att = { filename: 'photo.png', content_type: 'image/png', size: 1234, url: 'https://cdn.example/photo.png' };
    const data = forwardPayload({ content: '', attachments: [att] });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]');
    expect(data.attachments).toEqual([att]);
  });

  it('merges snapshot attachments after existing ones', () => {
    const existing = { filename: 'own.txt', content_type: 'text/plain', size: 1, url: 'https://cdn.example/own.txt' };
    const fwd = { filename: 'fwd.jpg', content_type: 'image/jpeg', size: 2, url: 'https://cdn.example/fwd.jpg' };
    const data = forwardPayload({ content: 'look', attachments: [fwd] }, { attachments: [existing] });
    unwrapForwardedSnapshot(data);
    expect(data.attachments).toEqual([existing, fwd]);
    expect(data.content).toBe('[Forwarded message]\nlook');
  });

  it('leaves plain messages untouched', () => {
    const data = { id: '1', content: 'hi', attachments: [] };
    unwrapForwardedSnapshot(data);
    expect(data).toEqual({ id: '1', content: 'hi', attachments: [] });
  });

  it('leaves normal replies (type 0) untouched', () => {
    const data = {
      id: '1',
      content: 'a reply',
      attachments: [],
      message_reference: { type: 0, message_id: 'm0' },
      referenced_message: { content: 'original', author: { username: 'alice' } },
    };
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('a reply');
  });

  it('is a no-op when a forward has no snapshots', () => {
    const data = forwardPayload(null);
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('');
    expect(data.attachments).toEqual([]);
  });

  it('joins multiple snapshots', () => {
    const data = forwardPayload(null, {
      message_snapshots: [
        { message: { content: 'one', attachments: [] } },
        { message: { content: 'two', attachments: [] } },
      ],
    });
    unwrapForwardedSnapshot(data);
    expect(data.content).toBe('[Forwarded message]\none\ntwo');
  });
});

describe('unwrapForwards with the installed Discord adapter', () => {
  it('delivers a forwarded attachment once, labeled once', async () => {
    const adapter = createDiscordAdapter({
      botToken: 'test-token',
      publicKey: '0'.repeat(64),
      applicationId: 'app-1',
    });
    unwrapForwards(adapter);
    const received: Message[] = [];
    (adapter as unknown as { chat: unknown }).chat = {
      handleIncomingMessage: async (_adapter: unknown, _threadId: string, message: Message) => {
        received.push(message);
      },
    };

    const att = { filename: 'fwd.jpg', content_type: 'image/jpeg', size: 2, url: 'https://cdn.example/fwd.jpg' };
    await (
      adapter as unknown as { handleForwardedMessage: (d: Record<string, unknown>) => Promise<void> }
    ).handleForwardedMessage(
      forwardPayload(
        { content: 'look', attachments: [att] },
        {
          guild_id: 'g1',
          channel_id: 'c1',
          channel_type: 0,
          timestamp: '2026-01-01T00:00:00.000Z',
          mentions: [],
          author: { id: 'u1', username: 'alice', bot: false },
        },
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0].attachments.map((a) => a.name)).toEqual(['fwd.jpg']);
    expect(received[0].text.match(/\[Forwarded message\]/g)).toHaveLength(1);
    expect(received[0].text.match(/look/g)).toHaveLength(1);
  });
});

// discord.js is the adapter's own dependency, not ours: load the copy the
// adapter imports, so a stub on its Client reaches the adapter's client.
const { Client } = createRequire(fileURLToPath(import.meta.resolve('@chat-adapter/discord')))('discord.js') as {
  Client: { prototype: { login(token?: string): Promise<string>; destroy(): Promise<void> } };
};

describe('gateway forwarding with the installed Discord adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // discord.js handles a packet in the same turn it emits `raw`, and
  // MessageMentions.js patches each mention in place with
  // `Object.assign(mention.member, { user: mention })`. That makes the packet
  // circular, so a forward that serializes it after the turn throws and the
  // message is lost.
  it.each(['MESSAGE_CREATE', 'MESSAGE_UPDATE'])('forwards a guild %s that @mentions someone', async (t) => {
    const webhookUrl = 'http://127.0.0.1/discord-gateway';
    const posts: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: String(init?.body) });
      return new Response(null, { status: 200 });
    });
    const errors: unknown[][] = [];
    const logger: Logger = {
      child: () => logger,
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (...args) => errors.push(args),
    };

    const packet = {
      op: 0,
      s: 1,
      t,
      d: {
        id: 'm1',
        channel_id: 'c1',
        guild_id: 'g1',
        content: '<@app-1> what did we decide?',
        author: { id: 'u1', username: 'alice' },
        member: { roles: [] },
        mentions: [{ id: 'app-1', username: 'NanoClaw', bot: true, member: { roles: [] } }],
      },
    };
    const sent = structuredClone(packet.d);
    vi.spyOn(Client.prototype, 'login').mockImplementation(async function (this: {
      emit(event: string, packet: unknown): boolean;
    }) {
      this.emit('raw', packet);
      for (const mention of packet.d.mentions) Object.assign(mention.member, { user: mention });
      return 'stub';
    });
    vi.spyOn(Client.prototype, 'destroy').mockResolvedValue(undefined);

    const adapter = createDiscordAdapter({
      botToken: 'test-token',
      publicKey: '0'.repeat(64),
      applicationId: 'app-1',
      logger,
    });
    (adapter as unknown as { chat: unknown }).chat = {};
    const stop = new AbortController();
    let listener: Promise<unknown> | undefined;
    await adapter.startGatewayListener(
      {
        waitUntil: (task) => {
          listener = task;
        },
      },
      60_000,
      stop.signal,
      webhookUrl,
    );
    await vi.waitFor(() => expect(posts.length + errors.length).toBeGreaterThan(0));
    stop.abort();
    await listener;

    expect(errors).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(webhookUrl);
    const event = JSON.parse(posts[0].body);
    expect(event.type).toBe(`GATEWAY_${t}`);
    expect(event.data).toEqual(sent);
  });
});
