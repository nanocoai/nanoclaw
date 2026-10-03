/**
 * Web Chat channel adapter (v2) — native local browser chat.
 *
 * Serves a self-contained chat page and a JSON API on localhost:
 *  - GET  /                        — the chat UI (single inline HTML page, no assets)
 *  - POST /api/message             — user sent a message from the page; fires onInbound
 *  - GET  /api/messages?since=<ms> — page polls for agent replies
 *
 * Single-user, single-chat: one adapter instance = one messaging group with
 * `platform_id = "default"` (override with WEBCHAT_PLATFORM_ID). No threads,
 * no cold DM. Self-registers on import. Modeled on the emacs channel — the
 * other local, credential-free HTTP bridge; the page is served without auth
 * (it holds no secrets), the API requires the bearer token when one is set.
 */
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const OUTBOUND_BUFFER_MAX = 200;

/**
 * Single-operator localhost transport: every line is for the agent (pattern
 * '.'), and possession of the port + bearer token is the operator gate, the
 * same trust class as the CLI channel's 0600 socket — hence 'public'.
 */
const WEBCHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

interface BufferedMessage {
  text: string;
  timestamp: number;
}

interface WebchatAdapterOptions {
  port: number;
  authToken: string | null;
  platformId: string;
}

function createWebchatAdapter(opts: WebchatAdapterOptions): ChannelAdapter {
  let server: http.Server | null = null;
  let setupConfig: ChannelSetup | null = null;
  const outboundBuffer: BufferedMessage[] = [];

  function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!opts.authToken) return true;
    if (req.headers['authorization'] === `Bearer ${opts.authToken}`) return true;
    res
      .writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  function handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let text: string;
      try {
        const parsed = JSON.parse(body) as { text?: string };
        text = parsed.text ?? '';
      } catch {
        res
          .writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      if (!text.trim()) {
        res
          .writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ error: 'text required' }));
        return;
      }

      const timestamp = new Date().toISOString();
      const id = `webchat-${Date.now()}`;

      const inbound: InboundMessage = {
        id,
        kind: 'chat',
        content: {
          text,
          sender: 'Web',
          senderId: `webchat:${opts.platformId}`,
        },
        timestamp,
      };

      try {
        setupConfig?.onInbound(opts.platformId, null, inbound);
      } catch (err) {
        log.error('Webchat onInbound failed', { err });
      }

      res
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ messageId: id, timestamp: Date.now() }));
    });
  }

  function handlePoll(url: URL, res: http.ServerResponse): void {
    const since = parseInt(url.searchParams.get('since') ?? '0', 10);
    const messages = outboundBuffer.filter((m) => m.timestamp > since);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ messages }));
  }

  function handlePage(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  }

  return {
    name: 'webchat',
    channelType: 'webchat',
    supportsThreads: false,
    defaults: WEBCHAT_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          handlePage(res); // no auth: static page, holds no secrets
        } else if (req.method === 'POST' && url.pathname === '/api/message') {
          if (!checkAuth(req, res)) return;
          handlePost(req, res);
        } else if (req.method === 'GET' && url.pathname === '/api/messages') {
          if (!checkAuth(req, res)) return;
          handlePoll(url, res);
        } else {
          res
            .writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ error: 'Not found' }));
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(opts.port, '127.0.0.1', () => {
          log.info('Webchat channel listening', { port: opts.port, platformId: opts.platformId });
          resolve();
        });
      });

      // Stamp a human-readable name on the messaging_groups row on first boot.
      config.onMetadata(opts.platformId, 'Web Chat', false);
    },

    async teardown(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      log.info('Webchat channel stopped');
    },

    isConnected(): boolean {
      return server?.listening ?? false;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== opts.platformId) {
        log.warn('Webchat deliver called with unknown platformId', { platformId });
        return undefined;
      }
      const text = extractText(message.content);
      if (!text) return undefined;

      const id = `webchat-out-${Date.now()}`;
      outboundBuffer.push({ text, timestamp: Date.now() });
      while (outboundBuffer.length > OUTBOUND_BUFFER_MAX) outboundBuffer.shift();
      return id;
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as { text?: unknown };
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

