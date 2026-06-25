/**
 * WhatsApp channel adapter (v2) — native Baileys v7 implementation.
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge) using
 * @whiskeysockets/baileys 7.0.0-rc.9 (pinned — last release, unmaintained).
 * Ports proven v1 infrastructure: getMessage fallback, outgoing queue,
 * group metadata cache, LID mapping, reconnection with backoff.
 *
 * LID handling: Baileys v7 provides participantAlt / remoteJidAlt on every
 * inbound message via extractAddressingContext, plus a real
 * signalRepository.lidMapping.getPNForLID API. The adapter always resolves
 * to phone JID (@s.whatsapp.net) before emitting to the router.
 *
 * Auth credentials persist in store/auth/. On first run:
 * - If WHATSAPP_PHONE_NUMBER is set → pairing code (printed to log)
 * - Otherwise → QR code (printed to log)
 * Subsequent restarts reuse the saved session automatically.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's .d.ts under NodeNext resolution
// exports `{ pino as default, pino }`, but the namespace/function merge at
// `declare namespace pino` + `declare function pino` makes the default
// resolve to `typeof pino` (the namespace type), which isn't callable.
// The named export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  proto,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, WAMessageKey, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';

const baileysLogger = pino({ level: 'silent' });

/**
 * Fetch the latest WhatsApp Web version. Baileys' built-in
 * fetchLatestWaWebVersion scrapes sw.js which is aggressively
 * rate-limited (429). When it fails, Baileys falls back to a
 * hardcoded version that goes stale within weeks — WhatsApp
 * rejects connections with an expired buildHash (405 at Noise
 * layer). This fetches from wppconnect's version tracker as a
 * more reliable source, with Baileys' own fetch as fallback.
 */
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  // 1. Try wppconnect version tracker (HTML scrape — no JSON API)
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) {
        const version: [number, number, number] = [2, 3000, Number(match[1])];
        log.info('Fetched WA Web version from wppconnect', { version });
        return version;
      }
    }
  } catch {
    // Fall through to Baileys' own fetch
  }

  // 2. Try Baileys' built-in fetch (scrapes sw.js — often 429'd)
  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version) {
      log.info('Fetched WA Web version from Baileys', { version });
      return version as [number, number, number];
    }
  } catch {
    // Fall through
  }

  throw new Error(
    'Could not fetch current WhatsApp Web version from any source. ' +
      'Baileys hardcodes a stale version that WhatsApp rejects (405). ' +
      'Check network connectivity to wppconnect.io and web.whatsapp.com.',
  );
}

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 256;
const RECONNECT_DELAY_MS = 5000;
const PENDING_QUESTIONS_MAX = 64;

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

// --- Markdown → WhatsApp formatting ---

interface TextSegment {
  content: string;
  isProtected: boolean;
}

/** Split text into code-block-protected and unprotected regions. */
function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

/** Apply WhatsApp-native formatting to an unprotected text segment. */
function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  // 1. Italic: *text* (not **) → _text_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  // 2. Bold: **text** → *text*
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  // 3. Headings: ## Title → *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 5. Horizontal rules: --- / *** / ___ → stripped
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

// WhatsApp tags `@<phone-digits>` (5–15 digit local part — covers short test
// numbers up to ITU E.164 max). A leading `+` is accepted but stripped so
// the literal in text matches the digits in the JID — WhatsApp clients
// scan the rendered text for `@<digits>` and cross-reference it with the
// contextInfo.mentionedJid list to draw the bold/clickable tag.
const MENTION_RE = /(^|[^\w@+])@\+?(\d{5,15})(?!\d)/g;

/** Extract `@<digits>` mentions from text and normalize them. */
export function parseWhatsAppMentions(text: string): { text: string; mentions: string[] } {
  const mentions = new Set<string>();
  const out = text.replace(MENTION_RE, (_full, lead: string, digits: string) => {
    mentions.add(`${digits}@s.whatsapp.net`);
    return `${lead}@${digits}`;
  });
  return { text: out, mentions: [...mentions] };
}

