/**
 * LINE Official Account (Messaging API) channel — native adapter.
 *
 * Why native (not a Chat SDK bridge): there is no `@chat-adapter/line` package,
 * so this adapter talks to the LINE Messaging API directly. Zero new npm
 * dependencies — node `http`/`crypto` plus global `fetch`.
 *
 * Inbound  — LINE POSTs webhook events to `/webhook/line` (LINE has no polling
 *            mode; a public HTTPS endpoint is required — see the /add-line
 *            skill). We register a raw handler on the shared webhook server,
 *            verify `x-line-signature` (HMAC-SHA256 over the raw body), ACK
 *            fast, then route each message event through `onInbound`.
 * Outbound — host delivery is asynchronous (it polls outbound.db well after the
 *            event arrived), by which time LINE reply tokens (~1 min TTL,
 *            single-use) are stale. So `deliver()` always uses the PUSH
 *            endpoint, never reply. Push counts against the Official Account
 *            plan's monthly message quota; reply would be free but is
 *            architecturally unusable here.
 *
 * Credentials come from LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN
 * (process env or .env). The factory returns null when either is missing, so
 * the host boots cleanly on an install that hasn't wired LINE yet.
 */
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { registerWebhookHandler } from '../webhook-server.js';
import { verifyLineSignatureResult } from './line-signature.js';

const CHANNEL_TYPE = 'line';
const WEBHOOK_PATH = 'line'; // → /webhook/line
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_TEXT_LIMIT = 5000; // LINE caps a single text message at 5000 chars

interface LineSource {
  type?: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineEventMessage {
  type?: string; // 'text' | 'image' | 'file' | 'video' | 'audio' | 'location' | ...
  id?: string;
  text?: string;
  fileName?: string;
  mention?: { mentionees?: { isSelf?: boolean }[] };
}

interface LineWebhookEvent {
  type?: string; // 'message' | 'follow' | 'unfollow' | 'join' | ...
  message?: LineEventMessage;
  source?: LineSource;
  replyToken?: string;
  timestamp?: number;
}

/** The conversation id LINE addresses: groupId / roomId for group chats, else the userId. */
function destinationId(source?: LineSource): string | null {
  if (!source) return null;
  if (source.type === 'group') return source.groupId ?? null;
  if (source.type === 'room') return source.roomId ?? null;
  return source.userId ?? null;
}

/** Read the raw request body off the Node stream (needed verbatim for signature checks). */
function readRawBody(req: import('http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

/** Split a long body into LINE-sized chunks (one push carries up to 5 messages). */
function chunkText(text: string, size = LINE_TEXT_LIMIT): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.slice(0, 5); // LINE rejects > 5 messages per push; truncate defensively
}

function createAdapter(channelSecret: string, accessToken: string): ChannelAdapter {
  let live = false;

  const adapter: ChannelAdapter = {
    name: 'line',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      registerWebhookHandler(WEBHOOK_PATH, async (req, res) => {
        // GET (health probes) — answer 200 without a body.
        if ((req.method ?? 'GET').toUpperCase() === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
          return;
        }

        const raw = await readRawBody(req);
        const signature = req.headers['x-line-signature'];
        const sigHeader = Array.isArray(signature) ? signature[0] : signature;
        const verdict = verifyLineSignatureResult(raw, channelSecret, sigHeader);
        if (verdict !== 'ok') {
          log.warn('LINE webhook signature rejected', { reason: verdict });
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('invalid signature');
          return;
        }

        // ACK fast — LINE expects a prompt 200; do the routing work afterwards.
        // This also covers the console's "Verify" button, which sends a signed
        // POST with an empty `events` array (not a GET).
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');

        let payload: { events?: LineWebhookEvent[] };
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch (err) {
          log.warn('LINE webhook: body is not JSON', { err });
          return;
        }

        for (const ev of payload.events ?? []) {
          if (ev.type !== 'message' || !ev.message) continue;
          const platformId = destinationId(ev.source);
          if (!platformId) continue;

          const userId = ev.source?.userId;
          const senderId = userId ? `${CHANNEL_TYPE}:${userId}` : `${CHANNEL_TYPE}:unknown`;
          const isGroup = ev.source?.type === 'group' || ev.source?.type === 'room';
          // DMs are by definition addressed to the bot (the router's
          // auto-create and 'mention' trigger mode both key off isMention —
          // without it a first DM is silently dropped). In group/room chats
          // only an explicit @mention of the bot counts, which LINE reports
          // via message.mention.mentionees[].isSelf.
          const isMention = !isGroup || (ev.message.mention?.mentionees?.some((m) => m.isSelf === true) ?? false);

          let text: string;
          if (ev.message.type === 'text' && typeof ev.message.text === 'string') {
            text = ev.message.text;
          } else {
            // Media (image/file/video/audio/...) carries no text. Surface a
            // typed placeholder including the message id, which is exactly
            // what a later media integration needs to fetch the binary from
            // LINE's content endpoint (api-data.line.me). Content download is
            // deliberately out of scope here — text intake is the core.
            const kind = ev.message.type ?? 'unknown';
            const name = ev.message.fileName ? ` (${ev.message.fileName})` : '';
            text = `[attachment:${kind}${name}] message_id=${ev.message.id ?? ''}`;
          }

          try {
            await config.onInbound(platformId, null, {
              id: `line-${ev.message.id ?? ev.timestamp ?? ''}`,
              kind: 'chat',
              timestamp: new Date(ev.timestamp ?? Date.now()).toISOString(),
              content: { text, sender: userId ?? 'line', senderId },
              isMention,
              isGroup,
            });
          } catch (err) {
            log.error('LINE webhook: onInbound threw', { err });
          }
        }
      });

      live = true;
      log.info('LINE channel ready', { path: `/webhook/${WEBHOOK_PATH}` });
    },

    async teardown(): Promise<void> {
      // The shared webhook server owns route lifecycle (cleared by
      // stopWebhookServer on host shutdown). There is no single-route
      // unregister, so teardown just marks the adapter offline.
      live = false;
    },

    isConnected(): boolean {
      return live;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message);
      if (text === null || text.length === 0) return undefined;

      const messages = chunkText(text).map((t) => ({ type: 'text', text: t }));
      try {
        const res = await fetch(PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ to: platformId, messages }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          log.warn('LINE push failed', { status: res.status, detail: detail.slice(0, 500) });
          return undefined;
        }
        // LINE echoes the ids of the sent messages — surface the first so
        // delivery records a platformMsgId (parity with bridge channels).
        const body = (await res.json().catch(() => null)) as { sentMessages?: { id?: string }[] } | null;
        return body?.sentMessages?.[0]?.id;
      } catch (err) {
        log.warn('LINE push threw', { err });
      }
      return undefined;
    },
  };

  return adapter;
}

/** Factory: only activates when both LINE credentials are present (process env or .env). */
function createAdapterOrNull(): ChannelAdapter | null {
  const env = readEnvFile(['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN']);
  const channelSecret = process.env.LINE_CHANNEL_SECRET || env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret || !accessToken) return null;
  return createAdapter(channelSecret, accessToken);
}

registerChannelAdapter('line', { factory: createAdapterOrNull });
