import { describe, expect, it, vi } from 'vitest';

import { buildDiscordResolver } from './discord-resolver.js';

function mockFetch(handlers: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const match = Object.keys(handlers).find((k) => url.startsWith(k));
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    const body = handlers[match];
    if (body instanceof Error) throw body;
    if (typeof body === 'object' && body !== null && 'status' in body && (body as { status?: number }).status) {
      const r = body as { status: number; statusText?: string; body?: string };
      return new Response(r.body ?? '', { status: r.status, statusText: r.statusText ?? '' });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('buildDiscordResolver', () => {
  it('returns empty resolver when token is missing', async () => {
    const r = await buildDiscordResolver('');
    expect(r.stats()).toMatchObject({ guilds: 0, channels: 0, dms: 0 });
    expect(r.stats().reason).toMatch(/no DISCORD_BOT_TOKEN/);
    expect(r.resolve('any')).toBeNull();
  });

  it('resolves channels to guild-prefixed platform ids', async () => {
    const fetchImpl = mockFetch({
      'https://discord.com/api/v10/users/@me/guilds': [
        { id: 'g1', name: 'Guild 1' },
        { id: 'g2', name: 'Guild 2' },
      ],
      'https://discord.com/api/v10/guilds/g1/channels': [{ id: 'c1' }, { id: 'c2' }],
      'https://discord.com/api/v10/guilds/g2/channels': [{ id: 'c3' }],
    });

    const r = await buildDiscordResolver('valid-token', [], fetchImpl);

    expect(r.stats()).toEqual({ guilds: 2, channels: 3, dms: 0 });
    expect(r.resolve('c1')).toBe('discord:g1:c1');
    expect(r.resolve('c2')).toBe('discord:g1:c2');
    expect(r.resolve('c3')).toBe('discord:g2:c3');
    expect(r.resolve('cX')).toBeNull();
  });

  it('returns disabled resolver on 401', async () => {
    const fetchImpl = mockFetch({
      'https://discord.com/api/v10/users/@me/guilds': {
        status: 401,
        statusText: 'Unauthorized',
        body: '{"message":"401: Unauthorized","code":0}',
      },
    });

    const r = await buildDiscordResolver('bad-token', [], fetchImpl);
    expect(r.stats().guilds).toBe(0);
    expect(r.stats().reason).toMatch(/401/);
    expect(r.resolve('c1')).toBeNull();
  });

  it('keeps partial results when one guild lookup fails', async () => {
    const fetchImpl = mockFetch({
      'https://discord.com/api/v10/users/@me/guilds': [
        { id: 'g1', name: 'Good Guild' },
        { id: 'g2', name: 'Bad Guild' },
      ],
      'https://discord.com/api/v10/guilds/g1/channels': [{ id: 'c1' }],
      'https://discord.com/api/v10/guilds/g2/channels': {
        status: 403,
        statusText: 'Forbidden',
        body: '{}',
      },
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await buildDiscordResolver('valid-token', [], fetchImpl);
    errSpy.mockRestore();

    expect(r.resolve('c1')).toBe('discord:g1:c1');
    expect(r.stats().guilds).toBe(2);
    expect(r.stats().channels).toBe(1);
  });

  it('paginates the guild list', async () => {
    // First page: 200 guilds (g0..g199); second page: 1 guild (g200); third call would not happen.
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }));
    const page2 = [{ id: 'g200', name: 'G200' }];
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/users/@me/guilds')) {
        call++;
        const body = call === 1 ? page1 : page2;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      // Every guild has one channel named after itself
      const m = /\/guilds\/([^/]+)\/channels/.exec(url);
      const gid = m ? m[1] : '';
      return new Response(JSON.stringify([{ id: `c-${gid}` }]), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await buildDiscordResolver('valid-token', [], fetchImpl);

    expect(r.stats().guilds).toBe(201);
    expect(r.stats().channels).toBe(201);
    expect(r.resolve('c-g0')).toBe('discord:g0:c-g0');
    expect(r.resolve('c-g200')).toBe('discord:g200:c-g200');
  });

  it('classifies unresolved ids as DMs and emits discord:@me:<id>', async () => {
    const fetchImpl = mockFetch({
      'https://discord.com/api/v10/users/@me/guilds': [{ id: 'g1', name: 'G1' }],
      'https://discord.com/api/v10/guilds/g1/channels': [{ id: 'guild-chan' }],
      // dmId is a 1:1 DM (type=1)
      'https://discord.com/api/v10/channels/dmId': { id: 'dmId', type: 1 },
      // groupDmId is a multi-recipient DM (type=3)
      'https://discord.com/api/v10/channels/groupDmId': { id: 'groupDmId', type: 3 },
    });

    const r = await buildDiscordResolver('valid-token', ['guild-chan', 'dmId', 'groupDmId'], fetchImpl);

    expect(r.stats()).toEqual({ guilds: 1, channels: 1, dms: 2 });
    expect(r.resolve('guild-chan')).toBe('discord:g1:guild-chan');
    expect(r.resolve('dmId')).toBe('discord:@me:dmId');
    expect(r.resolve('groupDmId')).toBe('discord:@me:groupDmId');
  });

  it('leaves ids unresolved when classify returns 404 or non-DM type', async () => {
    const fetchImpl = mockFetch({
      'https://discord.com/api/v10/users/@me/guilds': [],
      // 404 — bot has no access (typical when bot was kicked from the guild)
      'https://discord.com/api/v10/channels/orphanId': {
        status: 404,
        statusText: 'Not Found',
        body: '{"message":"Unknown Channel","code":10003}',
      },
      // type=0 — guild text channel in a guild we no longer enumerate (shouldn't happen,
      // but the fallback is conservative: only emit @me for type 1/3)
      'https://discord.com/api/v10/channels/leftoverGuildChan': {
        id: 'leftoverGuildChan',
        type: 0,
      },
    });

    const r = await buildDiscordResolver('valid-token', ['orphanId', 'leftoverGuildChan'], fetchImpl);

    expect(r.stats()).toEqual({ guilds: 0, channels: 0, dms: 0 });
    expect(r.resolve('orphanId')).toBeNull();
    expect(r.resolve('leftoverGuildChan')).toBeNull();
  });

  it('skips classify for ids already found in a guild and dedupes input', async () => {
    let dmCallCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/users/@me/guilds')) {
        return new Response(JSON.stringify([{ id: 'g1', name: 'G1' }]), { status: 200 });
      }
      if (url.includes('/guilds/g1/channels')) {
        return new Response(JSON.stringify([{ id: 'guild-chan' }]), { status: 200 });
      }
      if (url.includes('/channels/dmId')) {
        dmCallCount++;
        return new Response(JSON.stringify({ id: 'dmId', type: 1 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    // 'guild-chan' is in the guild map (skip classify); 'dmId' appears twice
    // in the input (classify exactly once).
    const r = await buildDiscordResolver('valid-token', ['guild-chan', 'dmId', 'dmId'], fetchImpl);

    expect(dmCallCount).toBe(1);
    expect(r.resolve('guild-chan')).toBe('discord:g1:guild-chan');
    expect(r.resolve('dmId')).toBe('discord:@me:dmId');
  });
});