/**
 * Convert Claude's markdown to WhatsApp-native formatting and extract any
 * `@<phone>` mentions. Code-block regions are passed through untouched so
 * phone-like sequences inside code aren't tagged.
 */
function formatWhatsApp(text: string): { text: string; mentions: string[] } {
  const segments = splitProtectedRegions(text);
  const mentions = new Set<string>();
  const out = segments
    .map(({ content, isProtected }) => {
      if (isProtected) return content;
      const transformed = transformForWhatsApp(content);
      const { text: withMentions, mentions: found } = parseWhatsAppMentions(transformed);
      for (const m of found) mentions.add(m);
      return withMentions;
    })
    .join('');
  return { text: out, mentions: [...mentions] };
}

/**
 * Subset of a normalized Baileys message content carrying the message
 * types that can host a `contextInfo.mentionedJid` array. Kept as a
 * structural type so the helper (and its tests) don't pull in the full
 * `proto.IMessage` shape just to construct fixtures.
 */
type MentionContextSource = {
  extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  imageMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  videoMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
  documentMessage?: { contextInfo?: { mentionedJid?: string[] | null } | null } | null;
};

/**
 * Detect an explicit @-mention of the bot in a WhatsApp group message.
 * WhatsApp carries mentions in `contextInfo.mentionedJid` on the text +
 * caption-bearing message types. Matches against both the bot's phone
 * JID and LID — most modern clients emit the LID even when the human
 * typed a phone-number mention.
 *
 * Exported for unit testing. The inbound construction site calls this
 * to set `InboundMessage.isMention` for group messages (#2560). DMs are
 * unconditionally mentions and don't go through this helper.
 */
export function isBotMentionedInGroup(
  normalized: MentionContextSource,
  botPhoneJid: string | undefined,
  botLidUser: string | undefined,
): boolean {
  if (!botPhoneJid && !botLidUser) return false;
  const mentionedJids: string[] = [
    ...(normalized.extendedTextMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.imageMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.videoMessage?.contextInfo?.mentionedJid ?? []),
    ...(normalized.documentMessage?.contextInfo?.mentionedJid ?? []),
  ];
  const botLidJid = botLidUser ? `${botLidUser}@lid` : undefined;
  return mentionedJids.some((jid) => {
    if (!jid) return false;
    const bare = jid.split(':')[0];
    return bare === botPhoneJid || bare === botLidJid;
  });
}

/**
 * Compute `InboundMessage.isMention` for a WhatsApp message:
 *   - DMs are always mentions (router auto-engages on the bot's behalf).
 *   - Group messages are mentions only when the bot is explicitly tagged.
 *
 * Returns `true | undefined` rather than `true | false` because the
 * `InboundMessage` field is `isMention?: boolean` and downstream code
 * treats `undefined` differently than an explicit `false` (#2560).
 */
export function computeIsMention(isGroup: boolean, botMentionedInGroup: boolean): true | undefined {
  if (!isGroup) return true;
  return botMentionedInGroup ? true : undefined;
}

