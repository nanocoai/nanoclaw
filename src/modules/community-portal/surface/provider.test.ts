/**
 * The provider against a fake service: what each contract method sends,
 * how the service's answers become the contract's failure kinds, the
 * archived-surface rebind, the events mapping, and a host with no install
 * or a service that says "unavailable" answering null at open.
 */
import { describe, expect, it } from 'vitest';

import { SurfaceError, surfaceErrorKind } from '../../../code-mode/surface/types.js';
import { SurfaceServiceClient } from './client.js';
import type { ManagedInstallCredentials } from './install.js';
import type { SurfacePlatform } from './platforms.js';
import { createServiceSurfaceProvider, mapEvent } from './provider.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Reply = { status: number; body: unknown };

const BASE = 'https://chat-service.example.test';
const CREDENTIALS: ManagedInstallCredentials = {
  platform: 'chat',
  serviceBase: BASE,
  appId: 'A1',
  token: 'tok-1',
};
const SANDBOX = { id: 'ag-1', name: 'box', folder: 'box' };
const HANDLE = { surfaceId: 'C1', sessionId: 'ag-1' };

function service(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      path: String(input).slice(BASE.length),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected call ${calls.at(-1)?.method} ${calls.at(-1)?.path}`);
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function provider(
  replies: Reply[],
  over: {
    credentials?: ManagedInstallCredentials | null;
    platform?: Partial<SurfacePlatform>;
    address?: { sandboxName: string; terminalAddress: string };
  } = {},
) {
  const fake = service(replies);
  const platform: SurfacePlatform = {
    spell: (id) => ({ platformId: `chat:${id}`, instance: 'chat' }),
    ...over.platform,
  };
  const p = createServiceSurfaceProvider({
    kind: 'chat',
    platform,
    credentials: async () => (over.credentials === undefined ? CREDENTIALS : over.credentials),
    clientFor: (c) => new SurfaceServiceClient({ serviceBase: c.serviceBase, token: c.token, fetch: fake.fetchFn }),
    terminalAddress: async () => over.address,
  });
  return { provider: p, calls: fake.calls };
}

const channel = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { channelId: 'C1', sessionId: 'ag-1', status: 'active', ...extra },
});

describe('open', () => {
  it('creates the surface for the sandbox with the bot identity and the terminal address, and spells it for the adapter', async () => {
    const { provider: p, calls } = provider([channel({ created: true })], {
      platform: { botIdentity: async () => ({ botUserId: 'U0BOT', teamId: 'T1' }) },
      address: { sandboxName: 'box', terminalAddress: 'box.alice.example.test' },
    });
    expect(await p.open(SANDBOX, { title: 'box' })).toEqual({ surfaceId: 'C1', sessionId: 'ag-1' });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/code-channels',
      body: {
        appId: 'A1',
        title: 'box',
        botUserId: 'U0BOT',
        teamId: 'T1',
        sandboxName: 'box',
        terminalAddress: 'box.alice.example.test',
        sessionId: 'ag-1',
      },
    });
    expect(await p.spell('C1')).toEqual({ platformId: 'chat:C1', instance: 'chat' });
  });

  it('answers null without an install, and when the service says unavailable or has no channel to give', async () => {
    const none = provider([], { credentials: null });
    expect(await none.provider.open(SANDBOX, {})).toBeNull();
    expect(none.calls).toHaveLength(0);
    const off = provider([{ status: 409, body: { error: 'code_channels_unavailable', message: 'no' } }]);
    expect(await off.provider.open(SANDBOX, {})).toBeNull();
    const missing = provider([{ status: 404, body: { error: 'not_found', message: 'no route' } }]);
    expect(await missing.provider.open(SANDBOX, {})).toBeNull();
    // Anything else is the caller's to log; it is thrown.
    const down = provider([{ status: 502, body: undefined }]);
    await expect(down.provider.open(SANDBOX, {})).rejects.toThrow(/HTTP 502/);
  });

  it('binds an archived surface again under a suffixed session id', async () => {
    const archivedAt = '2026-09-11T10:00:00.000Z';
    const { provider: p, calls } = provider([
      channel({ status: 'closed', archivedAt }),
      {
        status: 201,
        body: { channelId: 'C2', sessionId: `ag-1.${Date.parse(archivedAt).toString(36)}`, status: 'active' },
      },
    ]);
    expect(await p.open(SANDBOX, {})).toEqual({
      surfaceId: 'C2',
      sessionId: `ag-1.${Date.parse(archivedAt).toString(36)}`,
    });
    expect(calls.map((c) => (c.body as { sessionId: string }).sessionId)).toEqual([
      'ag-1',
      `ag-1.${Date.parse(archivedAt).toString(36)}`,
    ]);
  });

  it('uses the address core hands it when the host cannot compose one', async () => {
    const { provider: p, calls } = provider([channel()]);
    await p.open({ ...SANDBOX, folder: 'Box' }, { terminalAddress: 'box.alice.example.test' });
    expect(calls[0].body).toMatchObject({ sandboxName: 'box', terminalAddress: 'box.alice.example.test' });
  });
});

describe('status, views, bar, commands, members', () => {
  it('sends each to its route in the service’s vocabulary', async () => {
    const { provider: p, calls } = provider([
      channel({ status: 'processing', resumed: true }),
      { status: 200, body: { channelId: 'C1', viewKey: 'diff', type: 'diff', views: 1 } },
      { status: 200, body: { channelId: 'C1', viewKey: 'plan', type: 'block_kit', views: 2 } },
      { status: 200, body: { channelId: 'C1', contextBarItems: [] } },
      { status: 200, body: { channelId: 'C1', commands: 1 } },
      channel({
        members: [
          { botUserId: 'U0A', role: 'owner', sandboxName: 'box' },
          { botUserId: 'U0B', role: 'member' },
        ],
      }),
      { status: 200, body: { channelId: 'C1', member: { botUserId: 'U0C', role: 'member' } } },
      { status: 200, body: { channelId: 'C1', removed: true } },
    ]);
    await p.status(HANDLE, 'processing', { resume: true });
    await p.view(HANDLE, { key: 'diff', type: 'diff', name: 'Changes', content: '--- a\n+++ b\n', headBranch: 'main' });
    await p.view(HANDLE, { key: 'plan', type: 'blocks', content: '[]' });
    await p.bar!(HANDLE, [{ key: 'terminal', label: 'ssh box.alice.example.test' }]);
    await p.commands!(HANDLE, [{ name: 'terminal', description: 'the address' }]);
    expect(await p.members!(HANDLE)).toEqual([
      { id: 'U0A', name: 'box', role: 'owner' },
      { id: 'U0B', role: 'member' },
    ]);
    await p.join!(HANDLE, { id: 'U0C', name: 'web' });
    await p.leave!(HANDLE, { id: 'U0C' });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/v1/code-channels/C1/status', { status: 'processing', resume: true }],
      [
        'PUT',
        '/v1/code-channels/C1/views/diff',
        { type: 'diff', name: 'Changes', content: '--- a\n+++ b\n', headBranch: 'main' },
      ],
      ['PUT', '/v1/code-channels/C1/views/plan', { type: 'block_kit', content: '[]' }],
      [
        'PUT',
        '/v1/code-channels/C1/properties',
        { contextBarItems: [{ key: 'terminal', label: 'ssh box.alice.example.test' }] },
      ],
      ['PUT', '/v1/code-channels/C1/commands', { commands: [{ name: 'terminal', description: 'the address' }] }],
      ['GET', '/v1/code-channels/C1', undefined],
      ['POST', '/v1/code-channels/C1/members', { botUserId: 'U0C', sandboxName: 'web' }],
      ['DELETE', '/v1/code-channels/C1/members/U0C', undefined],
    ]);
  });

  it('maps the service’s refusals onto the contract: stopped, gone, unavailable; the rest stays transient', async () => {
    const kinds: Array<[number, string, string | undefined]> = [
      [409, 'session_stopped', 'stopped'],
      [404, 'not_found', 'gone'],
      [409, 'already_archived', 'gone'],
      [409, 'code_channels_disabled', 'unavailable'],
      [503, 'busy', undefined],
    ];
    for (const [status, code, kind] of kinds) {
      const { provider: p } = provider([{ status, body: { error: code, message: code } }]);
      const err = await p.status(HANDLE, 'active').catch((e: unknown) => e);
      expect(surfaceErrorKind(err)).toBe(kind);
      if (kind) expect(err).toBeInstanceOf(SurfaceError);
    }
    // No install any more: every send is "unavailable" and core drops the binding from this process.
    const none = provider([], { credentials: null });
    expect(
      surfaceErrorKind(
        await none.provider.view(HANDLE, { key: 'diff', type: 'diff', content: 'x' }).catch((e: unknown) => e),
      ),
    ).toBe('unavailable');
  });
});

describe('events and close', () => {
  it('long-polls with the cursor and wait, and maps stop, command and member events', async () => {
    const { provider: p, calls } = provider([
      {
        status: 200,
        body: {
          channelId: 'C1',
          sessionId: 'ag-1',
          status: 'stopped',
          events: [
            { cursor: 'E1', type: 'code_channel.stopped', channelId: 'C1', sessionId: 'ag-1', ts: 't1', user: 'U1' },
            {
              cursor: 'E2',
              type: 'code_channel.stopped',
              channelId: 'C1',
              sessionId: 'ag-1',
              ts: 't2',
              threadTs: 'th',
            },
            {
              cursor: 'E3',
              type: 'code_channel.command',
              channelId: 'C1',
              sessionId: 'ag-1',
              ts: 't3',
              command: '/terminal',
              text: '',
              user: 'U1',
            },
            {
              cursor: 'E4',
              type: 'code_channel.member_joined',
              channelId: 'C1',
              sessionId: 'ag-1',
              ts: 't4',
              user: 'U0B',
            },
            { cursor: 'E5', type: 'code_channel.something_new', channelId: 'C1', sessionId: 'ag-1', ts: 't5' },
          ],
          cursor: 'E5',
        },
      },
    ]);
    const page = await p.events(HANDLE, 'E0', 10);
    expect(calls[0].path).toBe('/v1/code-channels/C1/events?wait=10&since=E0');
    expect(page).toEqual({
      events: [
        { type: 'stop', ts: 't1', user: 'U1' },
        { type: 'stop', ts: 't2', threadId: 'th' },
        { type: 'command', command: '/terminal', text: '', user: 'U1', ts: 't3' },
        { type: 'member_joined', member: { id: 'U0B' } },
      ],
      cursor: 'E5',
    });
    expect(mapEvent({ cursor: 'x', type: 'unknown', channelId: 'C1', sessionId: 'ag-1', ts: 't' })).toBeUndefined();
  });

  it('archives with the summary, and treats an already archived or unknown surface as closed', async () => {
    const { provider: p, calls } = provider([
      { status: 200, body: { channelId: 'C1', sessionId: 'ag-1', status: 'closed', archived: true, archivedAt: 't' } },
      { status: 409, body: { error: 'already_archived', message: 'archived' } },
      { status: 409, body: { error: 'session_stopped', message: 'stopped' } },
    ]);
    await p.close(HANDLE, { summary: 'done' });
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/code-channels/C1/archive', body: { summary: 'done' } });
    await expect(p.close(HANDLE)).resolves.toBeUndefined();
    expect(surfaceErrorKind(await p.close(HANDLE).catch((e: unknown) => e))).toBe('stopped');
  });
});
