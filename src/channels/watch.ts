import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  GROUPS_DIR,
  STORE_DIR,
  WATCH_AUTH_TOKEN,
  WATCH_FIRMWARE_DIR,
  WATCH_GROUP_FOLDER,
  WATCH_HTTP_BIND,
  WATCH_HTTP_PORT,
  WATCH_JID,
  WATCH_SIGNAL_MIRROR_JID,
  WATCH_SYNC_TIMEOUT_MS,
} from '../config.js';
import { log } from '../log.js';
import { transcribeAudio } from '../transcription.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { getChannelAdapter, registerChannelAdapter } from './channel-registry.js';

const WATCH_UPLOADS_DIR = path.join(STORE_DIR, 'watch-uploads');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const POLL_QUEUE_MAX = 20;
const NOTIF_QUEUE_MAX = 50;
const NOTIF_PREVIEW_LEN = 60;
const NOTIF_MAX_AGE_MS = 3600_000;

interface PendingResolver {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedReply {
  ts: number;
  text: string;
}

export interface WatchNotification {
  id: string;
  type: 'email' | 'signal';
  from: string;
  preview: string;
  full_text: string;
  timestamp: string;
}

function normalizeForWatch(text: string): string {
  return text
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/\u2192/g, '->')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function createWatchAdapter(): ChannelAdapter | null {
  if (!WATCH_AUTH_TOKEN) return null;

  let config: ChannelSetup;
  let server: http.Server | undefined;
  let pendingResolvers: PendingResolver[] = [];
  let pollQueue: QueuedReply[] = [];
  let notificationQueue: WatchNotification[] = [];

  function mirrorToSignal(text: string): void {
    if (!WATCH_SIGNAL_MIRROR_JID) return;
    const signalAdapter = getChannelAdapter('signal');
    if (!signalAdapter) return;
    const platformId = WATCH_SIGNAL_MIRROR_JID.replace(/^signal:/, '');
    signalAdapter
      .deliver(platformId, null, {
        kind: 'text',
        content: { text },
      })
      .catch((err) => log.warn('watch: signal mirror send failed', { err }));
  }

  function checkAuth(req: http.IncomingMessage): boolean {
    const provided = req.headers['x-watch-token'];
    if (typeof provided !== 'string' || !WATCH_AUTH_TOKEN) return false;
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(WATCH_AUTH_TOKEN, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    const buf = Buffer.from(JSON.stringify(body), 'utf-8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(buf.length),
      Connection: 'close',
    });
    res.end(buf);
  }

  async function transcribeWav(body: Buffer): Promise<string> {
    const fname = `watch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`;
    const fpath = path.join(WATCH_UPLOADS_DIR, fname);
    fs.writeFileSync(fpath, body);
    try {
      return (await transcribeAudio(fpath)).trim();
    } catch (err) {
      log.warn('watch: transcription failed', { err });
      return '';
    } finally {
      fs.unlink(fpath, () => {});
    }
  }

  async function transcribeAndClean(body: Buffer): Promise<string> {
    const transcribed = await transcribeWav(body);
    if (!transcribed) return '';
    return transcribed
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function injectAndAwaitReply(text: string, deviceId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        const idx = pendingResolvers.findIndex((r) => r.resolve === wrappedResolve);
        if (idx >= 0) pendingResolvers.splice(idx, 1);
        log.info('watch: sync reply timeout — reply will go through poll queue', { textLen: text.length });
        resolve('');
      }, WATCH_SYNC_TIMEOUT_MS);

      const wrappedResolve = (replyText: string) => {
        clearTimeout(timer);
        resolve(replyText);
      };
      pendingResolvers.push({ resolve: wrappedResolve, timer });

      const now = new Date();
      const inbound: InboundMessage = {
        id: `watch-${now.getTime()}-${crypto.randomBytes(4).toString('hex')}`,
        kind: 'chat',
        content: {
          text,
          sender: WATCH_JID,
          senderId: `watch:${deviceId}`,
          senderName: 'Scott (watch)',
        },
        timestamp: now.toISOString(),
      };
      config.onMetadata(WATCH_JID, `NanoClaw Watch (${deviceId})`, false);
      void config.onInbound(WATCH_JID, null, inbound);
    });
  }

  async function handleMessagePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const deviceId = (req.headers['x-device-id'] as string | undefined) || 'unknown';

    let text: string;
    try {
      if (ct.includes('application/json')) {
        const body = await readBody(req);
        const parsed = JSON.parse(body.toString('utf-8')) as { text?: unknown };
        if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
          sendJson(res, 400, { error: 'missing text field' });
          return;
        }
        text = parsed.text.trim();
      } else if (ct.includes('audio/')) {
        const body = await readBody(req);
        if (body.length === 0) {
          sendJson(res, 400, { error: 'empty audio body' });
          return;
        }
        const cleaned = await transcribeAndClean(body);
        if (!cleaned) {
          sendJson(res, 200, { reply: '(no speech detected)' });
          return;
        }
        text = cleaned;
      } else {
        sendJson(res, 415, { error: `unsupported Content-Type: ${ct}` });
        return;
      }
    } catch (err) {
      log.warn('watch: bad inbound body', { err, ct });
      if (!res.headersSent) sendJson(res, 400, { error: 'bad request' });
      return;
    }

    log.info('watch: inbound message', { deviceId, textLen: text.length, preview: text.slice(0, 100) });
    mirrorToSignal(`⌚ [Watch] Scott: ${text}`);
    const reply = await injectAndAwaitReply(text, deviceId);
    sendJson(res, 200, { reply });
  }

  async function handleMemoPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('audio/')) {
        sendJson(res, 415, { error: `unsupported Content-Type: ${ct}` });
        return;
      }
      const body = await readBody(req);
      if (body.length === 0) {
        sendJson(res, 400, { error: 'empty audio body' });
        return;
      }
      const cleaned = await transcribeAndClean(body);
      if (!cleaned) {
        sendJson(res, 200, { reply: '(no speech detected)' });
        return;
      }

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      const memosDir = path.join(GROUPS_DIR, WATCH_GROUP_FOLDER, 'memos');
      fs.mkdirSync(memosDir, { recursive: true });
      const memoFile = path.join(memosDir, `${dateStr}.md`);
      if (!fs.existsSync(memoFile)) fs.writeFileSync(memoFile, `# Memos — ${dateStr}\n\n`);
      fs.appendFileSync(memoFile, `## ${timeStr}\n\n${cleaned}\n\n`);

      log.info('watch: memo saved', { file: memoFile, len: cleaned.length });
      mirrorToSignal(`[Memo] ${cleaned}`);
      sendJson(res, 200, { reply: `Saved (${cleaned.length} chars)\n\n${cleaned}` });
    } catch (err) {
      log.warn('watch: memo error', { err });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    }
  }

  async function handleReminderPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('audio/')) {
        sendJson(res, 415, { error: `unsupported Content-Type: ${ct}` });
        return;
      }
      const body = await readBody(req);
      if (body.length === 0) {
        sendJson(res, 400, { error: 'empty audio body' });
        return;
      }
      const cleaned = await transcribeAndClean(body);
      if (!cleaned) {
        sendJson(res, 200, { reply: '(no speech detected)' });
        return;
      }

      const deviceId = (req.headers['x-device-id'] as string | undefined) || 'unknown';
      log.info('watch: reminder request — routing to agent', { deviceId, preview: cleaned.slice(0, 100) });
      mirrorToSignal(`⌚ [Watch reminder] Scott: ${cleaned}`);

      const framed =
        `SYSTEM: Scott tapped the 'Remind' tile on his watch and said: ` +
        `"${cleaned}". Parse the time from his statement and schedule a ` +
        `one-shot task for that exact time using the schedule_task tool ` +
        `with schedule_type "once". The scheduled task's prompt should ` +
        `send Scott a Signal reminder of the action. Reply with only a ` +
        `short confirmation, e.g. "Reminder set for 3:45 PM: call Mom".`;

      const reply = await injectAndAwaitReply(framed, deviceId);
      sendJson(res, 200, { reply });
    } catch (err) {
      log.warn('watch: reminder error', { err });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    }
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!checkAuth(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/watch/notify') {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body.toString('utf-8')) as { type?: string; from?: string; text?: string };
        const type = (parsed.type === 'email' ? 'email' : 'signal') as 'email' | 'signal';
        const from = parsed.from || 'System';
        const text = parsed.text || '';
        if (!text) {
          sendJson(res, 400, { error: 'missing text field' });
          return;
        }
        addNotification(type, from, text);
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/watch/message') {
      await handleMessagePost(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/watch/memo') {
      await handleMemoPost(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/watch/reminder') {
      await handleReminderPost(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/poll') {
      const next = pollQueue.shift();
      sendJson(res, 200, next ? { has_new: true, reply: next.text } : { has_new: false });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/notifications') {
      const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
      const sinceMs = new Date(since).getTime();
      sendJson(res, 200, { notifications: notificationQueue.filter((n) => new Date(n.timestamp).getTime() > sinceMs) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/version') {
      const versionFile = path.join(WATCH_FIRMWARE_DIR, 'version.json');
      try {
        const data = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 200, { version: 0, note: 'no firmware published' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/firmware') {
      const binFile = path.join(WATCH_FIRMWARE_DIR, 'firmware.bin');
      if (!fs.existsSync(binFile)) {
        sendJson(res, 404, { error: 'no firmware available' });
        return;
      }
      const stat = fs.statSync(binFile);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        Connection: 'close',
      });
      fs.createReadStream(binFile).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function addNotification(type: 'email' | 'signal', from: string, fullText: string): void {
    const normalized = normalizeForWatch(fullText);
    const preview =
      normalized.length > NOTIF_PREVIEW_LEN ? normalized.slice(0, NOTIF_PREVIEW_LEN - 3) + '...' : normalized;
    notificationQueue.push({
      id: `notif-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      type,
      from: normalizeForWatch(from),
      preview,
      full_text: normalized.slice(0, 1024),
      timestamp: new Date().toISOString(),
    });
    const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
    notificationQueue = notificationQueue.filter((n) => new Date(n.timestamp).getTime() > cutoff);
    while (notificationQueue.length > NOTIF_QUEUE_MAX) notificationQueue.shift();
  }

  const adapter: ChannelAdapter = {
    name: 'Watch',
    channelType: 'watch',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      config = cfg;
      fs.mkdirSync(WATCH_UPLOADS_DIR, { recursive: true });

      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          log.error('watch: unhandled HTTP handler error', { err });
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
        });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server?.removeListener('error', onError);
          reject(err);
        };
        server!.once('error', onError);
        server!.listen(WATCH_HTTP_PORT, WATCH_HTTP_BIND, () => {
          server!.removeListener('error', onError);
          log.info('watch: HTTP server listening', { port: WATCH_HTTP_PORT, bind: WATCH_HTTP_BIND });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const r of pendingResolvers) {
        clearTimeout(r.timer);
        r.resolve('');
      }
      pendingResolvers = [];
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    },

    isConnected(): boolean {
      return !!server?.listening;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== WATCH_JID) return undefined;

      const content = message.content as Record<string, unknown> | string | undefined;
      let text: string | undefined;
      if (typeof content === 'string') text = content;
      else if (content && typeof content.text === 'string') text = content.text;
      if (!text) return undefined;

      // Mirror full Unicode text to Signal before normalizing for watch LCD
      mirrorToSignal(`↳ ${text}`);
      text = normalizeForWatch(text);

      // Fast path: fulfill oldest pending sync request
      const resolver = pendingResolvers.shift();
      if (resolver) {
        clearTimeout(resolver.timer);
        log.info('watch: reply delivered via fast path', { textLen: text.length });
        resolver.resolve(text);
        return `watch-${Date.now()}`;
      }

      // Slow path: queue for poll endpoint
      pollQueue.push({ ts: Date.now(), text });
      while (pollQueue.length > POLL_QUEUE_MAX) pollQueue.shift();
      log.info('watch: reply queued for poll endpoint', { textLen: text.length, queueSize: pollQueue.length });
      return `watch-${Date.now()}`;
    },
  };

  // Expose addNotification for external callers (e.g. Signal mirror hook in index.ts)
  (adapter as ChannelAdapter & { addNotification: typeof addNotification }).addNotification = addNotification;

  return adapter;
}

const registration: ChannelRegistration = {
  factory: createWatchAdapter,
  containerConfig: {
    mounts: [
      {
        hostPath: path.join(STORE_DIR, 'watch-uploads'),
        containerPath: '/workspace/watch-uploads',
        readonly: false,
      },
    ],
  },
};

registerChannelAdapter('watch', registration);
