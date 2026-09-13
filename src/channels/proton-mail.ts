/**
 * Proton Mail channel adapter (v2) — native IMAP/SMTP against a local Proton
 * Mail Bridge. Self-registers on import.
 *
 * The Bridge terminates Proton's end-to-end encryption on this machine and
 * speaks ordinary IMAP/SMTP (STARTTLS, self-signed cert) on loopback. This
 * adapter is the only thing that talks to it: inbound mail arrives over IMAP
 * IDLE with a fallback poll, replies leave over SMTP threaded onto the
 * correspondent's last message.
 *
 * Every correspondent is a DM. platformId is the sender's address (lowercased),
 * so one session per address and user ids of the form `proton-mail:<address>`.
 * Email carries no mention metadata, so every inbound is flagged isMention —
 * a stranger's first mail auto-creates a messaging group under the declared
 * unknown-sender policy (request_approval) instead of being silently dropped.
 *
 * All side effects (connections, state file) live in the factory and setup();
 * importing this module only registers the adapter.
 */
import fs from 'fs';
import path from 'path';

import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import nodemailer, { type Transporter } from 'nodemailer';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
  ResolvedConversation,
} from './adapter.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';

const STATE_DIR = path.join(process.cwd(), 'store', 'proton-mail');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const THREADS_MAX = 512;
const PENDING_QUESTIONS_MAX = 64;
const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const BODY_MAX_CHARS = 50_000;
const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** Stamped on every outbound mail; an inbound carrying it is our own echo. */
const LOOP_HEADER = 'x-nanoclaw-agent';

/**
 * Email: every conversation is a DM addressed to the bridge account — the
 * group branch is inert but required by the type. 'dm-only' because email has
 * no mention metadata. request_approval so a stranger's first mail raises an
 * approval card rather than reaching the agent or vanishing.
 */
export const PROTON_MAIL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'dm-only',
};

// --- Pure helpers (exported for tests) ---

export function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** "Re: X" unless the subject already carries a reply prefix in a common locale. */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? '').trim();
  if (!s) return 'Re: (no subject)';
  if (/^(re|aw|sv|antw|ref)\s*:/i.test(s)) return s;
  return `Re: ${s}`;
}

/**
 * Drop the quoted history a mail client appends to a reply: everything from
 * the "On … wrote:" / "-----Original Message-----" marker on, plus any trailing
 * `>`-quoted lines. Returns the original when stripping would leave nothing —
 * a message that is only a quote is still a message.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nextNonEmpty = (from: number): string => {
    for (let j = from; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t) return t;
    }
    return '';
  };
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      /^On\b.*\bwrote:\s*$/.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line) ||
      /^_{5,}$/.test(line) ||
      // Outlook (web/mobile): a bare rule, then a From:/Sent: header block.
      (/^-{10,}$/.test(line) && /^From:\s/i.test(nextNonEmpty(i + 1))) ||
      // Outlook without the rule: a From: header followed by Sent:/Date:/To:.
      (/^From:\s.+/i.test(line) && /^(Sent|Date|To):\s/i.test(nextNonEmpty(i + 1)))
    ) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut);
  // Trailing quoted block without a marker line.
  while (kept.length > 0 && (kept[kept.length - 1].trim() === '' || kept[kept.length - 1].startsWith('>'))) {
    kept.pop();
  }
  const out = kept.join('\n').trim();
  return out || text.trim();
}

/** Crude text extraction for HTML-only mail; mailparser only fills `text` from a text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SkipInput {
  fromAddress?: string;
  autoSubmitted?: string;
  precedence?: string;
  loopHeader?: string;
}

/**
 * Reason to drop an inbound before it reaches the router, or null to keep it.
 * Bounces, vacation auto-replies and our own echoes must never wake an agent —
 * an agent answering a bounce answers it forever.
 */