/** Map file extension to Baileys media message type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus'];

  if (imageExts.includes(ext)) {
    return { image: data, caption, mimetype: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  if (videoExts.includes(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (audioExts.includes(ext)) {
    return { audio: data, mimetype: `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}` };
  }
  // Default: send as document
  return { document: data, fileName: filename, caption, mimetype: 'application/octet-stream' };
}

registerChannelAdapter('whatsapp', {
  factory: () => {
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_ENABLED']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;
    const authDir = AUTH_DIR;

    // Skip if no existing auth, no phone number for pairing, and not explicitly enabled (QR mode)
    const hasAuth = fs.existsSync(path.join(authDir, 'creds.json'));
    if (!hasAuth && !phoneNumber && !env.WHATSAPP_ENABLED) return null;

    fs.mkdirSync(authDir, { recursive: true });

    // State
    let sock: WASocket;
    let connected = false;
    let shuttingDown = false;
    let setupConfig: ChannelSetup;

    // LID → phone JID mapping (WhatsApp's new ID system)
    const lidToPhoneMap: Record<string, string> = {};
    let botLidUser: string | undefined;
    let botPhoneJid: string | undefined;

    // Outgoing queue for messages sent while disconnected
    const outgoingQueue: Array<{ jid: string; text: string; mentions?: string[] }> = [];
    let flushing = false;

    // Sent message cache for retry/re-encrypt requests
    const sentMessageCache = new Map<string, any>();

    // Group metadata cache with TTL
    const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();

    // Pending questions: chatJid → { questionId, options }
    // User replies with /approve, /reject, etc. to answer
    const pendingQuestions = new Map<
      string,
      {
        questionId: string;
        options: NormalizedOption[];
      }
    >();

    // Group sync tracking
    let lastGroupSync = 0;
    let groupSyncTimerStarted = false;

    // First-connect promise
    let resolveFirstOpen: (() => void) | undefined;
    let rejectFirstOpen: ((err: Error) => void) | undefined;

    // Pairing code file for the setup skill to poll
    const pairingCodeFile = path.join(process.cwd(), 'store', 'pairing-code.txt');

    // --- Helpers ---

    function setLidPhoneMapping(lidUser: string, phoneJid: string): void {
      if (lidToPhoneMap[lidUser] === phoneJid) return;
      lidToPhoneMap[lidUser] = phoneJid;
      // Cached group metadata depends on participant IDs — invalidate
      groupMetadataCache.clear();
    }

    async function translateJid(jid: string, altJid?: string): Promise<string> {
      if (!jid.endsWith('@lid')) return jid;
      const lidUser = jid.split('@')[0].split(':')[0];

      // 1. Check local cache
      const cached = lidToPhoneMap[lidUser];
      if (cached) return cached;

      // 2. Use the alt JID from extractAddressingContext (v7 provides this
      //    on every inbound message as remoteJidAlt / participantAlt)
      if (altJid && !altJid.endsWith('@lid')) {
        const phoneJid = altJid.includes('@') ? altJid : `${altJid}@s.whatsapp.net`;
        setLidPhoneMapping(lidUser, phoneJid);
        log.info('Translated LID via alt JID', { lidJid: jid, phoneJid });
        return phoneJid;
      }

      // 3. Query Baileys v7 LID mapping store
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) {
          const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
          log.info('Translated LID via signal repository', { lidJid: jid, phoneJid });
          return phoneJid;
        }
      } catch (err) {
        log.debug('Failed to resolve LID via signalRepository', { jid, err });
      }

      return jid;
    }

    async function getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
      if (!jid.endsWith('@g.us')) return undefined;

      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.metadata;

      const metadata = await sock.groupMetadata(jid);
      const participants = await Promise.all(
        metadata.participants.map(async (p) => ({
          ...p,
          id: await translateJid(p.id),
        })),
      );
      const normalized = { ...metadata, participants };
      groupMetadataCache.set(jid, {
        metadata: normalized,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return normalized;
    }

    async function syncGroupMetadata(force = false): Promise<void> {
      if (!force && lastGroupSync && Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
        return;
      }
      try {
        log.info('Syncing group metadata from WhatsApp...');
        const groups = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          if (metadata.subject) {
            setupConfig.onMetadata(jid, metadata.subject, true);
            count++;
          }
        }
        lastGroupSync = Date.now();
        log.info('Group metadata synced', { count });
      } catch (err) {
        log.error('Failed to sync group metadata', { err });
      }
    }

    async function flushOutgoingQueue(): Promise<void> {
      if (flushing || outgoingQueue.length === 0) return;
      flushing = true;
      try {
        log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
        while (outgoingQueue.length > 0) {
          const item = outgoingQueue.shift()!;
          const payload: { text: string; mentions?: string[] } = { text: item.text };
          if (item.mentions && item.mentions.length > 0) payload.mentions = item.mentions;
          const sent = await sock.sendMessage(item.jid, payload);
          if (sent?.key?.id && sent.message) {
            sentMessageCache.set(sent.key.id, sent.message);
          }
        }
      } finally {
        flushing = false;
      }
    }

    /**
     * Download inbound media as base64 `data` on each attachment object. The
     * host's session-manager.extractAttachmentFiles stages every entry into
     * <sessionDir>/inbox/<msgId>/<filename>, reachable in the container at
     * /workspace/inbox/<msgId>/<filename>. Routing the bytes through the
     * shared extractor keeps WhatsApp on the same code path as chat-sdk
     * channels and inherits its path-traversal hardening for filenames.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function downloadInboundMedia(
      msg: WAMessage,
      normalized: any,
    ): Promise<
      Array<{
        type: string;
        name: string;
        mimeType: string | undefined;
        size: number;
        data: string;
      }>
    > {
      // Non-document WhatsApp media (image/video/audio) usually has no
      // fileName, so we must supply a typed extension. Without it, the
      // shared extractor falls back to a generic extensionless
      // `attachment-<ts>`, and when the agent forwards the saved file via
      // `send_file`, `buildMediaMessage` keys on the extension to pick
      // image/video/audio vs. document — extensionless ⇒ wrong as document.
      const mediaTypes: Array<{ key: string; type: string; ext: string }> = [
        { key: 'imageMessage', type: 'image', ext: '.jpg' },
        { key: 'videoMessage', type: 'video', ext: '.mp4' },
        { key: 'audioMessage', type: 'audio', ext: '.ogg' },
        { key: 'documentMessage', type: 'document', ext: '' },
      ];
      const results: Array<{
        type: string;
        name: string;
        mimeType: string | undefined;
        size: number;
        data: string;
      }> = [];
      for (const { key, type, ext } of mediaTypes) {
        if (!normalized[key]) continue;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const rawName = normalized[key].fileName as string | undefined;
          const name = rawName && rawName.length > 0 ? rawName : `${type}-${Date.now()}${ext}`;
          const mimeType = normalized[key].mimetype as string | undefined;
          results.push({
            type,
            name,
            mimeType,
            size: buffer.byteLength,
            data: buffer.toString('base64'),
          });
          log.info('Media downloaded', { type, name, size: buffer.byteLength });
        } catch (err) {
          log.warn('Failed to download media', { type, err });
        }
      }
      return results;
    }

    async function sendRawMessage(jid: string, text: string, mentions?: string[]): Promise<string | undefined> {
      if (!connected) {
        outgoingQueue.push({ jid, text, mentions });
        log.info('WA disconnected, message queued', { jid, queueSize: outgoingQueue.length });
        return;
      }
      try {
        const payload: { text: string; mentions?: string[] } = { text };
        if (mentions && mentions.length > 0) payload.mentions = mentions;
        const sent = await sock.sendMessage(jid, payload);
        if (sent?.key?.id && sent.message) {
          sentMessageCache.set(sent.key.id, sent.message);
          if (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
            const oldest = sentMessageCache.keys().next().value!;
            sentMessageCache.delete(oldest);
          }
        }
        return sent?.key?.id ?? undefined;
      } catch (err) {
        outgoingQueue.push({ jid, text, mentions });
        log.warn('Failed to send, message queued', { jid, err, queueSize: outgoingQueue.length });
        return undefined;
      }
    }

    // --- Socket creation ---

    async function connectSocket(): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const version = await resolveWaWebVersion();

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        cachedGroupMetadata: async (jid: string) => getNormalizedGroupMetadata(jid),
        getMessage: async (key: WAMessageKey) => {
          // Check in-memory cache first (recently sent messages)
          const cached = sentMessageCache.get(key.id || '');
          if (cached) return cached;
          // Return empty message to prevent indefinite "waiting for this message"
          return proto.Message.create({});
        },
      });

      // Request pairing code only when there's no paired account yet.
      //
      // We can't use `state.creds.registered` here: Baileys 7.x doesn't
      // reliably flip that flag back to `true` after the post-pair stream
      // restart (statusCode 515). An already-paired socket would then see
      // `registered=false` and request a *new* pairing code 3s after the
      // restart, which the WhatsApp server rejects with 401 and the adapter
      // wipes the auth directory — re-pair from scratch every restart.
      //
      // `state.creds.me` is set as part of the QR / pairing-code handshake
      // and is the authoritative "this socket has an account" signal.
      if (phoneNumber && !state.creds.me) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            log.info(`WhatsApp pairing code: ${code}`);
            log.info('Enter in WhatsApp > Linked Devices > Link with phone number');
            fs.writeFileSync(pairingCodeFile, code, 'utf-8');
          } catch (err) {
            log.error('Failed to request pairing code', { err });
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
          // QR code auth — print to terminal
          (async () => {
            try {
              const QRCode = await import('qrcode');
              const qrText = await QRCode.toString(qr, { type: 'terminal' });
              log.info('WhatsApp QR code — scan with WhatsApp > Linked Devices:\n' + qrText);
            } catch {
              log.info('WhatsApp QR code (raw)', { qr });
            }
          })();
        }

        if (connection === 'close') {
          connected = false;
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          // Don't auto-reconnect during shutdown — a parallel connectSocket()
          // initializes useMultiFileAuthState which can truncate creds.json
          // mid-write when the process exits, leaving a 0-byte creds file
          // and forcing a fresh QR pairing on next start.
          const shouldReconnect = !shuttingDown && reason !== DisconnectReason.loggedOut;

          log.info('WhatsApp connection closed', { reason, shouldReconnect, shuttingDown });

          if (shouldReconnect) {
            log.info('Reconnecting...');
            connectSocket().catch((err) => {
              log.error('Failed to reconnect, retrying in 5s', { err });
              setTimeout(() => {
                connectSocket().catch((err2) => {
                  log.error('Reconnection retry failed', { err: err2 });
                });
              }, RECONNECT_DELAY_MS);
            });
          } else if (reason === DisconnectReason.loggedOut) {
            // Server-side logout (account unlinked, 401, etc.). Clear auth so
            // the next start prompts for a fresh pair — stale creds would
            // 401 again and risk WhatsApp's "can't link new devices now"
            // cooldown.
            log.info('WhatsApp logged out');
            try {
              fs.rmSync(authDir, { recursive: true, force: true });
              fs.mkdirSync(authDir, { recursive: true });
              log.info('WhatsApp auth cleared — set WHATSAPP_ENABLED=true and restart to re-link');
            } catch (err) {
              log.error('Failed to clear WhatsApp auth after logout', { err });
            }
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp logged out'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          } else {
            // Clean shutdown (shuttingDown=true) or a non-loggedOut disconnect
            // that won't auto-reconnect. KEEP AUTH — the next process boot
            // must be able to restore the session. Wiping here turned every
            // `systemctl restart` into a forced re-pair, which is catastrophic
            // when the bot phone is not in reach.
            log.info('WhatsApp adapter stopped (auth preserved)');
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp adapter shutdown'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          }
        } else if (connection === 'open') {
          connected = true;
          log.info('Connected to WhatsApp');

          // Clean up pairing code file after successful connection
          try {
            if (fs.existsSync(pairingCodeFile)) fs.unlinkSync(pairingCodeFile);
          } catch {
            /* ignore */
          }

          // Announce availability for presence updates
          sock.sendPresenceUpdate('available').catch((err) => {
            log.warn('Failed to send presence update', { err });
          });

          // Build LID → phone mapping from auth state
          if (sock.user) {
            const phoneUser = sock.user.id.split(':')[0];
            const lidUser = sock.user.lid?.split(':')[0];
            botPhoneJid = `${phoneUser}@s.whatsapp.net`;
            if (lidUser && phoneUser) {
              setLidPhoneMapping(lidUser, botPhoneJid);
              botLidUser = lidUser;
            }
          }

          // Flush queued messages
          flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

          // Group sync
          syncGroupMetadata().catch((err) => log.error('Initial group sync failed', { err }));
          if (!groupSyncTimerStarted) {
            groupSyncTimerStarted = true;
            setInterval(() => {
              syncGroupMetadata().catch((err) => log.error('Periodic group sync failed', { err }));
            }, GROUP_SYNC_INTERVAL_MS);
          }

          // Signal first open
          if (resolveFirstOpen) {
            resolveFirstOpen();
            resolveFirstOpen = undefined;
            rejectFirstOpen = undefined;
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // LID ↔ phone mapping updates (v7 replaces chats.phoneNumberShare)
      sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
        const lidUser = lid?.split('@')[0].split(':')[0];
        if (lidUser && pn) {
          const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
        }
      });

      // Inbound messages
      sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg.message) continue;
            const normalized = normalizeMessageContent(msg.message);
            if (!normalized) continue;
            const rawJid = msg.key.remoteJid;
            if (!rawJid || rawJid === 'status@broadcast') continue;

            // Translate LID → phone JID using v7's alt JID from extractAddressingContext
            const chatJid = await translateJid(rawJid, msg.key.remoteJidAlt);

            const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
            const isGroup = chatJid.endsWith('@g.us');

            // Notify metadata for group discovery
            setupConfig.onMetadata(chatJid, undefined, isGroup);

            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Normalize bot LID mention → assistant name for trigger matching
            if (botLidUser && content.includes(`@${botLidUser}`)) {
              content = content.replace(`@${botLidUser}`, `@${ASSISTANT_NAME}`);
            }

            // Download media attachments (images, video, audio, documents)
            const attachments = await downloadInboundMedia(msg, normalized);

            // Skip empty protocol messages (no text and no attachments)
            if (!content && attachments.length === 0) continue;

            // Resolve sender: in groups, participant may be LID — use participantAlt
            const rawSender = msg.key.participant || msg.key.remoteJid || '';
            const sender = rawSender.endsWith('@lid')
              ? await translateJid(rawSender, msg.key.participantAlt)
              : rawSender;
            const senderName = msg.pushName || sender.split('@')[0];
            const fromMe = msg.key.fromMe || false;
            // Filter bot's own messages to prevent echo loops.
            // In self-chat (user messaging their own number), all messages have
            // fromMe=true — use sentMessageCache to distinguish bot echoes from
            // user-typed messages. For all other chats, the blanket fromMe
            // filter is correct since the user's phone messages shouldn't wake
            // the agent in third-party conversations.
            if (fromMe) {
              const isSelfChat = botPhoneJid && chatJid === botPhoneJid;
              if (!isSelfChat) continue;
              if (sentMessageCache.has(msg.key.id || '')) continue;
            }

            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`);

            // Check if this reply answers a pending question via slash command
            const pending = pendingQuestions.get(chatJid);
            if (pending && content.startsWith('/')) {
              const cmd = content.trim().toLowerCase();
              const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
              if (matched) {
                const voterName = msg.pushName || sender.split('@')[0];
                setupConfig.onAction(pending.questionId, matched.value, sender);
                pendingQuestions.delete(chatJid);
                await sendRawMessage(chatJid, `${matched.selectedLabel} by ${voterName}`);
                log.info('Question answered', {
                  questionId: pending.questionId,
                  value: matched.value,
                  voterName,
                });
                continue; // Don't forward this reply to the agent
              }
            }

            // Detect explicit @-mentions of the bot in groups. Detail in
            // isBotMentionedInGroup(); short version is contextInfo.mentionedJid
            // on text + caption-bearing messages, matched against the bot's
            // phone JID and LID (#2560).
            const botMentionedInGroup = isGroup && isBotMentionedInGroup(normalized, botPhoneJid, botLidUser);

            const inbound: InboundMessage = {
              id: msg.key.id || `wa-${Date.now()}`,
              kind: 'chat',
              // DMs are addressed to the bot by definition. Mark them as
              // platform-confirmed mentions so the router auto-creates an
              // approval-required messaging_group when the chat is unknown,
              // instead of silently dropping. In groups, only an explicit
              // @-mention counts.
              isMention: computeIsMention(isGroup, botMentionedInGroup),
              isGroup,
              content: {
                text: content,
                sender,
                senderName,
                ...(attachments.length > 0 && { attachments }),
                fromMe,
                isBotMessage,
                isGroup,
                chatJid,
              },
              timestamp,
            };

            // WhatsApp doesn't use threads — threadId is null
            setupConfig.onInbound(chatJid, null, inbound);
          } catch (err) {
            log.error('Error processing incoming WhatsApp message', {
              err,
              remoteJid: msg.key?.remoteJid,
            });
          }
        }
      });
    }

    // --- ChannelAdapter implementation ---

    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // Connect and wait for first open
        await new Promise<void>((resolve, reject) => {
          resolveFirstOpen = resolve;
          rejectFirstOpen = reject;
          connectSocket().catch(reject);
        });

        log.info('WhatsApp adapter initialized');
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // Ask question → text with slash command replies
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);

          const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
          const text = `*${title}*\n\n${question}\n\nReply with:\n${optionLines}`;
          const msgId = await sendRawMessage(platformId, text);
          if (msgId) {
            pendingQuestions.set(platformId, { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              const oldest = pendingQuestions.keys().next().value!;
              pendingQuestions.delete(oldest);
            }
          }
          return msgId;
        }

        // Reaction → emoji on a message
        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          try {
            await sock.sendMessage(platformId, {
              react: {
                text: content.emoji as string,
                key: { remoteJid: platformId, id: content.messageId as string, fromMe: false },
              },
            });
          } catch (err) {
            log.debug('Failed to send reaction', { platformId, err });
          }
          return;
        }

        // Normal message (with optional file attachments)
        const text = (content.markdown as string) || (content.text as string);
        const hasFiles = message.files && message.files.length > 0;

        if (!text && !hasFiles) return;

        // Send file attachments (first file gets the caption, rest are captionless)
        if (hasFiles) {
          let captionUsed = false;
          for (const file of message.files!) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              let caption: string | undefined;
              let captionMentions: string[] | undefined;
              if (!captionUsed && text) {
                const formatted = formatWhatsApp(text);
                caption = formatted.text;
                captionMentions = formatted.mentions.length > 0 ? formatted.mentions : undefined;
              }
              const mediaMsg = buildMediaMessage(file.data, file.filename, ext, caption);
              if (captionMentions) mediaMsg.mentions = captionMentions;
              const sent = await sock.sendMessage(platformId, mediaMsg);
              if (sent?.key?.id && sent.message) {
                sentMessageCache.set(sent.key.id, sent.message);
              }
              if (caption) captionUsed = true;
            } catch (err) {
              log.error('Failed to send file', { platformId, filename: file.filename, err });
            }
          }
          if (captionUsed) return; // Text was sent as caption
        }

        if (text) {
          const { text: formatted, mentions } = formatWhatsApp(text);
          const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${ASSISTANT_NAME}: ${formatted}`;
          return sendRawMessage(platformId, prefixed, mentions);
        }
      },

      async setTyping(platformId: string) {
        try {
          await sock.sendPresenceUpdate('composing', platformId);
        } catch (err) {
          log.debug('Failed to update typing status', { jid: platformId, err });
        }
      },

      async teardown() {
        shuttingDown = true;
        connected = false;
        sock?.end(undefined);
        log.info('WhatsApp adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const groups = await sock.groupFetchAllParticipating();
          return Object.entries(groups)
            .filter(([, m]) => m.subject)
            .map(([jid, m]) => ({
              platformId: jid,
              name: m.subject,
              isGroup: true,
            }));
        } catch (err) {
          log.error('Failed to sync WhatsApp conversations', { err });
          return [];
        }
      },
    };

    return adapter;
  },
});
