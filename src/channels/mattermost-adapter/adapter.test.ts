import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Actions, Button, Card, Select } from 'chat';
import type { ChatInstance } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MattermostAdapter } from './adapter.js';
import type { MattermostAdapterOptions } from './adapter.js';
import { CALLBACK_SECRET_KEY, cardToAttachment } from './format.js';
import { createMattermostAdapter } from './index.js';

const BOT_ID = '7g4f95dymtrjmqnoozdyi57xbw';
const USER_ID = '7mx5jdcrnby18yrpnzont8ggwo';
const CHANNEL_ID = 'tyzg1xpaeinqzypmh6h9j9ysyy';
const POST_ID = 'mjhbignk4inf7kh9w5wi8snchw';
const ROOT_ID = 'or6atyakftywuq6jjo44oytu7h';

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function callbackRequest(): Request {
  return new Request('https://nanoclaw.example.com/webhook/mattermost', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel_id: CHANNEL_ID,
      context: { action_id: 'ncq:q1:0', callback_token: 'callback-secret', value: '0' },
      post_id: POST_ID,
      user_id: USER_ID,
      user_name: 'operator',
    }),
  });
}

describe('Mattermost action callbacks', () => {
  it('recovers a card thread and props after a process restart', async () => {
    const requests: { method: string; url: string }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url });
      if (url.endsWith('/users/me')) {
        return response({ id: BOT_ID, is_bot: true, username: 'nanoclaw-bot' });
      }
      if (url.endsWith(`/posts/${POST_ID}`) && method === 'GET') {
        return response({
          channel_id: CHANNEL_ID,
          create_at: 1,
          id: POST_ID,
          message: '',
          props: {
            attachments: [{ actions: [{ id: 'ncq:q1:0' }] }],
            from_bot: 'true',
            plugin_data: { preserved: true },
          },
          root_id: ROOT_ID,
          user_id: BOT_ID,
        });
      }
      if (url.endsWith(`/posts/${POST_ID}/patch`) && method === 'PUT') {
        return response({ channel_id: CHANNEL_ID, id: POST_ID });
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const processAction = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const adapter = new MattermostAdapter({
      callbackSecret: 'callback-secret',
      callbackUrl: 'https://nanoclaw.example.com',
      fetchImpl,
      skipSocket: true,
      token: 'bot-token',
      url: 'https://mattermost.example.com',
    });
    await adapter.initialize({ getLogger: () => logger, processAction } as unknown as ChatInstance);

    expect((await adapter.handleWebhook(callbackRequest())).status).toBe(200);
    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: POST_ID,
        threadId: `mattermost:${CHANNEL_ID}:${ROOT_ID}`,
      }),
      undefined,
    );

    await adapter.editMessage(`mattermost:${CHANNEL_ID}:${ROOT_ID}`, POST_ID, { markdown: 'Resolved' });
    expect(
      requests.filter((request) => request.method === 'GET' && request.url.endsWith(`/posts/${POST_ID}`)),
    ).toHaveLength(1);
    const patchCall = vi
      .mocked(fetchImpl)
      .mock.calls.find(([input, init]) => String(input).endsWith(`/posts/${POST_ID}/patch`) && init?.method === 'PUT');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      message: 'Resolved',
      props: { attachments: [], from_bot: 'true', plugin_data: { preserved: true } },
    });
  });

  it('falls back to the callback channel when the post cannot be read', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/users/me')
        ? response({ id: BOT_ID, is_bot: true, username: 'nanoclaw-bot' })
        : response({ message: 'not found' }, 404),
    ) as unknown as typeof fetch;
    const processAction = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const adapter = new MattermostAdapter({
      callbackSecret: 'callback-secret',
      callbackUrl: 'https://nanoclaw.example.com',
      fetchImpl,
      skipSocket: true,
      token: 'bot-token',
      url: 'https://mattermost.example.com',
    });
    await adapter.initialize({ getLogger: () => logger, processAction } as unknown as ChatInstance);

    expect((await adapter.handleWebhook(callbackRequest())).status).toBe(200);
    expect(processAction).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: `mattermost:${CHANNEL_ID}` }),
      undefined,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Mattermost action callback: could not recover posting thread',
      expect.objectContaining({ postId: POST_ID }),
    );
  });
});