export function shouldSkipInbound(input: SkipInput): string | null {
  if (input.loopHeader) return 'own echo';
  if (!input.fromAddress) return 'no sender';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(input.fromAddress)) return 'system sender';
  const auto = (input.autoSubmitted ?? '').trim().toLowerCase();
  if (auto && auto !== 'no') return `auto-submitted: ${auto}`;
  const prec = (input.precedence ?? '').trim().toLowerCase();
  if (prec === 'bulk' || prec === 'junk' || prec === 'auto_reply') return `precedence: ${prec}`;
  return null;
}

export function classifyAttachment(contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'document';
}

export function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

/** Render an ask_question card as a plain-text mail body with slash-command replies. */
export function renderAskQuestion(title: string, question: string, options: NormalizedOption[]): string {
  const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
  return `${title}\n\n${question}\n\nReply with one of:\n${optionLines}`;
}

/** First non-empty line of a reply, if it is a slash command matching an option. */
export function matchCommandReply(body: string, options: NormalizedOption[]): NormalizedOption | undefined {
  const first = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first || !first.startsWith('/')) return undefined;
  const cmd = first.toLowerCase();
  return options.find((o) => optionToCommand(o.label) === cmd);
}

// --- Persistent adapter state ---

interface ThreadRef {
  messageId: string;
  references: string[];
  subject?: string;
  name?: string;
  at: string;
}

interface AdapterState {
  uidValidity?: number;
  lastUid?: number;
  threads: Record<string, ThreadRef>;
}

function loadState(): AdapterState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<AdapterState>;
    return { uidValidity: raw.uidValidity, lastUid: raw.lastUid, threads: raw.threads ?? {} };
  } catch (err) {
    log.debug('No Proton Mail adapter state yet, starting fresh', { err });
    return { threads: {} };
  }
}

function saveState(state: AdapterState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error('Failed to persist Proton Mail adapter state', { err });
  }
}

function rememberThread(state: AdapterState, address: string, ref: Omit<ThreadRef, 'at'>): void {
  state.threads[address] = { ...ref, at: new Date().toISOString() };
  const keys = Object.keys(state.threads);
  if (keys.length > THREADS_MAX) {
    keys
      .sort((a, b) => state.threads[a].at.localeCompare(state.threads[b].at))
      .slice(0, keys.length - THREADS_MAX)
      .forEach((k) => delete state.threads[k]);
  }
}

function firstAddress(obj: AddressObject | AddressObject[] | undefined): { address?: string; name?: string } {
  const one = Array.isArray(obj) ? obj[0] : obj;
  const v = one?.value?.[0];
  return { address: v?.address, name: v?.name || undefined };
}

function allAddresses(obj: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(obj) ? obj : obj ? [obj] : [];
  return list.flatMap((o) => o.value.map((v) => v.address).filter((a): a is string => !!a));
}

function headerString(parsed: ParsedMail, name: string): string | undefined {
  const v = parsed.headers.get(name);
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(String).join(', ');
  return String(v);
}

// --- Registration ---

