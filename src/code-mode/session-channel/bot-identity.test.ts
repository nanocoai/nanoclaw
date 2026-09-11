/**
 * The bot identity lookup against a fake platform: auth.test success is
 * cached beside the install state and reused without a second call; a
 * refusal, an outage or a malformed answer resolve null (the binding goes
 * on without an id); the token never lands in the cache file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { botIdentityFile, readCachedBotIdentity, resolveBotIdentity, slackAuthTest } from './bot-identity.js';

let root: string;

type Reply = { status: number; body?: unknown } | (() => never);

function fakePlatform(replies: Reply[]) {
  const calls: Array<{ url: string; authorization: string | undefined; method: string | undefined }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), authorization: headers.authorization, method: init?.method });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected call');
    if (typeof reply === 'function') reply();
    const r = reply as { status: number; body?: unknown };
    return new Response(r.body === undefined ? 'not json' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-bot-'));
  fs.mkdirSync(path.join(root, 'data'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('slackAuthTest', () => {
  it('posts the bearer to auth.test and returns the bot user and workspace', async () => {
    const p = fakePlatform([{ status: 200, body: { ok: true, user_id: 'U0BOT1', team_id: 'T0TEAM1', bot_id: 'B1' } }]);
    const identity = await slackAuthTest('xoxb-secret', { fetch: p.fetchFn });
    expect(identity).toEqual({ botUserId: 'U0BOT1', teamId: 'T0TEAM1' });
    expect(p.calls[0]).toEqual({
      url: 'https://slack.com/api/auth.test',
      authorization: 'Bearer xoxb-secret',
      method: 'POST',
    });
  });

  it('a refusal, an outage, a non-JSON body and a malformed answer all resolve null', async () => {
    expect(
      await slackAuthTest('t', {
        fetch: fakePlatform([{ status: 200, body: { ok: false, error: 'invalid_auth' } }]).fetchFn,
      }),
    ).toBeNull();
    expect(await slackAuthTest('t', { fetch: fakePlatform([{ status: 503, body: {} }]).fetchFn })).toBeNull();
    expect(await slackAuthTest('t', { fetch: fakePlatform([{ status: 200 }]).fetchFn })).toBeNull();
    expect(
      await slackAuthTest('t', {
        fetch: fakePlatform([{ status: 200, body: { ok: true, user_id: 'not-an-id' } }]).fetchFn,
      }),
    ).toBeNull();
    const down = fakePlatform([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    expect(await slackAuthTest('t', { fetch: down.fetchFn })).toBeNull();
  });

  it('a workspace id that does not look like one is dropped, the user id kept', async () => {
    const p = fakePlatform([{ status: 200, body: { ok: true, user_id: 'W0ENT1', team_id: 'lowercase' } }]);
    expect(await slackAuthTest('t', { fetch: p.fetchFn })).toEqual({ botUserId: 'W0ENT1' });
  });
});

describe('resolveBotIdentity', () => {
  it('looks the bot up once, caches the answer by app id, and never writes the token', async () => {
    const p = fakePlatform([{ status: 200, body: { ok: true, user_id: 'U0BOT1', team_id: 'T0TEAM1' } }]);
    const first = await resolveBotIdentity({ root, appId: 'A1', botToken: 'xoxb-secret', fetch: p.fetchFn });
    expect(first).toEqual({ botUserId: 'U0BOT1', teamId: 'T0TEAM1' });
    const raw = fs.readFileSync(botIdentityFile(root), 'utf8');
    expect(raw).not.toContain('xoxb');
    expect(JSON.parse(raw)).toMatchObject({ appId: 'A1', botUserId: 'U0BOT1', teamId: 'T0TEAM1' });
    expect(await readCachedBotIdentity(root, 'A1')).toEqual({ botUserId: 'U0BOT1', teamId: 'T0TEAM1' });

    const second = await resolveBotIdentity({ root, appId: 'A1', botToken: 'xoxb-secret', fetch: p.fetchFn });
    expect(second).toEqual(first);
    expect(p.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a cache for another app is ignored; without a token there is nothing to look up', async () => {
    fs.writeFileSync(botIdentityFile(root), JSON.stringify({ appId: 'A9', botUserId: 'U9', checkedAt: 'x' }));
    const p = fakePlatform([]);
    expect(await resolveBotIdentity({ root, appId: 'A1', fetch: p.fetchFn })).toBeNull();
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(await readCachedBotIdentity(root, 'A9')).toEqual({ botUserId: 'U9' });
  });

  it('a failed lookup resolves null and caches nothing, so the next attempt asks again', async () => {
    const p = fakePlatform([
      { status: 200, body: { ok: false, error: 'invalid_auth' } },
      { status: 200, body: { ok: true, user_id: 'U0BOT1', team_id: 'T0TEAM1' } },
    ]);
    expect(await resolveBotIdentity({ root, appId: 'A1', botToken: 't', fetch: p.fetchFn })).toBeNull();
    expect(fs.existsSync(botIdentityFile(root))).toBe(false);
    expect(await resolveBotIdentity({ root, appId: 'A1', botToken: 't', fetch: p.fetchFn })).toEqual({
      botUserId: 'U0BOT1',
      teamId: 'T0TEAM1',
    });
  });

  it('a malformed cache file reads as absent', async () => {
    fs.writeFileSync(botIdentityFile(root), '{"appId":"A1","botUserId":');
    expect(await readCachedBotIdentity(root, 'A1')).toBeNull();
  });
});
