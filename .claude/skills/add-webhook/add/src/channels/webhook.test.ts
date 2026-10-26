import { AddressInfo } from 'net';
import { createServer, request } from 'http';
import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { httpsRequestMock } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
}));

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  return {
    ...actual,
    request: httpsRequestMock,
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { WebhookChannel, WebhookChannelOpts } from './webhook.js';

function createOpts(
  overrides?: Partial<WebhookChannelOpts>,
): WebhookChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    ...overrides,
  };
}

function getListeningPort(channel: WebhookChannel): number {
  const server = (channel as any).server as import('http').Server;
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Server is not bound to a TCP port');
  }
  return addr.port;
}

async function httpJsonRequest(params: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  token?: string;
  jsonBody?: unknown;
  rawBody?: string;
}): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
  const body =
    params.rawBody !== undefined
      ? params.rawBody
      : params.jsonBody !== undefined
        ? JSON.stringify(params.jsonBody)
        : '';

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: params.port,
        method: params.method,
        path: params.path,
        headers: {
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }
            : {}),
          ...(params.token
            ? { authorization: `Bearer ${params.token}` }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k] = Array.isArray(v) ? v.join(',') : (v || '').toString();
          }
          resolve({
            statusCode: res.statusCode || 0,
            body: text,
            headers,
          });
        });
      },
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('WebhookChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles inbound message payloads', async () => {
    const opts = createOpts();
    const channel = new WebhookChannel(
      0,
      '127.0.0.1',
      undefined,
      'http://127.0.0.1:19400/v1/outbound',
      opts,
    );

    await channel.connect();
    const port = getListeningPort(channel);

    const response = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/v1/inbound',
      jsonBody: {
        userId: 'user-123',
        content: 'hello webhook',
        senderName: 'Alice',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(opts.onMessage).toHaveBeenCalledWith(
      'wh:user-123',
      expect.objectContaining({
        chat_jid: 'wh:user-123',
        sender: 'user-123',
        sender_name: 'Alice',
        content: 'hello webhook',
        is_from_me: false,
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'wh:user-123',
      expect.any(String),
      'wh:user-123',
      'webhook',
      false,
    );

    await channel.disconnect();
  });

  it('rejects unauthorized requests when token auth is enabled', async () => {
    const channel = new WebhookChannel(
      0,
      '127.0.0.1',
      'secret-token',
      'http://127.0.0.1:19400/v1/outbound',
      createOpts(),
    );

    await channel.connect();
    const port = getListeningPort(channel);

    const response = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/health',
    });

    expect(response.statusCode).toBe(401);

    await channel.disconnect();
  });

  it('serves health endpoint', async () => {
    const channel = new WebhookChannel(
      0,
      '127.0.0.1',
      undefined,
      'http://127.0.0.1:19400/v1/outbound',
      createOpts(),
    );

    await channel.connect();
    const port = getListeningPort(channel);

    const response = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      channel: 'webhook',
    });

    await channel.disconnect();
  });

  it('returns 404 for unknown routes', async () => {
    const channel = new WebhookChannel(
      0,
      '127.0.0.1',
      undefined,
      'http://127.0.0.1:19400/v1/outbound',
      createOpts(),
    );

    await channel.connect();
    const port = getListeningPort(channel);

    const response = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/does-not-exist',
    });

    expect(response.statusCode).toBe(404);

    await channel.disconnect();
  });

  it('returns 400 for invalid JSON payloads', async () => {
    const channel = new WebhookChannel(
      0,
      '127.0.0.1',
      undefined,
      'http://127.0.0.1:19400/v1/outbound',
      createOpts(),
    );

    await channel.connect();
    const port = getListeningPort(channel);

    const response = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/v1/inbound',
      rawBody: '{"broken":',
    });

    expect(response.statusCode).toBe(400);

    await channel.disconnect();
  });

  it('owns only wh: prefixed JIDs', () => {
    const channel = new WebhookChannel(
      18794,
      '127.0.0.1',
      undefined,
      'http://127.0.0.1:19400/v1/outbound',
      createOpts(),
    );

    expect(channel.ownsJid('wh:user-1')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('123@g.us')).toBe(false);
  });

  it('forwards sendMessage payload to connector URL', async () => {
    const received = new Promise<{
      method: string;
      path: string;
      body: Record<string, unknown>;
    }>((resolve) => {
      const connector = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end('{"ok":true}');
          resolve({
            method: req.method || '',
            path: req.url || '',
            body: JSON.parse(raw),
          });
        });
      });

      connector.listen(0, '127.0.0.1', async () => {
        const addr = connector.address() as AddressInfo;

        const channel = new WebhookChannel(
          18794,
          '127.0.0.1',
          undefined,
          `http://127.0.0.1:${addr.port}/v1/outbound`,
          createOpts(),
        );

        await channel.sendMessage('wh:user-9', 'hello connector');
        connector.close();
      });
    });

    const req = await received;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/outbound');
    expect(req.body).toEqual(
      expect.objectContaining({
        jid: 'wh:user-9',
        text: 'hello connector',
        channel: 'webhook',
      }),
    );
  });

  it('allows https connector URLs in sendMessage', async () => {
    httpsRequestMock.mockImplementation(
      (_options: unknown, onResponse?: (res: unknown) => void) => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          resume: () => void;
        };
        res.statusCode = 200;
        res.resume = () => {};

        const req = new EventEmitter() as EventEmitter & {
          write: (chunk: string) => void;
          end: () => void;
        };
        req.write = () => {};
        req.end = () => {
          onResponse?.(res);
          res.emit('end');
        };

        return req;
      },
    );

    const channel = new WebhookChannel(
      18794,
      '127.0.0.1',
      undefined,
      'https://example.test/v1/outbound',
      createOpts(),
    );

    await channel.sendMessage('wh:user-https', 'hello secure connector');

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        hostname: 'example.test',
        port: 443,
        path: '/v1/outbound',
      }),
      expect.any(Function),
    );
  });
});
