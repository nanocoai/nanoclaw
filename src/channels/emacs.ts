/**
 * Emacs channel adapter (v2) — native HTTP bridge.
 *
 * Stands up a localhost HTTP server that the nanoclaw.el client talks to:
 *  - POST /api/message — user typed a message in Emacs; fire onInbound
 *  - GET  /api/messages?since=<ms> — Emacs polls for agent replies
 *
 * Single-user, single-chat: one adapter instance = one messaging group with
 * `platform_id = "default"` (override with EMACS_PLATFORM_ID). No threads,
 * no cold DM. Self-registers on import.
 */
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const OUTBOUND_BUFFER_MAX = 200;

/**
 * Single-operator localhost transport, wired manually: every line is for the
 * agent, senders are whoever can reach the local port ('strict' keeps
 * auto-create off), no thread or mention concept.
 */
const EMACS_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};

interface BufferedMessage {
  text: string;
  timestamp: number;
}

interface EmacsAdapterOptions {
  port: number;
  authToken: string | null;
  platformId: string;
}

function createEmacsAdapter(opts: EmacsAdapterOptions): ChannelAdapter {
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
      const id = `emacs-${Date.now()}`;

      const inbound: InboundMessage = {
        id,
        kind: 'chat',
        content: {
          text,
          sender: 'Emacs',
          senderId: `emacs:${opts.platformId}`,
        },
        timestamp,
      };

      try {
        setupConfig?.onInbound(opts.platformId, null, inbound);
      } catch (err) {
        log.error('Emacs onInbound failed', { err });
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

  return {
    name: 'emacs',
    channelType: 'emacs',
    supportsThreads: false,
    defaults: EMACS_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      server = http.createServer((req, res) => {
        if (!checkAuth(req, res)) return;

        const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
        if (req.method === 'POST' && url.pathname === '/api/message') {
          handlePost(req, res);
        } else if (req.method === 'GET' && url.pathname === '/api/messages') {
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
          log.info('Emacs channel listening', { port: opts.port, platformId: opts.platformId });
          resolve();
        });
      });

      // Stamp a human-readable name on the messaging_groups row on first boot.
      config.onMetadata(opts.platformId, 'Emacs', false);
    },

    async teardown(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      log.info('Emacs channel stopped');
    },

    isConnected(): boolean {
      return server?.listening ?? false;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== opts.platformId) {
        log.warn('Emacs deliver called with unknown platformId', { platformId });
        return undefined;
      }
      const text = extractText(message.content);
      if (!text) return undefined;

      const id = `emacs-out-${Date.now()}`;
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

registerChannelAdapter('emacs', {
  factory: () => {
    const env = readEnvFile(['EMACS_ENABLED', 'EMACS_CHANNEL_PORT', 'EMACS_AUTH_TOKEN', 'EMACS_PLATFORM_ID']);
    const enabled = process.env.EMACS_ENABLED || env.EMACS_ENABLED;
    if (!enabled || enabled === 'false') return null;

    const portStr = process.env.EMACS_CHANNEL_PORT || env.EMACS_CHANNEL_PORT || '8766';
    const port = parseInt(portStr, 10);
    const authToken = process.env.EMACS_AUTH_TOKEN || env.EMACS_AUTH_TOKEN || null;
    const platformId = process.env.EMACS_PLATFORM_ID || env.EMACS_PLATFORM_ID || 'default';

    return createEmacsAdapter({ port, authToken, platformId });
  },
  defaults: EMACS_DEFAULTS,
});

export { createEmacsAdapter };
