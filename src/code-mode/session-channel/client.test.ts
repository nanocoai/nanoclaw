/**
 * The service client against a fake service: every route's method, path,
 * bearer and body; the error mapping (coded 4xx → SessionChannelServiceError
 * with the code, unavailable/stopped/gone predicates); origin validation;
 * and the long-poll's query shape.
 */
import { describe, expect, it } from 'vitest';

import {
  isChannelGone,
  isSessionStopped,
  isUnavailable,
  LONG_POLL_MAX_SECONDS,
  SessionChannelClient,
  SessionChannelServiceError,
  validateServiceOrigin,
} from './client.js';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body: unknown } | ((call: Call) => { status: number; body: unknown });

/** A fake service: one reply per call, in order; records what it saw. */
function fakeService(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected call ${call.method} ${call.url}`);
    const r = typeof reply === 'function' ? reply(call) : reply;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const BASE = 'https://slack.example.test';

function client(replies: Reply[]) {
  const service = fakeService(replies);
  return {
    ...service,
    client: new SessionChannelClient({ serviceBase: BASE, token: 'tok-1', fetch: service.fetchFn }),
  };
}

describe('origin validation', () => {
  it('accepts https and loopback http, refuses everything else', () => {
    expect(validateServiceOrigin('https://slack.nanoclaw.dev/')).toBe('https://slack.nanoclaw.dev');
    expect(validateServiceOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(validateServiceOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    for (const bad of ['http://slack.example.test', 'https://u:p@slack.example.test', 'https://x.test/?q=1', 'nope']) {
      expect(() => validateServiceOrigin(bad)).toThrow(SessionChannelServiceError);
    }
  });
});

describe('routes', () => {
  it('create: POST /v1/code-channels with the bearer and the body; created flag split out', async () => {
    const c = client([{ status: 201, body: { channelId: 'C1', sessionId: 'ag-1', status: 'active', created: true } }]);
    const res = await c.client.create({ appId: 'A1', sessionId: 'ag-1', title: 'box' });
    expect(res).toEqual({ channel: { channelId: 'C1', sessionId: 'ag-1', status: 'active' }, created: true });
    expect(c.calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/v1/code-channels`,
      body: { appId: 'A1', sessionId: 'ag-1', title: 'box' },
    });
    expect(c.calls[0].headers.authorization).toBe('Bearer tok-1');
    expect(c.calls[0].headers['content-type']).toBe('application/json');
  });

  it('create on an existing session answers created:false', async () => {
    const c = client([{ status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'active', created: false } }]);
    expect((await c.client.create({ appId: 'A1', sessionId: 'ag-1', title: 'box' })).created).toBe(false);
  });

  it('create carries the member fields for the creating sandbox when given', async () => {
    const c = client([{ status: 201, body: { channelId: 'C1', sessionId: 'ag-1', status: 'active', created: true } }]);
    await c.client.create({
      appId: 'A1',
      sessionId: 'ag-1',
      title: 'box',
      sandboxName: 'box',
      terminalAddress: 'box.alice.example.test',
    });
    expect(c.calls[0].body).toEqual({
      appId: 'A1',
      sessionId: 'ag-1',
      title: 'box',
      sandboxName: 'box',
      terminalAddress: 'box.alice.example.test',
    });
  });

  it('get / status / view / properties / archive / member update hit their paths with their bodies', async () => {
    const c = client([
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'active' } },
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'processing', resumed: true } },
      { status: 200, body: { channelId: 'C1', viewKey: 'diff', type: 'diff', views: 1 } },
      { status: 200, body: { channelId: 'C1', contextBarItems: [] } },
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'closed', archived: true, archivedAt: 't' } },
      { status: 200, body: { channelId: 'C1', member: { botUserId: 'U0BOT1', role: 'owner' } } },
    ]);
    await c.client.get('C1');
    await c.client.setStatus('C1', 'processing', { resume: true });
    await c.client.putView('C1', 'diff', { type: 'diff', content: '--- a\n+++ b\n', name: 'Changes' });
    await c.client.putProperties('C1', { contextBarItems: [{ key: 'repo', label: 'box' }] });
    await c.client.archive('C1', { summary: 'done' });
    await c.client.updateMember('C1', 'U0BOT1', { terminalAddress: 'box.alice.example.test', sandboxName: 'box' });
    expect(c.calls.map((x) => [x.method, x.url.slice(BASE.length), x.body])).toEqual([
      ['GET', '/v1/code-channels/C1', undefined],
      ['POST', '/v1/code-channels/C1/status', { status: 'processing', resume: true }],
      ['PUT', '/v1/code-channels/C1/views/diff', { type: 'diff', content: '--- a\n+++ b\n', name: 'Changes' }],
      ['PUT', '/v1/code-channels/C1/properties', { contextBarItems: [{ key: 'repo', label: 'box' }] }],
      ['POST', '/v1/code-channels/C1/archive', { summary: 'done' }],
      ['PUT', '/v1/code-channels/C1/members/U0BOT1', { terminalAddress: 'box.alice.example.test', sandboxName: 'box' }],
    ]);
  });

  it('status without resume sends no resume key; archive without summary sends an empty body', async () => {
    const c = client([
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'active' } },
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'closed', archived: true, archivedAt: 't' } },
    ]);
    await c.client.setStatus('C1', 'active');
    await c.client.archive('C1');
    expect(c.calls[0].body).toEqual({ status: 'active' });
    expect(c.calls[1].body).toEqual({});
  });

  it('events: long-poll query carries since and a wait capped at the service ceiling', async () => {
    const c = client([
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'active', events: [], cursor: null } },
      {
        status: 200,
        body: {
          channelId: 'C1',
          sessionId: 'ag-1',
          status: 'stopped',
          events: [{ cursor: 'EVT#2', type: 'code_channel.stopped', channelId: 'C1', sessionId: 'ag-1', ts: 't' }],
          cursor: 'EVT#2',
        },
      },
    ]);
    await c.client.events('C1');
    const page = await c.client.events('C1', { since: 'EVT#1', wait: 999 });
    expect(new URL(c.calls[0].url).searchParams.get('wait')).toBe(String(LONG_POLL_MAX_SECONDS));
    expect(new URL(c.calls[0].url).searchParams.has('since')).toBe(false);
    expect(new URL(c.calls[1].url).searchParams.get('since')).toBe('EVT#1');
    expect(new URL(c.calls[1].url).searchParams.get('wait')).toBe(String(LONG_POLL_MAX_SECONDS));
    expect(page.events[0].type).toBe('code_channel.stopped');
    expect(page.cursor).toBe('EVT#2');
  });
});

