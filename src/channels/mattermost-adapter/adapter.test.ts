import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Actions, Button, Card } from 'chat';
import type { ChatInstance } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MattermostAdapter } from './adapter.js';
import type { MattermostAdapterOptions } from './adapter.js';
import { CALLBACK_SECRET_KEY } from './format.js';
import { createMattermostAdapter } from './index.js';
import { MattermostApiError, MattermostNetworkError } from './rest.js';
import type { MattermostPost, MattermostWebSocketEvent } from './types.js';
import { buildMattermostAdapter } from '../mattermost.js';

const BOT_ID = '7g4f95dymtrjmqnoozdyi57xbw';
const USER_ID = '7mx5jdcrnby18yrpnzont8ggwo';
const CHANNEL_ID = 'tyzg1xpaeinqzypmh6h9j9ysyy';
const POST_ID = 'mjhbignk4inf7kh9w5wi8snchw';
const ROOT_ID = 'or6atyakftywuq6jjo44oytu7h';
const OTHER_BOT_ID = '1g3di8tu4jnxu8zjypnouyo4qo';
const UNKNOWN_USER_ID = 'kq9wq3s8ojbzmc6hzg5wxkd1ra';

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

function postedEvent(options: {
  channelType?: 'D' | 'O';
  id?: string;
  mentions?: string[];
  message?: string;
  props?: Record<string, string>;
  rootId?: string;
  userId?: string;
}): MattermostWebSocketEvent {
  const post: MattermostPost = {
    channel_id: CHANNEL_ID,
    create_at: 1,
    id: options.id ?? POST_ID,
    message: options.message ?? (options.mentions?.includes(BOT_ID) ? '@nanoclaw-bot hello' : 'hello'),
    ...(options.props ? { props: options.props } : {}),
    ...(options.rootId ? { root_id: options.rootId } : {}),
    user_id: options.userId ?? USER_ID,
  };
  return {
    broadcast: { channel_id: CHANNEL_ID },
    data: {
      channel_type: options.channelType ?? 'O',
      mentions: JSON.stringify(options.mentions ?? []),
      post: JSON.stringify(post),
      sender_name: '@operator',
    },
    event: 'posted',
  };
}