describe('Mattermost runtime verification contract', () => {
  it('proves live credentials and settings only after socket authentication, and clears readiness on disconnect', async () => {
    const token = 'test-bot-token';
    const secret = 'test-callback-secret';
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: BOT_ID, username: 'test-bot', is_bot: true }));
    });
    const sockets = new WebSocketServer({ server });
    let authenticate: (() => void) | undefined;
    sockets.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        expect(message.data.token).toBe(token);
        authenticate = () => socket.send(JSON.stringify({ status: 'OK', seq_reply: message.seq }));
      }),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    const adapter = new MattermostAdapter({
      url: base,
      token,
      callbackSecret: secret,
      callbackUrl: 'https://callback.test',
    });
    const processAction = vi.fn();
    const logger = { debug() {}, error() {}, info() {}, warn() {} };
    try {
      expect(adapter.isConnected()).toBe(false);
      const init = adapter.initialize({ getLogger: () => logger, processAction } as unknown as ChatInstance);
      await vi.waitFor(() => expect(authenticate).toBeDefined());
      expect(adapter.isConnected()).toBe(false);
      authenticate!();
      await init;
      expect(adapter.isConnected()).toBe(true);
      const challenge = '12345678-1234-1234-1234-123456789abc';
      const probe = (credential?: string) =>
        new Request('http://localhost/webhook/mattermost', {
          method: 'POST',
          body: JSON.stringify({ context: { nanoclaw_setup_probe: challenge, callback_token: credential } }),
        });
      expect((await adapter.handleWebhook(probe())).status).toBe(401);
      expect((await adapter.handleWebhook(probe('wrong'))).status).toBe(401);
      const runtime = {
        challenge,
        bot_id: BOT_ID,
        base_url: base,
        callback_url: 'https://callback.test/webhook/mattermost',
        connected: true,
        callback_received: false,
      };
      const response = await adapter.handleWebhook(probe(secret));
      expect(await response.json()).toEqual({
        ...runtime,
        proof: createHmac('sha256', token).update(JSON.stringify(runtime)).digest('hex'),
      });
      const action = (proof: string) =>
        new Request('http://localhost/webhook/mattermost', {
          method: 'POST',
          body: JSON.stringify({ context: { nanoclaw_setup_action: challenge, nanoclaw_setup_proof: proof } }),
        });
      expect((await adapter.handleWebhook(action('x'.repeat(64)))).status).toBe(401);
      expect(
        (
          await adapter.handleWebhook(
            action(createHmac('sha256', token).update(`nanoclaw-setup:${challenge}`).digest('hex')),
          )
        ).status,
      ).toBe(200);
      expect(await (await adapter.handleWebhook(probe(secret))).json()).toMatchObject({ callback_received: true });
      expect(processAction).not.toHaveBeenCalled();
      for (const socket of sockets.clients) socket.terminate();
      await vi.waitFor(() => expect(adapter.isConnected()).toBe(false));
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    } finally {
      await adapter.disconnect();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((done) => sockets.close(() => done()));
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

const CALLBACK_URL = 'https://callback.example/webhook/mattermost';
const SECRET = 'test-callback-secret';
const TOKEN = 'test-bot-token';
const BASE_OPTIONS = { token: TOKEN, url: 'https://mattermost.example' };

function request(context: Record<string, unknown>): Request {
  return new Request(CALLBACK_URL, {
    method: 'POST',
    body: JSON.stringify({
      channel_id: CHANNEL_ID,
      post_id: POST_ID,
      user_id: USER_ID,
      user_name: 'operator',
      context,
    }),
  });
}

async function fixture(options: Partial<MattermostAdapterOptions> = {}) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/users/me')) {
      return Response.json({ id: 'bot-id', username: 'nanoclaw', is_bot: true });
    }
    return Response.json({ id: POST_ID, channel_id: CHANNEL_ID, props: {} });
  });
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const processAction = vi.fn();
  const adapter = new MattermostAdapter({
    ...BASE_OPTIONS,
    callbackUrl: CALLBACK_URL,
    callbackSecret: SECRET,
    fetchImpl,
    skipSocket: true,
    ...options,
  });
  await adapter.initialize({ getLogger: () => logger, processAction } as unknown as ChatInstance);
  fetchImpl.mockClear();
  return { adapter, fetchImpl, logger, processAction };
}

afterEach(() => vi.unstubAllEnvs());

