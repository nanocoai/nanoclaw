import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import MarkdownIt from 'markdown-it';

import { DATA_DIR, INSTALL_SLUG } from '../config.js';
import { readEnvFile } from '../env.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionForAgent } from '../db/sessions.js';
import { log } from '../log.js';
import { withExistingMailboxSession } from '../session-manager.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  createLocalWebAgent,
  ensureLocalWebConversations,
  isKnownLocalWebPlatformId,
  listLocalWebCatalog,
  LOCAL_WEB_CHANNEL_TYPE,
  LOCAL_WEB_LEGACY_PLATFORM_ID,
  LOCAL_WEB_USER_ID,
  localWebPlatformIdForConversation,
  localWebQuestionBelongsToConversation,
  parseCreateLocalWebAgentRequest,
} from './local-web-conversations.js';
import { resolveQuestionRender } from './question-render-registry.js';

const CHANNEL_TYPE = LOCAL_WEB_CHANNEL_TYPE;
const LISTEN_HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_QUESTION_ID_CHARS = 256;
const TOKEN_HEADER = 'x-nanoclaw-local-web-token';
const TOKEN_FILE = path.join(DATA_DIR, 'local-web', 'token');

const LOCAL_WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

type ParseFailure = { ok: false; status: number; message: string };
type ParsedObject = { ok: true; value: Record<string, unknown> } | ParseFailure;
type ParsedMessage = { ok: true; conversationId: string; text: string } | ParseFailure;
type ParsedAction = { ok: true; conversationId: string; questionId: string; option: number } | ParseFailure;

type WebEvent =
  | { type: 'reply'; text: string; html: string }
  | { type: 'question-resolution'; questionId: string; resolution: string }
  | {
      type: 'question';
      questionId: string;
      title: string;
      question: string;
      options: Array<{ label: string; selectedLabel: string; style?: string }>;
    };

const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true });
markdown.validateLink = (url) => /^(?:https?:|mailto:)/i.test(url.trim());

export function configuredPort(): number {
  const raw = process.env.NANOCLAW_LOCAL_WEB_PORT ?? readEnvFile(['NANOCLAW_LOCAL_WEB_PORT']).NANOCLAW_LOCAL_WEB_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`NANOCLAW_LOCAL_WEB_PORT must be an integer from 1 to 65535: ${raw}`);
  }
  return port;
}

/**
 * The browser's authenticator, and the reason this channel can hold approval
 * buttons at all. Agent containers reach this loopback port through
 * host.docker.internal, the same route they use for Ollama, so it cannot be
 * closed, and every click resolves as the hardcoded owner LOCAL_USER_ID. The
 * shared secret is what separates the browser from the model.
 *
 * Minted once and reused for the life of the install. `data/` is never mounted
 * into a container, which is what keeps the file out of the agent's reach; the
 * 0600 mode is the same tier as `data/cli.sock`. The value is read once at
 * startup, so revoking means deleting the file and restarting the host.
 */
export function readOrCreateToken(): string {
  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file; an empty or
  // group-readable leftover keeps its old mode without this.
  fs.chmodSync(TOKEN_FILE, 0o600);
  return token;
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const supplied = req.headers[TOKEN_HEADER];
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestAuthority(req: IncomingMessage, port: number): string | null {
  const host = req.headers.host?.toLowerCase();
  if (host !== `${LISTEN_HOST}:${port}` && host !== `localhost:${port}`) return null;
  return `http://${host}`;
}

function requestOriginAllowed(req: IncomingMessage, authority: string): boolean {
  const origin = req.headers.origin;
  if (origin && origin !== authority) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
}

async function parseObject(req: IncomingMessage): Promise<ParsedObject> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, message: 'Expected application/json.' };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > MAX_BODY_BYTES) return { ok: false, status: 413, message: 'Message is too large.' };
    chunks.push(data);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, status: 400, message: 'Invalid JSON.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, status: 400, message: 'Expected a message object.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