async function initializePostedHarness(): Promise<{
  adapter: MattermostAdapter;
  processMessage: ReturnType<typeof vi.fn>;
  processReaction: ReturnType<typeof vi.fn>;
}> {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/users/me')) {
      return response({ id: BOT_ID, is_bot: true, username: 'nanoclaw-bot' });
    }
    if (url.endsWith(`/users/${USER_ID}`)) {
      return response({ id: USER_ID, is_bot: false, username: 'operator' });
    }
    if (url.endsWith(`/users/${OTHER_BOT_ID}`)) {
      return response({ id: OTHER_BOT_ID, is_bot: true, username: 'other-bot' });
    }
    if (url.endsWith(`/posts/${POST_ID}`)) {
      return response({ channel_id: CHANNEL_ID, create_at: 1, id: POST_ID, message: 'hello', user_id: USER_ID });
    }
    return response({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
  const processMessage = vi.fn();
  const processReaction = vi.fn();
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const adapter = new MattermostAdapter({
    fetchImpl,
    skipSocket: true,
    token: 'bot-token',
    url: 'https://mattermost.example.com',
  });
  await adapter.initialize({ getLogger: () => logger, processMessage, processReaction } as unknown as ChatInstance);
  return { adapter, processMessage, processReaction };
}

describe('Mattermost posted-message threads', () => {
  it('reports no live transport when initialized without a socket', async () => {
    const { adapter } = await initializePostedHarness();
    expect(adapter.isConnected()).toBe(false);
  });

  it('keeps fetched-message thread identity stable as DM state warms', async () => {
    const { adapter, processMessage } = await initializePostedHarness();
    const event = postedEvent({ mentions: [BOT_ID] });
    const post = JSON.parse(String(event.data?.post ?? '{}')) as MattermostPost;

    const cold = adapter.parseMessage(post);
    expect(cold.threadId).toBe(`mattermost:${CHANNEL_ID}`);
    expect(cold.isMention).toBe(true);

    adapter.handleSocketEvent(postedEvent({ channelType: 'D' }));
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());

    const warm = adapter.parseMessage(post);
    expect(warm.threadId).toBe(`mattermost:${CHANNEL_ID}`);
    expect(warm.isMention).toBe(false);
  });

  it('roots a reaction in the same thread as the reacted-to post', async () => {
    const { adapter, processReaction } = await initializePostedHarness();
    const reaction = (): MattermostWebSocketEvent => ({
      broadcast: { channel_id: CHANNEL_ID },
      data: { reaction: JSON.stringify({ emoji_name: '+1', post_id: POST_ID, user_id: USER_ID }) },
      event: 'reaction_added',
    });

    adapter.handleSocketEvent(reaction());
    await vi.waitFor(() => expect(processReaction).toHaveBeenCalledTimes(1));
    expect(processReaction.mock.calls[0][0].threadId).toBe(`mattermost:${CHANNEL_ID}:${POST_ID}`);

    // In a DM a top-level post stays channel-level, and so does its reaction.
    adapter.handleSocketEvent(postedEvent({ channelType: 'D' }));
    adapter.handleSocketEvent(reaction());
    await vi.waitFor(() => expect(processReaction).toHaveBeenCalledTimes(2));
    expect(processReaction.mock.calls[1][0].threadId).toBe(`mattermost:${CHANNEL_ID}`);
  });

  it('fetches a top-level group post into the rooted thread it was delivered in', async () => {
    const { adapter } = await initializePostedHarness();
    const rooted = `mattermost:${CHANNEL_ID}:${POST_ID}`;

    expect((await adapter.fetchMessage(rooted, POST_ID))?.threadId).toBe(rooted);
    expect((await adapter.fetchMessage(`mattermost:${CHANNEL_ID}`, POST_ID))?.threadId).toBe(
      `mattermost:${CHANNEL_ID}`,
    );
  });

  it('opens a thread rooted at a top-level post that mentions the bot', async () => {
    const { adapter, processMessage } = await initializePostedHarness();

    adapter.handleSocketEvent(postedEvent({ mentions: [BOT_ID] }));

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      `mattermost:${CHANNEL_ID}:${POST_ID}`,
      expect.objectContaining({
        id: POST_ID,
        isMention: true,
        threadId: `mattermost:${CHANNEL_ID}:${POST_ID}`,
      }),
    );
  });

  it('gives ordinary top-level group chatter its own inactive thread identity', async () => {
    const { adapter, processMessage } = await initializePostedHarness();

    adapter.handleSocketEvent(postedEvent({}));

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      `mattermost:${CHANNEL_ID}:${POST_ID}`,
      expect.objectContaining({
        id: POST_ID,
        isMention: false,
        threadId: `mattermost:${CHANNEL_ID}:${POST_ID}`,
      }),
    );
  });

  it('does not open a thread for the implicit mention on a DM post', async () => {
    const { adapter, processMessage } = await initializePostedHarness();

    adapter.handleSocketEvent(postedEvent({ channelType: 'D', mentions: [BOT_ID] }));

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      `mattermost:${CHANNEL_ID}`,
      expect.objectContaining({
        id: POST_ID,
        isMention: false,
        threadId: `mattermost:${CHANNEL_ID}`,
      }),
    );
  });

  it('does not count @channel, @all or @here as a mention of the bot', async () => {
    const { adapter, processMessage } = await initializePostedHarness();
    const texts = [
      '@channel standup',
      '@ALL standup',
      'standup @here.',
      '_@here_ standup',
      '@channel- standup',
      '@channel_ standup',
      '@here @nanoclaw-bot standup',
      '@channel ping @nanoclaw-bot.',
      '@here _@nanoclaw-bot_ standup',
    ];

    // The server lists the bot in `mentions` for each of these.
    texts.forEach((message, i) =>
      adapter.handleSocketEvent(postedEvent({ id: `${POST_ID.slice(0, 25)}${i}`, mentions: [BOT_ID], message })),
    );

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(texts.length));
    expect(processMessage.mock.calls.map((call) => call[2].isMention)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("drops other bots' posts so two agents can't wake each other", async () => {
    const { adapter, processMessage } = await initializePostedHarness();
    const id = (i: number) => `${POST_ID.slice(0, 25)}${i}`;

    // Flagged by the server (profile lookup fails); a bot account without the
    // flag; a person; a person's webhook.
    adapter.handleSocketEvent(
      postedEvent({ id: id(1), props: { from_bot: 'true' }, rootId: ROOT_ID, userId: UNKNOWN_USER_ID }),
    );
    adapter.handleSocketEvent(postedEvent({ id: id(2), rootId: ROOT_ID, userId: OTHER_BOT_ID }));
    adapter.handleSocketEvent(postedEvent({ id: id(3), rootId: ROOT_ID }));
    adapter.handleSocketEvent(postedEvent({ id: id(4), props: { from_webhook: 'true' }, rootId: ROOT_ID }));

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(2));
    expect(processMessage.mock.calls.map((call) => call[2].id)).toEqual([id(3), id(4)]);
  });

  it('preserves the existing root for a reply that also mentions the bot', async () => {
    const { adapter, processMessage } = await initializePostedHarness();

    adapter.handleSocketEvent(postedEvent({ id: 'c7ad5obm3fn7byqnhqskc3b8so', mentions: [BOT_ID], rootId: ROOT_ID }));

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      `mattermost:${CHANNEL_ID}:${ROOT_ID}`,
      expect.objectContaining({
        isMention: true,
        threadId: `mattermost:${CHANNEL_ID}:${ROOT_ID}`,
      }),
    );
  });
});

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
const DERIVED_LABEL = 'nanoclaw-mattermost-callback-secret:v1';
const DERIVED_SECRET = createHmac('sha256', TOKEN).update(DERIVED_LABEL).digest('hex');
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
    'starts without a secret (%j) and verifies clicks with the token-derived one',
    async (callbackSecret) => {
      const { adapter, processAction } = await fixture({ callbackSecret });
      expect((await adapter.handleWebhook(request({ action_id: 'approve' }))).status).toBe(401);
      expect((await adapter.handleWebhook(request({ action_id: 'approve', callback_token: SECRET }))).status).toBe(401);
      expect(
        (await adapter.handleWebhook(request({ action_id: 'approve', callback_token: DERIVED_SECRET }))).status,
      ).toBe(200);
      expect(processAction).toHaveBeenCalledTimes(1);
    },
  );

  it('writes the same derived secret into posted cards that it verifies', async () => {
    const { adapter, fetchImpl } = await fixture({ callbackSecret: undefined });
    const card = Card({ children: [Actions([Button({ id: 'approve', label: 'Approve' })])] });
    await adapter.postMessage(`mattermost:${CHANNEL_ID}`, { card });
    const body = vi
      .mocked(fetchImpl)
      .mock.calls.map((call) => (call as unknown as [unknown, RequestInit])[1]?.body)
      .filter(Boolean)
      .map((raw) => JSON.parse(String(raw)))
      .find((parsed) => parsed?.props?.attachments);
    const context = body.props.attachments[0].actions[0].integration.context;
    expect(context).toEqual({ action_id: 'approve', [CALLBACK_SECRET_KEY]: DERIVED_SECRET });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect((await adapter.handleWebhook(request(context))).status).toBe(200);
  });

  it('uses an explicit secret instead of the derived one', async () => {
    const { adapter, processAction } = await fixture();
    expect(
      (await adapter.handleWebhook(request({ action_id: 'approve', callback_token: DERIVED_SECRET }))).status,
    ).toBe(401);
    expect((await adapter.handleWebhook(request({ action_id: 'approve', callback_token: SECRET }))).status).toBe(200);
    expect(processAction).toHaveBeenCalledTimes(1);
  });

  it('refuses cards posted before a bot token rotation', async () => {
    const { adapter, processAction } = await fixture({ callbackSecret: undefined, token: 'rotated-bot-token' });
    expect(
      (await adapter.handleWebhook(request({ action_id: 'approve', callback_token: DERIVED_SECRET }))).status,
    ).toBe(401);
    expect(processAction).not.toHaveBeenCalled();
  });

  it('refuses every action when neither a secret nor a token is available', async () => {
    const { adapter, processAction } = await fixture({ callbackSecret: undefined, token: '' });
    const blankDerived = createHmac('sha256', '').update(DERIVED_LABEL).digest('hex');
    for (const callback_token of [undefined, '', blankDerived]) {
      expect((await adapter.handleWebhook(request({ action_id: 'approve', callback_token }))).status).toBe(401);
    }
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
  }

  it('keeps an unconfigured channel inert', () => {
    environment();
    vi.stubEnv('MATTERMOST_URL', '');
    expect(createMattermostAdapter()).toBeNull();
  });

  it('builds an adapter with a callback URL and no secret', () => {
    environment();
    expect(createMattermostAdapter()).toBeInstanceOf(MattermostAdapter);
    expect(
      buildMattermostAdapter({ baseUrl: BASE_OPTIONS.url, botToken: TOKEN, callbackUrl: CALLBACK_URL }),
    ).toBeInstanceOf(MattermostAdapter);
  });

  it('falls back to the environment secret when the explicit one is whitespace', async () => {
    environment();
    vi.stubEnv('MATTERMOST_CALLBACK_SECRET', SECRET);
    const { fetchImpl } = await fixture();
    const processAction = vi.fn();
    const adapter = createMattermostAdapter({ callbackSecret: '  ', fetchImpl, skipSocket: true })!;
    await adapter.initialize({ getLogger: () => console, processAction } as unknown as ChatInstance);
    expect(
      (await adapter.handleWebhook(request({ action_id: 'approve', callback_token: DERIVED_SECRET }))).status,
    ).toBe(401);
    expect((await adapter.handleWebhook(request({ action_id: 'approve', callback_token: SECRET }))).status).toBe(200);
    expect(processAction).toHaveBeenCalledTimes(1);
  });
});