describe('errors', () => {
  it('a coded failure becomes a SessionChannelServiceError with the code and status', async () => {
    const c = client([{ status: 409, body: { error: 'session_stopped', message: 'The user stopped this session.' } }]);
    const err = await c.client.setStatus('C1', 'active').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionChannelServiceError);
    expect((err as SessionChannelServiceError).code).toBe('session_stopped');
    expect((err as SessionChannelServiceError).status).toBe(409);
    expect((err as SessionChannelServiceError).message).toBe('The user stopped this session.');
    expect(isSessionStopped(err)).toBe(true);
    expect(isUnavailable(err)).toBe(false);
    expect(isChannelGone(err)).toBe(false);
  });

  it('409 code_channels_unavailable and 404 code_channels_disabled are "unavailable" — degrade, never retry', async () => {
    for (const [status, code] of [
      [409, 'code_channels_unavailable'],
      [404, 'code_channels_disabled'],
      [409, 'manager_missing_scope'],
      [409, 'app_not_installed'],
    ] as const) {
      const c = client([{ status, body: { error: code, message: 'no' } }]);
      const err = await c.client.create({ appId: 'A1', sessionId: 'ag-1', title: 'box' }).catch((e: unknown) => e);
      expect(isUnavailable(err)).toBe(true);
    }
  });

  it('404 not_found and 409 already_archived mean the channel is gone', async () => {
    const gone = client([{ status: 404, body: { error: 'not_found', message: 'No such channel for this account.' } }]);
    expect(isChannelGone(await gone.client.get('C9').catch((e: unknown) => e))).toBe(true);
    const archived = client([{ status: 409, body: { error: 'already_archived', message: 'archived' } }]);
    expect(isChannelGone(await archived.client.setStatus('C1', 'active').catch((e: unknown) => e))).toBe(true);
  });

  it('a body without a code still yields a coded error; an unreachable service is "unreachable"', async () => {
    const c = client([{ status: 502, body: undefined }]);
    const err = (await c.client.get('C1').catch((e: unknown) => e)) as SessionChannelServiceError;
    expect(err.code).toBe('http_502');
    const down = new SessionChannelClient({
      serviceBase: BASE,
      token: 't',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const offline = (await down.get('C1').catch((e: unknown) => e)) as SessionChannelServiceError;
    expect(offline.code).toBe('unreachable');
    expect(offline.status).toBe(0);
  });

  it('a 2xx without JSON is refused rather than returned as garbage', async () => {
    const c = client([{ status: 200, body: undefined }]);
    const err = (await c.client.get('C1').catch((e: unknown) => e)) as SessionChannelServiceError;
    expect(err.code).toBe('bad_response');
  });
});
