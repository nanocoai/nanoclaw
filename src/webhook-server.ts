/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *   /webhook/{path}        → raw handler from registerWebhookHandler(path, ...)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance. Raw routes let modules receive non-Chat-SDK
 * webhooks (GitHub, payment providers, health checks) on the same server
 * without editing this file or opening a second port.
 */
import http from 'http';

import type { Chat } from 'chat';

import { log } from './log.js';

const DEFAULT_PORT = 3000;

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

/** Node-style handler for raw (non-Chat-SDK) webhook routes. */
export type RawWebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const routes = new Map<string, WebhookEntry>();
const rawRoutes = new Map<string, RawWebhookHandler>();
let server: http.Server | null = null;

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 *
 * `routingPath` is the URL segment (`/webhook/<routingPath>`); `adapterName`
 * stays the handler key into `chat.webhooks`. The split lets N instances of
 * one platform (each with its own Chat + signing secret) listen on distinct
 * URLs while dispatching to the same SDK adapter name. Defaulting
 * routingPath to adapterName keeps the historical single-instance route
 * byte-identical. Signature adopted verbatim from PR #2617 (@davekim917's
 * #1804 prototype) so the two changes converge textually.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string, routingPath: string = adapterName): void {
  routes.set(routingPath, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${routingPath}` });
}

/**
 * Register a raw Node-style handler at /webhook/{path} on the shared server.
 *
 * For webhooks that don't flow through a Chat SDK adapter (GitHub, payment
 * providers, health checks): modules register their endpoint here instead of
 * editing this file or standing up a second HTTP server on another port.
 * The handler owns the request/response directly.
 *
 * Starts the server lazily on first call.
 */
export function registerWebhookHandler(path: string, handler: RawWebhookHandler): void {
  rawRoutes.set(path, handler);
  ensureServer();
  log.info('Webhook handler registered', { path: `/webhook/${path}` });
}

function ensureServer(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // Route: /webhook/{adapterName}
    const match = url.match(/^\/webhook\/([^/?]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const adapterName = match[1];

    try {
      // Raw routes take priority — the handler writes the response itself.
      const rawHandler = rawRoutes.get(adapterName);
      if (rawHandler) {
        await rawHandler(req, res);
        return;
      }

      const entry = routes.get(adapterName);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Unknown adapter: ${adapterName}`);
        return;
      }

      const webReq = await toWebRequest(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      log.error('Webhook handler error', { adapter: adapterName, url: req.url, err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    rawRoutes.clear();
    log.info('Webhook server stopped');
  }
}
