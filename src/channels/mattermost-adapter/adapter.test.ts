import type { ChatInstance } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import { MattermostAdapter } from './adapter.js';

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
