/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance.
 */
import http from 'http';

import type { Chat } from 'chat';

import { log } from './log.js';

const DEFAULT_PORT = 3000;
const DEFAULT_BIND = '127.0.0.1';

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

const routes = new Map<string, WebhookEntry>();
let server: http.Server | null = null;

/**
 * Resolve the listen address from the environment.
 *
 * Defaults to loopback so the webhook port is not exposed to the LAN. Set
 * `WEBHOOK_BIND=0.0.0.0` (or a specific interface IP) to opt into external
 * exposure — typically you want a reverse proxy in front instead.
 */
export function resolveListenConfig(env: NodeJS.ProcessEnv): { port: number; bind: string } {
  const portRaw = env.WEBHOOK_PORT;
  const port = portRaw ? parseInt(portRaw, 10) : DEFAULT_PORT;
  const bind = env.WEBHOOK_BIND || DEFAULT_BIND;
  return { port, bind };
}

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
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  routes.set(adapterName, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${adapterName}` });
}

function ensureServer(): void {
  if (server) return;

  const { port, bind } = resolveListenConfig(process.env);

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
    const entry = routes.get(adapterName);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown adapter: ${adapterName}`);
      return;
    }

    try {
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
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  server.listen(port, bind, () => {
    log.info('Webhook server started', { port, bind, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    log.info('Webhook server stopped');
  }
}