describe('Mattermost callback authentication', () => {
  it.each([undefined, '', '   ', '\t\n'])(
    'rejects a callback URL with an absent or blank secret (%j)',
    (callbackSecret) => {
      expect(() => new MattermostAdapter({ ...BASE_OPTIONS, callbackUrl: CALLBACK_URL, callbackSecret })).toThrow(
        /callbackSecret is missing or blank/,
      );
    },
  );

  it.each([undefined, '', '   '])('refuses actions when callbacks are unconfigured (%j)', async (callbackSecret) => {
    const { adapter, fetchImpl, processAction } = await fixture({ callbackUrl: undefined, callbackSecret });
    expect(
      (await adapter.handleWebhook(request({ action_id: 'approve', callback_token: callbackSecret }))).status,
    ).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(processAction).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'wrong', 'x'.repeat(SECRET.length), 42, {}, [], true])(
    'rejects forged credentials before fetching or dispatching (%j)',
    async (presented) => {
      const { adapter, fetchImpl, processAction } = await fixture();
      expect((await adapter.handleWebhook(request({ action_id: 'approve', callback_token: presented }))).status).toBe(
        401,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(processAction).not.toHaveBeenCalled();
    },
  );

  it('preserves a nonblank Unicode secret exactly and dispatches an authenticated select', async () => {
    const secret = '  sécret-🔒  ';
    const { adapter, processAction } = await fixture({ callbackSecret: secret });
    expect((await adapter.handleWebhook(request({ action_id: 'pick', callback_token: secret.trim() }))).status).toBe(
      401,
    );
    expect(
      (await adapter.handleWebhook(request({ action_id: 'pick', selected_option: 'blue', callback_token: secret })))
        .status,
    ).toBe(200);
    expect(processAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ actionId: 'pick', value: 'blue', user: expect.objectContaining({ userId: USER_ID }) }),
      undefined,
    );
  });

  it.each(['null', 'false', '42', '"text"', '{'])(
    'rejects malformed JSON payload %s without a server error',
    async (body) => {
      const { adapter, fetchImpl, processAction } = await fixture();
      expect((await adapter.handleWebhook(new Request(CALLBACK_URL, { method: 'POST', body }))).status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(processAction).not.toHaveBeenCalled();
    },
  );

  it('requires an explicit opt-out and warns when accepting local unauthenticated callbacks', async () => {
    const { adapter, logger, processAction } = await fixture({
      callbackSecret: '  ',
      allowUnauthenticatedCallbacks: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('callbacks are unauthenticated'));
    expect((await adapter.handleWebhook(request({ action_id: 'local-test' }))).status).toBe(200);
    expect(processAction).toHaveBeenCalledTimes(1);
  });

  it('still checks a configured secret when the opt-out is enabled', async () => {
    const { adapter, logger, processAction } = await fixture({ allowUnauthenticatedCallbacks: true });
    expect(logger.warn).not.toHaveBeenCalled();
    expect((await adapter.handleWebhook(request({ action_id: 'approve' }))).status).toBe(401);
    expect(processAction).not.toHaveBeenCalled();
  });

  it('keeps setup proofs separate from user actions and runtime disclosure', async () => {
    const { adapter, fetchImpl, processAction } = await fixture({ callbackUrl: undefined, callbackSecret: undefined });
    const nonce = '12345678-1234-1234-1234-123456789abc';
    const context = {
      nanoclaw_setup_action: nonce,
      nanoclaw_setup_proof: createHmac('sha256', TOKEN).update(`nanoclaw-setup:${nonce}`).digest('hex'),
      action_id: 'approve',
    };
    expect((await adapter.handleWebhook(request({ ...context, nanoclaw_setup_proof: 'a'.repeat(64) }))).status).toBe(
      401,
    );
    expect(await (await adapter.handleWebhook(request(context))).json()).toEqual({});
    expect((await adapter.handleWebhook(request({ nanoclaw_setup_probe: nonce }))).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(processAction).not.toHaveBeenCalled();
  });
});

describe('Mattermost callback configuration', () => {
  function environment() {
    vi.stubEnv('MATTERMOST_URL', BASE_OPTIONS.url);
    vi.stubEnv('MATTERMOST_BOT_TOKEN', TOKEN);
    vi.stubEnv('MATTERMOST_CALLBACK_URL', CALLBACK_URL);
    vi.stubEnv('MATTERMOST_CALLBACK_SECRET', '');
    vi.stubEnv('MATTERMOST_ALLOW_UNAUTHENTICATED_CALLBACKS', '');
  }

  it('keeps an unconfigured channel inert', () => {
    environment();
    vi.stubEnv('MATTERMOST_URL', '');
    expect(createMattermostAdapter()).toBeNull();
  });

  it('falls back to the environment when the explicit secret is whitespace', () => {
    environment();
    expect(() => createMattermostAdapter({ callbackSecret: '  ' })).toThrow(/MATTERMOST_CALLBACK_SECRET/);
    vi.stubEnv('MATTERMOST_CALLBACK_SECRET', SECRET);
    expect(createMattermostAdapter({ callbackSecret: '  ' })).toBeInstanceOf(MattermostAdapter);
  });

  it('honors explicit false over the environment opt-out', () => {
    environment();
    vi.stubEnv('MATTERMOST_ALLOW_UNAUTHENTICATED_CALLBACKS', 'true');
    expect(createMattermostAdapter()).toBeInstanceOf(MattermostAdapter);
    expect(() => createMattermostAdapter({ allowUnauthenticatedCallbacks: false })).toThrow(
      /callbackSecret is missing or blank/,
    );
  });

  it.each(['false', 'true', 1, [], {}])('rejects a non-boolean config opt-out (%j)', (value) => {
    environment();
    for (const envValue of ['', 'true']) {
      vi.stubEnv('MATTERMOST_ALLOW_UNAUTHENTICATED_CALLBACKS', envValue);
      expect(() => createMattermostAdapter({ allowUnauthenticatedCallbacks: value as unknown as boolean })).toThrow(
        /callbackSecret is missing or blank/,
      );
    }
  });

  it.each(['TRUE', '1', 'false'])('does not interpret %s as permission to skip authentication', (value) => {
    environment();
    vi.stubEnv('MATTERMOST_ALLOW_UNAUTHENTICATED_CALLBACKS', value);
    expect(() => createMattermostAdapter()).toThrow(/callbackSecret is missing or blank/);
    expect(createMattermostAdapter({ allowUnauthenticatedCallbacks: true })).toBeInstanceOf(MattermostAdapter);
  });
});

describe('Mattermost callback secret destinations', () => {
  it.each([
    'https://external.example/hook',
    'https://callback.example/other',
    `${CALLBACK_URL}.evil`,
    `${CALLBACK_URL}/actions/extra`,
    `${CALLBACK_URL}?forward=external`,
    'https://callback.example@external.example/webhook/mattermost',
    'http://callback.example/webhook/mattermost',
    'https://callback.example:8443/webhook/mattermost',
  ])('keeps the adapter secret off %s and rejects a forged replay', async (callbackUrl) => {
    const card = Card({
      children: [Actions([Button({ id: 'approve', label: 'Approve', value: 'yes', callbackUrl })])],
    });
    const action = cardToAttachment(card, CALLBACK_URL, SECRET)!.actions![0];
    expect(action.integration).toEqual({ url: callbackUrl, context: { action_id: 'approve', value: 'yes' } });
    const { adapter, fetchImpl, processAction } = await fixture();
    expect((await adapter.handleWebhook(request(action.integration.context!))).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(processAction).not.toHaveBeenCalled();
  });

  it.each([undefined, CALLBACK_URL, `${CALLBACK_URL}/`, `${CALLBACK_URL}/actions`, `${CALLBACK_URL}/actions/`])(
    'authenticates buttons using the adapter route (%s)',
    (callbackUrl) => {
      const card = Card({ children: [Actions([Button({ id: 'approve', label: 'Approve', callbackUrl })])] });
      expect(cardToAttachment(card, CALLBACK_URL, SECRET)!.actions![0].integration.context).toEqual({
        action_id: 'approve',
        [CALLBACK_SECRET_KEY]: SECRET,
      });
    },
  );

  it('authenticates selects using the adapter route', () => {
    const card = Card({
      children: [Actions([Select({ id: 'pick', label: 'Pick', options: [{ label: 'Blue', value: 'blue' }] })])],
    });
    expect(cardToAttachment(card, CALLBACK_URL, SECRET)!.actions![0].integration).toEqual({
      url: CALLBACK_URL,
      context: { action_id: 'pick', [CALLBACK_SECRET_KEY]: SECRET },
    });
  });

  it('uses the same destination protection when posting and editing cards', async () => {
    const { adapter, fetchImpl } = await fixture({ callbackUrl: 'https://callback.example/' });
    const card = Card({
      children: [
        Actions([
          Button({ id: 'ours', label: 'Ours', callbackUrl: CALLBACK_URL }),
          Button({ id: 'external', label: 'External', callbackUrl: 'https://external.example/hook' }),
        ]),
      ],
    });
    await adapter.postMessage(`mattermost:${CHANNEL_ID}`, { card });
    await adapter.editMessage(`mattermost:${CHANNEL_ID}`, POST_ID, { card });
    const bodies = vi
      .mocked(fetchImpl)
      .mock.calls.map((call) => {
        const init = (call as unknown as [unknown, RequestInit])[1];
        return init?.body ? JSON.parse(String(init.body)) : undefined;
      })
      .filter((body) => body?.props?.attachments);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.props.attachments[0].actions.map((action: { integration: unknown }) => action.integration)).toEqual([
        { url: CALLBACK_URL, context: { action_id: 'ours', callback_token: SECRET } },
        { url: 'https://external.example/hook', context: { action_id: 'external' } },
      ]);
    }
  });
});
