/**
 * Gateway-forwarding test for the installed `@chat-adapter/discord`. The
 * add-discord skill copies it in beside the registration test and runs it after
 * install, so an install whose adapter lacks the skill's pnpm patch goes red
 * instead of silently dropping every server message that @mentions anyone.
 *
 * discord.js handles a gateway packet in the same turn it emits `raw`, and
 * MessageMentions.js patches each mention in place with
 * `Object.assign(mention.member, { user: mention })`. That makes the packet
 * circular, so an adapter that serializes it after that turn (4.41.1 without
 * the patch) throws "Error forwarding Gateway event" and the message is lost.
 * The test drives `startGatewayListener` the way the Chat SDK bridge does, with
 * `Client.prototype.login` stubbed to emit one raw packet and then apply that
 * mutation, and checks what reaches the webhook.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createDiscordAdapter } from '@chat-adapter/discord';
import type { Logger } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
