/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName}          → chat.webhooks[adapterName](request)
 *   /webhook/{path}                 → raw handler from registerWebhookHandler(path, ...)
 *   /webhook/{type}/{instance}      → a per-instance adapter route (two segments)
 *   /webhook/{pending path}         → pending-instance answers (registerPendingWebhookRoute)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance. Raw routes let modules receive non-Chat-SDK
 * webhooks (GitHub, payment providers, health checks) on the same server
 * without editing this file or opening a second port.
 *
 * Routing paths are one or two URL segments. A request's two-segment path is
 * tried first and only when such a route exists; otherwise the first segment
 * routes exactly as it always has, so `/webhook/slack/<anything>` keeps
 * reaching the default `slack` route until a `slack/<instance>` route is
 * registered.
 */
import http from 'http';
import { randomUUID } from 'node:crypto';

import type { Chat } from 'chat';

import { getWebhookPort } from './config.js';
import { log } from './log.js';

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

/** Node-style handler for raw (non-Chat-SDK) webhook routes. */
export type RawWebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const routes = new Map<string, WebhookEntry>();
const rawRoutes = new Map<string, RawWebhookHandler>();
const pendingRoutes = new Set<string>();
let server: http.Server | null = null;
let listenerId: string | null = null;

/** Report only a successfully bound listener owned by this host process. */
export function getWebhookStatus(): { id: string; port: number; paths: string[] } | null {
  const address = server?.address();
  if (!server?.listening || !address || typeof address === 'string' || !listenerId) return null;
  return {
    id: listenerId,
    port: address.port,
    paths: [...new Set([...routes.keys(), ...rawRoutes.keys(), ...pendingRoutes])].map((p) => `/webhook/${p}`),
  };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const body = await readBody(req);

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
 * `routingPath` is the URL path under `/webhook/` (one or two segments);
 * `adapterName` stays the handler key into `chat.webhooks`. The split lets N
 * instances of one platform (each with its own Chat + signing secret) listen
 * on distinct URLs while dispatching to the same SDK adapter name.
 * Defaulting routingPath to adapterName keeps the historical single-instance
 * route byte-identical. Signature adopted verbatim from PR #2617
 * (@davekim917's #1804 prototype) so the two changes converge textually.
 *
 * A live registration consumes any pending entry at the same path. Returns a
 * disposer that removes this registration (and only this one — a later
 * registration at the same path is left alone).
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string, routingPath: string = adapterName): () => void {
  const entry: WebhookEntry = { chat, adapterName };
  routes.set(routingPath, entry);
  pendingRoutes.delete(routingPath);
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${routingPath}` });
  return () => {
    if (routes.get(routingPath) === entry) {
      routes.delete(routingPath);
      log.info('Webhook adapter unregistered', { adapter: adapterName, path: `/webhook/${routingPath}` });
    }
  };
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

/**
 * Hold a route for an adapter instance that is registered but cannot start
 * yet because its credentials are not available (a connection whose secrets
 * are not sealed yet, or are being rotated). While pending, the route:
 *  - answers a Slack `url_verification` by echoing the challenge, with NO
 *    signature check — the instance has no signing secret to check with,
 *    and the challenge is Slack's own public nonce, so nothing is trusted
 *    by answering it. This lets an administrator save the Request URL in
 *    Slack before the host holds the app's credentials;
 *  - acknowledges every other request (200, empty) and drops it with one
 *    warning line: nothing can be verified or processed without
 *    credentials, and a non-2xx would make Slack retry and eventually
 *    disable the app's event delivery, which the operator would then have to
 *    re-enable by hand.
 * The pending entry is consumed by the live registration at the same path
 * (registerWebhookAdapter); unregisterWebhookRoute removes it explicitly.
 * A live route at the same path always wins over a pending one.
 * Starts the server lazily on first call.
 */
export function registerPendingWebhookRoute(routingPath: string): void {
  pendingRoutes.add(routingPath);
  ensureServer();
  log.info('Webhook route pending (instance credentials not available yet)', { path: `/webhook/${routingPath}` });
}

/**
 * Remove whatever is registered at a routing path — adapter, raw handler, or
 * pending entry. Returns true when something was removed. The listener
 * itself keeps running (stopWebhookServer shuts it down).
 */
export function unregisterWebhookRoute(routingPath: string): boolean {
  const removed = routes.delete(routingPath) || rawRoutes.delete(routingPath) || pendingRoutes.delete(routingPath);
  if (removed) log.info('Webhook route unregistered', { path: `/webhook/${routingPath}` });
  return removed;
}

function hasRoute(routingPath: string): boolean {
  return rawRoutes.has(routingPath) || routes.has(routingPath) || pendingRoutes.has(routingPath);
}

/** Answer a request at a pending route: echo a Slack url_verification challenge, ack and drop the rest. */
async function answerPending(routingPath: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readBody(req)).toString('utf8');
  let challenge: string | undefined;
  try {
    const parsed = JSON.parse(body) as { type?: unknown; challenge?: unknown };
    if (parsed?.type === 'url_verification' && typeof parsed.challenge === 'string') challenge = parsed.challenge;
  } catch {
    // not JSON — nothing to echo
  }
  if (challenge !== undefined) {
    log.info('Webhook pending route answered url_verification', { path: `/webhook/${routingPath}` });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ challenge }));
    return;
  }
  log.warn('Webhook pending route acknowledged and dropped a request (instance credentials not available)', {
    path: `/webhook/${routingPath}`,
    method: req.method,
  });
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end();
}

function ensureServer(): void {
  if (server) return;

  const port = getWebhookPort();
  const id = randomUUID();

  const candidate = http.createServer((req, res) => {
    res.setHeader('x-nanoclaw-webhook-id', id);
    void (async () => {
      const url = req.url || '/';

      // Route: /webhook/{adapterName} or /webhook/{type}/{instance}
      const match = url.match(/^\/webhook\/([^/?]+)(?:\/([^/?]+))?/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const adapterName = match[1];
      const twoSegment = match[2] !== undefined ? `${adapterName}/${match[2]}` : undefined;
      const routingPath = twoSegment !== undefined && hasRoute(twoSegment) ? twoSegment : adapterName;

      try {
        // Raw routes take priority — the handler writes the response itself.
        const rawHandler = rawRoutes.get(routingPath);
        if (rawHandler) {
          await rawHandler(req, res);
          return;
        }

        const entry = routes.get(routingPath);
        if (!entry) {
          if (pendingRoutes.has(routingPath)) {
            await answerPending(routingPath, req, res);
            return;
          }
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
            void p.catch(() => {});
          },
        });
        await fromWebResponse(webRes, res);
      } catch (err) {
        log.error('Webhook handler error', { adapter: routingPath, url: req.url, err });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    })();
  });

  // Keep the candidate as the singleton while listen is pending so concurrent
  // registrations cannot create competing listeners. A failed listen must
  // release that singleton, though, or later registrations can never retry.
  server = candidate;
  listenerId = id;
  candidate.on('error', (err) => {
    if (!candidate.listening && server === candidate) server = null;
    log.error('Webhook server error', { port, err });
  });

  candidate.listen(port, '0.0.0.0', () => {
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
    pendingRoutes.clear();
    log.info('Webhook server stopped');
  }
}
