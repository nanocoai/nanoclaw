import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { ChatInstance } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import { MattermostAdapter } from './adapter.js';
import type { MattermostPost, MattermostWebSocketEvent } from './types.js';

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

function postedEvent(options: {
  channelType?: 'D' | 'O';
  id?: string;
  mentions?: string[];
  rootId?: string;
}): MattermostWebSocketEvent {
  const post: MattermostPost = {
    channel_id: CHANNEL_ID,
    create_at: 1,
    id: options.id ?? POST_ID,
    message: options.mentions?.includes(BOT_ID) ? '@nanoclaw-bot hello' : 'hello',
    ...(options.rootId ? { root_id: options.rootId } : {}),
    user_id: USER_ID,
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
}> {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/users/me')) {
      return response({ id: BOT_ID, is_bot: true, username: 'nanoclaw-bot' });
    }
    if (url.endsWith(`/users/${USER_ID}`)) {
      return response({ id: USER_ID, is_bot: false, username: 'operator' });
    }
    return response({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
  const processMessage = vi.fn();
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
  await adapter.initialize({ getLogger: () => logger, processMessage } as unknown as ChatInstance);
  return { adapter, processMessage };
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