// The host's setup retry (channel-registry) matches on `name === 'NetworkError'`.
describe('Mattermost setup failures', () => {
  function bootAdapter(fetchImpl: typeof fetch, options: Partial<MattermostAdapterOptions> = {}) {
    const adapter = new MattermostAdapter({ ...BASE_OPTIONS, fetchImpl, skipSocket: true, ...options });
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const chat = { getLogger: () => logger } as unknown as ChatInstance;
    return { adapter, initialize: () => adapter.initialize(chat) };
  }

  it.each([500, 502, 503, 504, 408, 429])('tags a %i at boot as a NetworkError', async (status) => {
    const { initialize } = bootAdapter(vi.fn(async () => new Response('<html>Bad Gateway</html>', { status })));
    const error = await initialize().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MattermostApiError);
    expect(error).toMatchObject({ name: 'NetworkError', status });
  });

  it('tags a fetch that got no reply as a NetworkError', async () => {
    const refused = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.5:443') });
    const { initialize } = bootAdapter(
      vi.fn(async () => {
        throw refused;
      }),
    );
    const error = await initialize().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MattermostNetworkError);
    expect(error).toMatchObject({ name: 'NetworkError', cause: refused });
  });

  it('tags a reply whose body is cut off as a NetworkError', async () => {
    const reset = new Error('socket hang up');
    const cutOff = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(reset);
          },
        }),
        { status: 200 },
      );
    const { initialize } = bootAdapter(vi.fn(async () => cutOff()));
    const error = await initialize().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MattermostNetworkError);
    expect(error).toMatchObject({ name: 'NetworkError', cause: reset });
  });

  it('tags the request timeout as a NetworkError', async () => {
    const hang = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const { initialize } = bootAdapter(hang, { requestTimeoutMs: 5 });
    const error = await initialize().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MattermostNetworkError);
    expect((error as Error).cause).toMatchObject({ name: 'TimeoutError' });
  });

  it.each([400, 401, 403, 404])('fails fast on a %i', async (status) => {
    const { initialize } = bootAdapter(vi.fn(async () => Response.json({ id: 'api.error' }, { status })));
    const error = await initialize().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MattermostApiError);
    expect(error).toMatchObject({ name: 'MattermostApiError', status });
  });

  it('starts on the next attempt once the server is back', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValue(Response.json({ id: BOT_ID, username: 'nanoclaw-bot', is_bot: true }));
    const { adapter, initialize } = bootAdapter(fetchImpl);
    await expect(initialize()).rejects.toMatchObject({ name: 'NetworkError' });
    await initialize();
    expect(adapter.botUserId).toBe(BOT_ID);
  });
});
