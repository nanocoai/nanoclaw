import { randomUUID } from 'crypto';
import {
  IncomingMessage,
  Server,
  ServerResponse,
  createServer,
  request as httpRequest,
} from 'http';
import { request as httpsRequest } from 'https';
import { EventEmitter } from 'events';

import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface WebhookChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface InboundPayload {
  id?: unknown;
  userId?: unknown;
  content?: unknown;
  senderName?: unknown;
  chatName?: unknown;
  timestamp?: unknown;
}

export class WebhookChannel extends EventEmitter implements Channel {
  name = 'webhook';

  private server: Server | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly token: string;
  private readonly connectorUrl: string;
  private readonly opts: WebhookChannelOpts;

  constructor(
    port: number = 18794,
    host: string = '127.0.0.1',
    token: string | undefined,
    connectorUrl: string,
    opts: WebhookChannelOpts,
  ) {
    super();
    this.port = port;
    this.host = host;
    this.token = token?.trim() || '';
    this.connectorUrl = connectorUrl;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.server?.listening) return;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Webhook request handling failed');
        this.writeJson(res, 500, { error: 'internal_error' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', onError);
        logger.info(
          { host: this.host, port: this.port, connectorUrl: this.connectorUrl },
          'Webhook channel listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    let endpoint: URL;
    try {
      endpoint = new URL(this.connectorUrl);
    } catch (err) {
      logger.error({ err, connectorUrl: this.connectorUrl }, 'Invalid connector URL');
      return;
    }

    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      logger.error(
        { connectorUrl: this.connectorUrl },
        'Webhook connector URL must use http:// or https://',
      );
      return;
    }

    const reqFn = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;

    const payload = JSON.stringify({
      jid,
      text,
      channel: this.name,
      timestamp: new Date().toISOString(),
    });

    await new Promise<void>((resolve) => {
      const req = reqFn(
        {
          method: 'POST',
          hostname: endpoint.hostname,
          port: endpoint.port
            ? parseInt(endpoint.port, 10)
            : endpoint.protocol === 'https:'
              ? 443
              : 80,
          path: `${endpoint.pathname}${endpoint.search}`,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            if ((res.statusCode || 500) >= 400) {
              logger.warn(
                { jid, statusCode: res.statusCode },
                'Webhook connector returned non-2xx',
              );
            }
            resolve();
          });
        },
      );

      req.on('error', (err) => {
        logger.error({ err, jid }, 'Failed to forward message to webhook connector');
        resolve();
      });

      req.write(payload);
      req.end();
    });
  }

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wh:');
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    logger.info('Webhook channel stopped');
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (method === 'GET' && url.pathname === '/health') {
      this.writeJson(res, 200, { status: 'ok', channel: 'webhook' });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/inbound') {
      await this.handleInbound(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/outbound') {
      await this.handleOutbound(req, res);
      return;
    }

    this.writeJson(res, 404, { error: 'not_found' });
  }

  private async handleInbound(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.writeJson(res, 400, { error: 'invalid_json' });
      return;
    }

    const body = parsed.value as InboundPayload;
    if (typeof body.userId !== 'string' || typeof body.content !== 'string') {
      this.writeJson(res, 400, { error: 'invalid_payload' });
      return;
    }

    const userId = body.userId.trim();
    const content = body.content;
    if (!userId || !content) {
      this.writeJson(res, 400, { error: 'invalid_payload' });
      return;
    }

    const timestamp =
      typeof body.timestamp === 'string' && body.timestamp
        ? body.timestamp
        : new Date().toISOString();
    const chatJid = `wh:${userId}`;
    const msgId =
      typeof body.id === 'string' && body.id ? body.id : randomUUID();
    const senderName =
      typeof body.senderName === 'string' && body.senderName
        ? body.senderName
        : userId;
    const chatName =
      typeof body.chatName === 'string' && body.chatName
        ? body.chatName
        : chatJid;

    const message: NewMessage = {
      id: msgId,
      chat_jid: chatJid,
      sender: userId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(chatJid, message);
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'webhook', false);

    this.writeJson(res, 200, {
      status: 'accepted',
      chatJid,
      id: msgId,
    });
  }

  private async handleOutbound(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.writeJson(res, 400, { error: 'invalid_json' });
      return;
    }

    this.emit('outbound', parsed.value);
    this.writeJson(res, 200, { status: 'accepted' });
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.token) return true;
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  private writeJson(
    res: ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>,
  ): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  }

  private async readJson(
    req: IncomingMessage,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    try {
      const raw = await this.readBody(req);
      if (!raw) return { ok: true, value: {} };
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        raw += chunk;
        if (raw.length > 1024 * 1024) {
          reject(new Error('payload_too_large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }
}