async function parseMessage(req: IncomingMessage): Promise<ParsedMessage> {
  const parsed = await parseObject(req);
  if (!parsed.ok) return parsed;
  const unexpected = Object.keys(parsed.value).find((field) => field !== 'conversationId' && field !== 'text');
  if (unexpected) return { ok: false, status: 400, message: `Unknown field: ${unexpected}.` };
  const conversationId = parsed.value.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 128) {
    return { ok: false, status: 400, message: 'A valid conversation ID is required.' };
  }
  const text = parsed.value.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, status: 400, message: 'Message text is required.' };
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, status: 413, message: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` };
  }
  return { ok: true, conversationId, text: text.trim() };
}

async function parseAction(req: IncomingMessage): Promise<ParsedAction> {
  const parsed = await parseObject(req);
  if (!parsed.ok) return parsed;
  const unexpected = Object.keys(parsed.value).find(
    (field) => field !== 'conversationId' && field !== 'questionId' && field !== 'option',
  );
  if (unexpected) return { ok: false, status: 400, message: `Unknown field: ${unexpected}.` };
  const { conversationId, questionId, option } = parsed.value;
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 128) {
    return { ok: false, status: 400, message: 'A valid conversation ID is required.' };
  }
  if (typeof questionId !== 'string' || questionId.length === 0 || questionId.length > MAX_QUESTION_ID_CHARS) {
    return { ok: false, status: 400, message: 'A valid question ID is required.' };
  }
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 0) {
    return { ok: false, status: 400, message: 'A valid option is required.' };
  }
  return { ok: true, conversationId, questionId, option };
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, responseHeaders('application/json; charset=utf-8'));
  res.end(JSON.stringify(body));
}

function extractText(message: OutboundMessage): string | null {
  if (typeof message.content === 'string') return message.content;
  if (!message.content || typeof message.content !== 'object') return null;
  const content = message.content as Record<string, unknown>;
  if (typeof content.text === 'string') return content.text;
  return null;
}

async function toWebEvent(message: OutboundMessage): Promise<WebEvent | null> {
  if (message.content && typeof message.content === 'object') {
    const content = message.content as Record<string, unknown>;
    if (content.operation === 'edit' && typeof content.messageId === 'string') {
      const terminalCard = content.terminalCard;
      const resolution =
        terminalCard && typeof terminalCard === 'object' && !Array.isArray(terminalCard)
          ? (terminalCard as Record<string, unknown>).resolution
          : undefined;
      if (typeof resolution === 'string') {
        return { type: 'question-resolution', questionId: content.messageId, resolution };
      }
    }
    if (content.type === 'ask_question' && typeof content.questionId === 'string') {
      const render = await resolveQuestionRender(content.questionId);
      if (render) {
        return {
          type: 'question',
          questionId: content.questionId,
          title: render.title,
          question: render.question ?? (typeof content.question === 'string' ? content.question : ''),
          options: render.options.map(({ label, selectedLabel, style }) => ({
            label,
            selectedLabel,
            ...(style && { style }),
          })),
        };
      }
    }
  }
  const text = extractText(message);
  return text === null ? null : { type: 'reply', text, html: markdown.render(text) };
}

async function currentTool(platformId: string): Promise<string | null> {
  const messagingGroup = await getMessagingGroupByPlatform(CHANNEL_TYPE, platformId, CHANNEL_TYPE);
  if (!messagingGroup) return null;

  for (const wiring of await getMessagingGroupAgents(messagingGroup.id)) {
    const session = await findSessionForAgent(wiring.agent_group_id, messagingGroup.id, null);
    if (!session) continue;
    try {
      const state = await withExistingMailboxSession(wiring.agent_group_id, session.id, (mailbox) =>
        mailbox.getContainerState(),
      );
      if (state?.currentTool) return state.currentTool;
      // eslint-disable-next-line no-catch-all/no-catch-all -- activity is advisory; a transient DB read failure must never break chat delivery
    } catch {
      // A session may disappear while its activity is sampled.
    }
  }
  return null;
}

function createAdapter(): ChannelAdapter {
  const port = configuredPort();
  const token = readOrCreateToken();
  // Exact-match table, so no request path ever reaches the filesystem. Splitting
  // the stylesheet and script out of the document is what lets the CSP name
  // 'self' instead of 'unsafe-inline'.
  const readAsset = (file: string): string => fs.readFileSync(path.join(process.cwd(), 'src/channels', file), 'utf8');
  const assets: Record<string, { body: string; contentType: string }> = {
    '/': { body: readAsset('local-web-page.html'), contentType: 'text/html; charset=utf-8' },
    '/local-web-page.css': { body: readAsset('local-web-page.css'), contentType: 'text/css; charset=utf-8' },
    '/local-web-chat.css': { body: readAsset('local-web-chat.css'), contentType: 'text/css; charset=utf-8' },
    '/local-web-conversations.css': {
      body: readAsset('local-web-conversations.css'),
      contentType: 'text/css; charset=utf-8',
    },
    '/local-web-conversation-ui.js': {
      body: readAsset('local-web-conversation-ui.js'),
      contentType: 'text/javascript; charset=utf-8',
    },
    '/local-web-page.js': { body: readAsset('local-web-page.js'), contentType: 'text/javascript; charset=utf-8' },
  };
  const clients = new Map<string, Set<ServerResponse>>();
  // Server-side buffer while no browser is connected; unrelated to the page's own 100-item view cap.
  const MAX_PENDING_EVENTS = 100;
  const pendingEvents = new Map<string, WebEvent[]>();
  let server: http.Server | null = null;
  const awaitingReplies = new Set<string>();

  function publish(platformId: string, event: unknown): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients.get(platformId) ?? []) client.write(frame);
  }

  function queue(platformId: string, event: WebEvent): void {
    const pending = pendingEvents.get(platformId) ?? [];
    pending.push(event);
    if (pending.length > MAX_PENDING_EVENTS) pending.shift();
    pendingEvents.set(platformId, pending);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse, setup: ChannelSetup): Promise<void> {
    const authority = requestAuthority(req, port);
    if (!authority) {
      sendJson(res, 403, { error: 'Local requests only.' });
      return;
    }
    const url = new URL(req.url ?? '/', authority);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, channel: CHANNEL_TYPE, install: INSTALL_SLUG });
      return;
    }
    const asset = req.method === 'GET' ? assets[pathname] : undefined;
    if (asset) {
      res.writeHead(200, responseHeaders(asset.contentType));
      res.end(asset.body);
      return;
    }

    // Everything below carries conversation data or resolves an approval, so it
    // is token-gated. The page assets and `/healthz` stay open deliberately:
    // they expose neither, a subresource request cannot carry a header anyway,
    // and the shell has to load before it can present its token or explain that
    // it has none. The Origin/Host checks above and below are defense-in-depth
    // only: an HTTP client sets those headers freely.
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, {
        error: 'This browser is not authorized. Run `pnpm local-web` in the NanoClaw folder and open its link.',
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      sendJson(res, 200, await listLocalWebCatalog());
      return;
    }
    if (req.method === 'GET' && pathname === '/events') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const conversationId = url.searchParams.get('conversationId');
      if (!conversationId || conversationId.length > 128) {
        sendJson(res, 400, { error: 'A valid conversation ID is required.' });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      res.writeHead(200, {
        ...responseHeaders('text/event-stream; charset=utf-8'),
        connection: 'keep-alive',
      });
      const conversationClients = clients.get(platformId) ?? new Set<ServerResponse>();
      conversationClients.add(res);
      clients.set(platformId, conversationClients);
      req.on('close', () => {
        conversationClients.delete(res);
        if (conversationClients.size === 0) clients.delete(platformId);
      });
      for (const event of pendingEvents.get(platformId) ?? []) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      pendingEvents.delete(platformId);
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/messages') {
      if (!requestOriginAllowed(req, authority) || req.headers.origin !== authority) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseMessage(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(parsed.conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      await setup.onInbound(platformId, null, {
        id: `local-web-${randomUUID()}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: { text: parsed.text, sender: 'browser', senderId: LOCAL_WEB_USER_ID },
        isGroup: false,
      });
      awaitingReplies.add(platformId);
      sendJson(res, 202, { ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/agents') {
      if (!requestOriginAllowed(req, authority) || req.headers.origin !== authority) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const request = parseCreateLocalWebAgentRequest(parsed.value);
      if (!request.ok) {
        sendJson(res, 400, { error: request.message });
        return;
      }
      const result = await createLocalWebAgent(request.value);
      if (!result.ok) {
        if (result.detail) {
          log.warn('Local web agent creation stopped', { stage: result.stage, detail: result.detail });
        }
        sendJson(res, result.status, { error: result.message, ...(result.stage && { stage: result.stage }) });
        return;
      }
      sendJson(res, result.created ? 201 : 200, result);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/actions') {
      if (!requestOriginAllowed(req, authority) || req.headers.origin !== authority) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseAction(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(parsed.conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      if (!(await localWebQuestionBelongsToConversation(parsed.questionId, parsed.conversationId))) {
        sendJson(res, 404, { error: 'This question is not pending in this conversation.' });
        return;
      }
      const render = await resolveQuestionRender(parsed.questionId);
      if (!render) {
        sendJson(res, 404, { error: 'This question is no longer pending.' });
        return;
      }
      if (parsed.option >= render.options.length) {
        sendJson(res, 400, { error: 'A valid option is required.' });
        return;
      }
      const selected = render.options[parsed.option]!;
      setup.onAction(parsed.questionId, selected.value, LOCAL_WEB_USER_ID);
      publish(platformId, {
        type: 'question-resolution',
        questionId: parsed.questionId,
        resolution: selected.selectedLabel,
      });
      sendJson(res, 202, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  }

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config): Promise<void> {
      await ensureLocalWebConversations();
      server = http.createServer((req, res) => {
        void handleRequest(req, res, config).catch((err: unknown) => {
          log.error('Local web chat request failed', { err });
          if (!res.headersSent) sendJson(res, 500, { error: 'Request failed.' });
          else res.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, LISTEN_HOST, resolve);
      });
      log.info('Local web chat listening', { url: `http://${LISTEN_HOST}:${port}`, launchCommand: 'pnpm local-web' });
    },

    async teardown(): Promise<void> {
      for (const conversationClients of clients.values()) {
        for (const client of conversationClients) client.end();
      }
      clients.clear();
      pendingEvents.clear();
      awaitingReplies.clear();
      if (!server) return;
      const active = server;
      server = null;
      await new Promise<void>((resolve) => active.close(() => resolve()));
    },

    isConnected(): boolean {
      return server?.listening === true;
    },

    // There is one machine-local browser identity. Host-initiated DMs
    // (approval cards) resolve the approver's handle through ensureUserDm;
    // without openDM it would derive the bare handle and mint a phantom
    // messaging group that deliver() rejects, so the card is never rendered.
    async openDM(): Promise<string> {
      return LOCAL_WEB_LEGACY_PLATFORM_ID;
    },

    async deliver(platformId, _threadId, message): Promise<string | undefined> {
      if (!(await isKnownLocalWebPlatformId(platformId))) return undefined;
      const event = await toWebEvent(message);
      if (event === null) return undefined;
      const completesTurn = event.type === 'reply' || event.type === 'question';
      if (completesTurn) awaitingReplies.delete(platformId);
      if ((clients.get(platformId)?.size ?? 0) === 0) {
        queue(platformId, event);
      } else {
        publish(platformId, event);
      }
      return event.type === 'question' ? event.questionId : undefined;
    },

    async setTyping(platformId): Promise<void> {
      if (!awaitingReplies.has(platformId)) return;
      const tool = await currentTool(platformId);
      publish(platformId, tool ? { type: 'tool', name: tool } : { type: 'thinking' });
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter, defaults: LOCAL_WEB_DEFAULTS });