/**
 * The chat UI. One inline page, no external assets (survives tsc: it lives
 * in the module, not beside it). Deliberately backtick- and `${}`-free so it
 * can sit inside this template literal without escaping games.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw</title>
<style>
  :root { color-scheme: light dark;
    --bg: #f5f5f4; --fg: #1c1917; --card: #ffffff; --accent: #b45309; --muted: #78716c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1917; --fg: #e7e5e4; --card: #292524; --accent: #f59e0b; --muted: #a8a29e; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; height: 100dvh; }
  header { padding: 10px 16px; border-bottom: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
    display: flex; align-items: baseline; gap: 10px; }
  header h1 { font-size: 15px; font-weight: 600; }
  header span { font-size: 12px; color: var(--muted); }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 72%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-wrap: break-word; }
  .you { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
  .claw { align-self: flex-start; background: var(--card); border-bottom-left-radius: 4px;
    box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .sys { align-self: center; color: var(--muted); font-size: 12px; }
  form { display: flex; gap: 8px; padding: 12px 16px;
    border-top: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); }
  textarea { flex: 1; resize: none; border: 1px solid color-mix(in srgb, var(--fg) 18%, transparent);
    border-radius: 10px; padding: 9px 12px; font: inherit; background: var(--card); color: var(--fg);
    max-height: 40dvh; }
  textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { border: 0; border-radius: 10px; padding: 0 18px; background: var(--accent); color: #fff;
    font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<header><h1>NanoClaw</h1><span id="status">connecting…</span></header>
<div id="log"></div>
<form id="composer">
  <textarea id="input" rows="1" placeholder="Message… (Enter to send, Shift+Enter for newline)" autofocus></textarea>
  <button id="send" type="submit">Send</button>
</form>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('token');
  var log = document.getElementById('log');
  var input = document.getElementById('input');
  var form = document.getElementById('composer');
  var status = document.getElementById('status');
  var since = Date.now();
  var pending = null;

  function headers(json) {
    var h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function add(cls, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function setPending() {
    if (!pending) pending = add('sys', 'thinking…');
  }
  function clearPending() {
    if (pending) { pending.remove(); pending = null; }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    add('you', text);
    setPending();
    fetch('/api/message', { method: 'POST', headers: headers(true), body: JSON.stringify({ text: text }) })
      .then(function (r) {
        if (r.status === 401) { clearPending(); add('sys', 'unauthorized — reopen the page with ?token=<your token>'); }
      })
      .catch(function () { clearPending(); add('sys', 'send failed — is the service running?'); });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  function poll() {
    fetch('/api/messages?since=' + since, { headers: headers(false) })
      .then(function (r) {
        if (r.status === 401) { status.textContent = 'unauthorized'; return null; }
        status.textContent = 'connected';
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.messages) return;
        data.messages.forEach(function (m) {
          clearPending();
          add('claw', m.text);
          if (m.timestamp > since) since = m.timestamp;
        });
      })
      .catch(function () { status.textContent = 'disconnected'; });
  }
  setInterval(poll, 1000);
  poll();
})();
</script>
</body>
</html>
`;

registerChannelAdapter('webchat', {
  factory: () => {
    const env = readEnvFile(['WEBCHAT_ENABLED', 'WEBCHAT_CHANNEL_PORT', 'WEBCHAT_AUTH_TOKEN', 'WEBCHAT_PLATFORM_ID']);
    const enabled = process.env.WEBCHAT_ENABLED || env.WEBCHAT_ENABLED;
    if (!enabled || enabled === 'false') return null;

    const portStr = process.env.WEBCHAT_CHANNEL_PORT || env.WEBCHAT_CHANNEL_PORT || '8767';
    const port = parseInt(portStr, 10);
    const authToken = process.env.WEBCHAT_AUTH_TOKEN || env.WEBCHAT_AUTH_TOKEN || null;
    const platformId = process.env.WEBCHAT_PLATFORM_ID || env.WEBCHAT_PLATFORM_ID || 'default';

    return createWebchatAdapter({ port, authToken, platformId });
  },
  defaults: WEBCHAT_DEFAULTS,
});

export { createWebchatAdapter };
