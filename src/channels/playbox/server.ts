import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { DATA_DIR } from '../../config.js';
import {
  parsePlayboxInbound,
  playboxFaultSchema,
  type PlayboxEvent,
  type PlayboxFault,
  type PlayboxInbound,
} from './protocol.js';

const MAX_BODY_BYTES = 21 * 1024 * 1024;
const MAX_EVENTS = 500;

export interface MaterializedPlayboxInbound extends Omit<PlayboxInbound, 'attachments'> {
  attachments: Array<{ type: string; name: string; localPath: string }>;
}

interface PlayboxServerOptions {
  port?: number;
  attachmentRoot?: string;
  staticRoot?: string;
  fixtureRoot?: string;
  onInbound?: (message: MaterializedPlayboxInbound) => void | Promise<void>;
}

function safeHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'",
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export class PlayboxServer {
  private readonly port: number;
  private readonly attachmentRoot: string;
  private readonly staticRoot: string;
  private readonly fixtureRoot: string;
  private readonly onInbound?: PlayboxServerOptions['onInbound'];
  private readonly history: PlayboxEvent[] = [];
  private readonly seenIds = new Set<string>();
  private readonly clients = new Set<ServerResponse>();
  private readonly faults: PlayboxFault[] = [];
  private httpServer: Server | undefined;

  constructor(options: PlayboxServerOptions = {}) {
    this.port = options.port ?? 3210;
    this.attachmentRoot = resolve(options.attachmentRoot ?? join(DATA_DIR, 'attachments'));
    this.staticRoot = resolve(options.staticRoot ?? join(process.cwd(), 'playbox'));
    this.fixtureRoot = resolve(options.fixtureRoot ?? join(process.cwd(), 'test', 'fixtures', 'playbox'));
    this.onInbound = options.onInbound;
  }

  async start(): Promise<number> {
    if (this.httpServer) return this.address();
    await mkdir(this.attachmentRoot, { recursive: true, mode: 0o700 });
    this.httpServer = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolveStart, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.port, '127.0.0.1', () => resolveStart());
    });
    return this.address();
  }

  private address(): number {
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Playbox server is not listening');
    return address.port;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
  }

  events(): readonly PlayboxEvent[] {
    return [...this.history];
  }

  emit(event: PlayboxEvent): void {
    this.history.push(event);
    if (this.history.length > MAX_EVENTS) this.history.shift();
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  takeFault(): PlayboxFault | undefined {
    return this.faults.shift();
  }

  async accept(input: unknown): Promise<MaterializedPlayboxInbound> {
    const message = parsePlayboxInbound(input);
    if (this.seenIds.has(message.id)) throw Object.assign(new Error('Duplicate inbound id'), { status: 409 });
    this.seenIds.add(message.id);
    try {
      const attachments = await Promise.all(
        message.attachments.map(async (attachment, index) => {
          const extension = extname(attachment.name).toLowerCase();
          const filename = `${message.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${index}${extension}`;
          await writeFile(join(this.attachmentRoot, filename), Buffer.from(attachment.dataBase64, 'base64'), {
            mode: 0o600,
          });
          return { type: attachment.type, name: attachment.name, localPath: `attachments/${filename}` };
        }),
      );
      const materialized = { ...message, attachments };
      await this.onInbound?.(materialized);
      this.emit({ type: 'delivery', inboundId: message.id, state: 'accepted' });
      return materialized;
    } catch (error) {
      this.seenIds.delete(message.id);
      this.emit({ type: 'delivery', inboundId: message.id, state: 'rejected' });
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    safeHeaders(response);
    const forwardedHost = request.headers['x-forwarded-host'];
    if (forwardedHost && !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(String(forwardedHost))) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(': connected\n\n');
        this.clients.add(response);
        request.on('close', () => this.clients.delete(response));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/messages') {
        await this.accept(await readJson(request));
        response.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":true}');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        this.history.length = 0;
        this.seenIds.clear();
        this.faults.length = 0;
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/faults') {
        this.faults.push(playboxFaultSchema.parse(await readJson(request)));
        response.writeHead(202).end();
        return;
      }
      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (request.method === 'GET' && ['index.html', 'app.js', 'styles.css'].includes(asset)) {
        const data = await readFile(join(this.staticRoot, asset));
        const contentType = asset.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : asset.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : 'text/css; charset=utf-8';
        response.writeHead(200, { 'Content-Type': contentType }).end(data);
        return;
      }
      const fixture = url.pathname.replace(/^\/fixtures\//, '');
      if (
        request.method === 'GET' &&
        url.pathname.startsWith('/fixtures/') &&
        ['receipt-coffee.png', 'receipt-grocery.pdf'].includes(fixture)
      ) {
        const data = await readFile(join(this.fixtureRoot, fixture));
        const contentType = fixture.endsWith('.png') ? 'image/png' : 'application/pdf';
        response.writeHead(200, { 'Content-Type': contentType }).end(data);
        return;
      }
      response.writeHead(404).end('Not found');
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 400;
      response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"error":"invalid request"}');
    }
  }
}
