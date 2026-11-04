/**
 * slack-lib — request/error shaping of the shared fetch-based Web API client
 * and the per-instance bot-token env-key convention.
 *
 * Pinned invariants: Slack's error strings surface in thrown messages; token
 * values never do (Authorization header is the only place a token travels).
 * All fetches are mocked — no live Slack calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  botTokenKeyForInstance,
  SlackApiError,
  slackAuthTest,
  slackCall,
  slackConversationsInfo,
  slackConversationsMembers,
  slackConversationsOpen,
  slackPostMessage,
} from './slack-lib.js';

const TOKEN = 'xoxb-secret-test-token-value';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl as (...args: unknown[]) => Promise<Response>);
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function captureError(promise: Promise<unknown>): Promise<SlackApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SlackApiError);
    return err as SlackApiError;
  }
  throw new Error('expected the call to throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slackCall request shaping', () => {
  it('POSTs the method to slack.com/api with a JSON body, bearer token, and a timeout signal', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true, stuff: 1 }));

    const json = await slackCall(TOKEN, 'chat.postMessage', { channel: 'C1', text: 'hi' }, 'my-step');

    expect(json).toMatchObject({ ok: true, stuff: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hi' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('slackCall error shaping', () => {
  it("surfaces Slack's error string with the method and step — never the token", async () => {
    mockFetch(async () => jsonResponse({ ok: false, error: 'channel_not_found' }));

    const err = await captureError(slackCall(TOKEN, 'conversations.info', { channel: 'C9' }, 'room-lookup'));

    expect(err.name).toBe('SlackApiError');
    expect(err.step).toBe('room-lookup');
    expect(err.message).toBe('slack conversations.info failed: channel_not_found');
    expect(err.message).not.toContain(TOKEN);
  });

  it('falls back to the HTTP status when ok:false carries no error string', async () => {
    mockFetch(async () => jsonResponse({ ok: false }, 429));

    const err = await captureError(slackCall(TOKEN, 'auth.test', {}, 's'));

    expect(err.message).toBe('slack auth.test failed: HTTP 429');
  });

  it('wraps fetch-level failures (network error / timeout abort) without leaking the token', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const err = await captureError(slackCall(TOKEN, 'auth.test', {}, 'origin-auth'));

    expect(err.step).toBe('origin-auth');
    expect(err.message).toBe('slack auth.test failed: The operation was aborted due to timeout');
    expect(err.message).not.toContain(TOKEN);
  });

  it('reports non-JSON bodies as HTTP <status>, non-JSON body', async () => {
    mockFetch(async () => new Response('<html>bad gateway</html>', { status: 502 }));

    const err = await captureError(slackCall(TOKEN, 'chat.postMessage', { channel: 'C1' }, 's'));

    expect(err.message).toBe('slack chat.postMessage failed: HTTP 502, non-JSON body');
  });
});

describe('slackAuthTest', () => {
  it('maps user_id/team_id/team/url from the response', async () => {
    mockFetch(async () =>
      jsonResponse({ ok: true, user_id: 'U123', team_id: 'T456', team: 'acme', url: 'https://acme.slack.com/' }),
    );

    await expect(slackAuthTest(TOKEN, 's')).resolves.toEqual({
      userId: 'U123',
      teamId: 'T456',
      team: 'acme',
      url: 'https://acme.slack.com/',
    });
  });

  it('throws when the response has no user_id', async () => {
    mockFetch(async () => jsonResponse({ ok: true }));

    const err = await captureError(slackAuthTest(TOKEN, 'origin-auth'));

    expect(err.step).toBe('origin-auth');
    expect(err.message).toBe('slack auth.test failed: no user_id in response');
  });
});

describe('slackConversationsOpen', () => {
  it('joins user ids with commas and returns the channel id', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true, channel: { id: 'D777' } }));

    await expect(slackConversationsOpen(TOKEN, ['U1', 'U2', 'U3'], 's')).resolves.toBe('D777');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ users: 'U1,U2,U3' });
  });

  it('throws when the response has no channel id', async () => {
    mockFetch(async () => jsonResponse({ ok: true, channel: {} }));

    const err = await captureError(slackConversationsOpen(TOKEN, ['U1'], 'dm-open'));

    expect(err.step).toBe('dm-open');
    expect(err.message).toBe('slack conversations.open failed: no channel id in response');
  });
});

describe('slackPostMessage', () => {
  it('posts channel and text', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true }));

    await slackPostMessage(TOKEN, 'C1', 'hello there');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hello there' });
  });

  it('tags failures with the generic default step unless the caller passes one', async () => {
    mockFetch(async () => jsonResponse({ ok: false, error: 'not_in_channel' }));

    const defaulted = await captureError(slackPostMessage(TOKEN, 'C1', 'x'));
    expect(defaulted.step).toBe('post-message');

    mockFetch(async () => jsonResponse({ ok: false, error: 'not_in_channel' }));
    const explicit = await captureError(slackPostMessage(TOKEN, 'C1', 'x', 'welcome-post'));
    expect(explicit.step).toBe('welcome-post');
  });
});

describe('slackConversationsInfo', () => {
  it('classifies MPIMs and passes name/creator through', async () => {
    mockFetch(async () =>
      jsonResponse({ ok: true, channel: { is_mpim: true, name: 'mpdm-a--b--c-1', creator: 'U1' } }),
    );

    await expect(slackConversationsInfo(TOKEN, 'G123', 's')).resolves.toEqual({
      isMpim: true,
      name: 'mpdm-a--b--c-1',
      creator: 'U1',
    });
  });

  it('defaults isMpim to false and omits absent fields', async () => {
    mockFetch(async () => jsonResponse({ ok: true, channel: {} }));

    await expect(slackConversationsInfo(TOKEN, 'C123', 's')).resolves.toEqual({
      isMpim: false,
      name: undefined,
      creator: undefined,
    });
  });
});

describe('slackConversationsMembers', () => {
  it('follows next_cursor pagination and concatenates string member ids', async () => {
    const pages = [
      jsonResponse({ ok: true, members: ['U1', 'U2', 42], response_metadata: { next_cursor: 'cur2' } }),
      jsonResponse({ ok: true, members: ['U3'], response_metadata: { next_cursor: '' } }),
    ];
    const fetchMock = mockFetch(async () => {
      const page = pages.shift();
      if (!page) throw new Error('unexpected extra page fetch');
      return page;
    });

    await expect(slackConversationsMembers(TOKEN, 'G1', 's')).resolves.toEqual(['U1', 'U2', 'U3']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(firstBody).toEqual({ channel: 'G1', limit: 200 });
    expect(secondBody).toEqual({ channel: 'G1', limit: 200, cursor: 'cur2' });
  });

  it('stops at the page cap even if Slack keeps returning cursors', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ ok: true, members: ['U1'], response_metadata: { next_cursor: 'again' } }),
    );

    const members = await slackConversationsMembers(TOKEN, 'G1', 's');

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(members).toHaveLength(10);
  });
});

describe('botTokenKeyForInstance', () => {
  it('maps the default instance to SLACK_BOT_TOKEN', () => {
    expect(botTokenKeyForInstance('slack')).toBe('SLACK_BOT_TOKEN');
  });

  it('strips a leading slack- prefix and uppercases the remainder', () => {
    expect(botTokenKeyForInstance('slack-zulu')).toBe('SLACK_BOT_TOKEN_ZULU');
  });

  it('normalizes dashes to underscores', () => {
    expect(botTokenKeyForInstance('slack-growth-bot')).toBe('SLACK_BOT_TOKEN_GROWTH_BOT');
  });

  it('normalizes case', () => {
    expect(botTokenKeyForInstance('slack-Zulu')).toBe('SLACK_BOT_TOKEN_ZULU');
  });

  it('handles keys without the slack- prefix', () => {
    expect(botTokenKeyForInstance('ops-bot')).toBe('SLACK_BOT_TOKEN_OPS_BOT');
  });

  it('strips only the leading slack- prefix, not interior occurrences', () => {
    expect(botTokenKeyForInstance('slack-slack-two')).toBe('SLACK_BOT_TOKEN_SLACK_TWO');
  });
});