registerChannelAdapter('proton-mail', {
  factory: () => {
    const env = readEnvFile([
      'PROTON_MAIL_ADDRESS',
      'PROTON_MAIL_BRIDGE_PASSWORD',
      'PROTON_MAIL_FROM_NAME',
      'PROTON_MAIL_IMAP_HOST',
      'PROTON_MAIL_IMAP_PORT',
      'PROTON_MAIL_SMTP_HOST',
      'PROTON_MAIL_SMTP_PORT',
      'PROTON_MAIL_TLS_REJECT_UNAUTHORIZED',
      'PROTON_MAIL_MAILBOX',
      'PROTON_MAIL_POLL_SECONDS',
      'PROTON_MAIL_MARK_SEEN',
      'PROTON_MAIL_PROCESS_BACKLOG',
      'PROTON_MAIL_DEFAULT_SUBJECT',
    ]);
    const address = env.PROTON_MAIL_ADDRESS ? normalizeAddress(env.PROTON_MAIL_ADDRESS) : '';
    const password = env.PROTON_MAIL_BRIDGE_PASSWORD;
    if (!address || !password) return null;

    const cfg = {
      address,
      password,
      fromName: env.PROTON_MAIL_FROM_NAME || undefined,
      imapHost: env.PROTON_MAIL_IMAP_HOST || '127.0.0.1',
      imapPort: Number(env.PROTON_MAIL_IMAP_PORT) || 1143,
      smtpHost: env.PROTON_MAIL_SMTP_HOST || '127.0.0.1',
      smtpPort: Number(env.PROTON_MAIL_SMTP_PORT) || 1025,
      // The Bridge presents a self-signed certificate on loopback; verifying
      // it would need the operator to export and trust it. Off by default,
      // and only sensible to turn on when the bridge is not on loopback.
      rejectUnauthorized: env.PROTON_MAIL_TLS_REJECT_UNAUTHORIZED === 'true',
      mailbox: env.PROTON_MAIL_MAILBOX || 'INBOX',
      pollMs: (Number(env.PROTON_MAIL_POLL_SECONDS) || 60) * 1000,
      markSeen: env.PROTON_MAIL_MARK_SEEN !== 'false',
      processBacklog: env.PROTON_MAIL_PROCESS_BACKLOG === 'true',
      defaultSubject: env.PROTON_MAIL_DEFAULT_SUBJECT || 'Message from your assistant',
    };

    const state = loadState();
    let setupConfig: ChannelSetup;
    let client: ImapFlow | undefined;
    let transporter: Transporter | undefined;
    let connected = false;
    let shuttingDown = false;
    let draining = false;
    let reconnectDelay = RECONNECT_DELAY_MS;
    let pollTimer: NodeJS.Timeout | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;

    // Pending ask_question cards: address → { questionId, options }.
    const pendingQuestions = new Map<string, { questionId: string; options: NormalizedOption[] }>();

    // --- Outbound ---

    function getTransporter(): Transporter {
      transporter ??= nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: false,
        requireTLS: true,
        auth: { user: cfg.address, pass: cfg.password },
        tls: { rejectUnauthorized: cfg.rejectUnauthorized },
      });
      return transporter;
    }

    async function sendMail(
      to: string,
      text: string,
      files: Array<{ filename: string; content: Buffer }> = [],
    ): Promise<string | undefined> {
      const addr = normalizeAddress(to);
      const thread = state.threads[addr];
      const info = await getTransporter().sendMail({
        from: cfg.fromName ? { name: cfg.fromName, address: cfg.address } : cfg.address,
        to: addr,
        subject: thread ? replySubject(thread.subject) : cfg.defaultSubject,
        text,
        attachments: files,
        headers: { 'X-NanoClaw-Agent': 'proton-mail' },
        ...(thread && { inReplyTo: thread.messageId, references: thread.references.join(' ') }),
      });
      const sentId: string | undefined = info?.messageId;
      if (sentId) {
        // Chain our own message into the thread so the next agent-initiated
        // mail (a scheduled task, say) lands in the same conversation.
        rememberThread(state, addr, {
          messageId: sentId,
          references: [...(thread?.references ?? []), sentId].slice(-20),
          subject: thread?.subject ?? cfg.defaultSubject,
          name: thread?.name,
        });
        saveState(state);
      }
      return sentId;
    }

    // --- Inbound ---

    async function handleMessage(uid: number, source: Buffer): Promise<void> {
      const parsed = await simpleParser(source);
      const from = firstAddress(parsed.from);
      const fromAddr = from.address ? normalizeAddress(from.address) : undefined;

      const skip = shouldSkipInbound({
        fromAddress: fromAddr,
        autoSubmitted: headerString(parsed, 'auto-submitted'),
        precedence: headerString(parsed, 'precedence'),
        loopHeader: headerString(parsed, LOOP_HEADER),
      });
      if (skip || !fromAddr) {
        log.debug('Proton Mail inbound skipped', { uid, reason: skip, from: fromAddr });
        return;
      }

      const rawText = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
      let body = stripQuotedReply(rawText);
      if (body.length > BODY_MAX_CHARS) {
        body = body.slice(0, BODY_MAX_CHARS) + `\n\n[… truncated, ${rawText.length} characters in total]`;
      }
      const subject = parsed.subject?.trim() || undefined;
      const senderName = from.name || fromAddr;
      const messageId = parsed.messageId || `<mail-${uid}@nanoclaw.local>`;

      // Thread bookkeeping happens before the question check so a confirmation
      // reply threads correctly too.
      rememberThread(state, fromAddr, {
        messageId,
        references: [...(parsed.references ? [parsed.references].flat() : []), messageId].slice(-20),
        subject,
        name: from.name,
      });

      const pending = pendingQuestions.get(fromAddr);
      if (pending) {
        const matched = matchCommandReply(body, pending.options);
        if (matched) {
          setupConfig.onAction(pending.questionId, matched.value, fromAddr);
          pendingQuestions.delete(fromAddr);
          saveState(state);
          await sendMail(fromAddr, `${matched.selectedLabel} by ${senderName}`);
          log.info('Proton Mail question answered', { questionId: pending.questionId, value: matched.value });
          return;
        }
      }

      const attachments: Array<{ type: string; name: string; data: string }> = [];
      const failures: string[] = [];
      for (const att of parsed.attachments ?? []) {
        const type = classifyAttachment(att.contentType);
        if (att.size > ATTACHMENT_MAX_BYTES) {
          failures.push(`${att.filename ?? type} (too large)`);
          continue;
        }
        const fallback = `${type}-${uid}-${attachments.length + 1}`;
        const rawName = att.filename ?? '';
        const name = isSafeAttachmentName(rawName) ? rawName : fallback;
        if (rawName && name !== rawName) {
          log.warn('Refused unsafe attachment filename — would escape the inbox', { rawName, replacement: name });
        }
        attachments.push({ type, name, data: att.content.toString('base64') });
      }

      let text = subject ? `Subject: ${subject}\n\n${body}` : body;
      if (failures.length > 0) text += `\n\n[attachments not delivered: ${failures.join(', ')}]`;
      if (!text.trim() && attachments.length === 0) return;

      setupConfig.onMetadata(fromAddr, senderName, false);

      const inbound: InboundMessage = {
        id: messageId,
        kind: 'chat',
        // A mail to the bridge account is addressed to the bot by definition.
        isMention: true,
        isGroup: false,
        content: {
          text,
          sender: fromAddr,
          senderName,
          subject,
          messageId,
          to: allAddresses(parsed.to),
          cc: allAddresses(parsed.cc),
          ...(attachments.length > 0 && { attachments }),
          fromMe: false,
          isGroup: false,
        },
        timestamp: (parsed.date ?? new Date()).toISOString(),
      };
      saveState(state);
      await setupConfig.onInbound(fromAddr, null, inbound);
    }

    /**
     * Fetch everything above the last processed UID. Messages are collected
     * first and handled after the fetch completes: imapflow serializes
     * commands, so issuing another one (flags, a send-confirmation) while the
     * fetch iterator is open would deadlock.
     */
    async function drain(): Promise<void> {
      if (!client || !connected || draining) return;
      draining = true;
      try {
        const lastUid = state.lastUid ?? 0;
        const pending: Array<{ uid: number; source: Buffer }> = [];
        // `N:*` returns the highest-UID message even when N exceeds it, hence
        // the explicit uid guard on each result.
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid > lastUid && msg.source) pending.push({ uid: msg.uid, source: msg.source });
        }
        pending.sort((a, b) => a.uid - b.uid);
        for (const { uid, source } of pending) {
          try {
            await handleMessage(uid, source);
          } catch (err) {
            log.error('Error processing inbound mail', { uid, err });
          }
          state.lastUid = uid;
          saveState(state);
          if (cfg.markSeen) {
            try {
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } catch (err) {
              log.debug('Failed to mark mail seen', { uid, err });
            }
          }
        }
      } catch (err) {
        log.error('Proton Mail fetch failed', { err });
      } finally {
        draining = false;
      }
    }

    function scheduleReconnect(): void {
      if (shuttingDown || reconnectTimer) return;
      log.info('Proton Mail IMAP reconnecting', { inMs: reconnectDelay });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    async function connect(): Promise<void> {
      if (shuttingDown) return;
      const imap = new ImapFlow({
        host: cfg.imapHost,
        port: cfg.imapPort,
        secure: false,
        auth: { user: cfg.address, pass: cfg.password },
        tls: { rejectUnauthorized: cfg.rejectUnauthorized },
        logger: false,
      });
      imap.on('error', (err: Error) => log.error('Proton Mail IMAP error', { err }));
      imap.on('close', () => {
        if (client !== imap) return;
        connected = false;
        log.warn('Proton Mail IMAP connection closed');
        scheduleReconnect();
      });
      imap.on('exists', () => void drain());

      try {
        await imap.connect();
        await imap.mailboxOpen(cfg.mailbox);
        client = imap;

        const mailbox = imap.mailbox;
        if (mailbox) {
          const validity = Number(mailbox.uidValidity);
          if (state.uidValidity !== validity) {
            // Fresh mailbox (first run) or UIDs were renumbered. Start at the
            // top unless the operator asked for the existing unread backlog.
            state.uidValidity = validity;
            state.lastUid = cfg.processBacklog ? 0 : Math.max(0, mailbox.uidNext - 1);
            saveState(state);
            log.info('Proton Mail mailbox opened', {
              mailbox: cfg.mailbox,
              startingAfterUid: state.lastUid,
              backlog: cfg.processBacklog,
            });
          }
        }
        connected = true;
        reconnectDelay = RECONNECT_DELAY_MS;
        log.info('Proton Mail adapter connected', { address: cfg.address, imap: `${cfg.imapHost}:${cfg.imapPort}` });
        await drain();
      } catch (err) {
        log.error('Proton Mail IMAP connect failed', { err, imap: `${cfg.imapHost}:${cfg.imapPort}` });
        try {
          imap.close();
        } catch (closeErr) {
          log.debug('IMAP close after failed connect threw', { err: closeErr });
        }
        scheduleReconnect();
      }
    }

    const adapter: ChannelAdapter = {
      name: 'Proton Mail',
      channelType: 'proton-mail',
      supportsThreads: false,

      async setup(config: ChannelSetup): Promise<void> {
        setupConfig = config;
        fs.mkdirSync(STATE_DIR, { recursive: true });
        await connect();
        // IDLE delivers `exists` promptly; the poll is the safety net for a
        // bridge that drops IDLE or a missed notification.
        pollTimer = setInterval(() => void drain(), cfg.pollMs);
      },

      async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
        const content = message.content as Record<string, unknown>;

        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options = normalizeOptions(content.options as never);
          const text = renderAskQuestion(title, content.question as string, options);
          const id = await sendMail(platformId, text);
          if (id) {
            pendingQuestions.set(normalizeAddress(platformId), { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              pendingQuestions.delete(pendingQuestions.keys().next().value!);
            }
          }
          return id;
        }

        // Email has no reactions.
        if (content.operation === 'reaction') return;

        const text = ((content.markdown as string) || (content.text as string) || '').trim();
        const files = (message.files ?? []).map((f) => ({ filename: f.filename, content: f.data }));
        if (!text && files.length === 0) return;
        return sendMail(platformId, text || '(see attached)', files);
      },

      async teardown() {
        shuttingDown = true;
        connected = false;
        if (pollTimer) clearInterval(pollTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try {
          await client?.logout();
        } catch (err) {
          log.debug('IMAP logout threw during teardown', { err });
        }
        transporter?.close();
        log.info('Proton Mail adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async resolveConversation(platformId: string): Promise<ResolvedConversation | null> {
        const addr = normalizeAddress(platformId);
        return { type: 'direct', name: state.threads[addr]?.name ?? addr };
      },
    };

    return adapter;
  },
  defaults: PROTON_MAIL_DEFAULTS,
});
