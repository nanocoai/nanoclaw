/**
 * AgentMail channel adapter (native — no Chat SDK bridge exists for AgentMail).
 *
 * Bridges NanoClaw with an AgentMail-managed inbox (https://agentmail.to). Each
 * external correspondent is a separate messaging group, platformId
 * "agentmail:<their-address>" — same flattened model as the Resend adapter,
 * chosen for parity: one NanoClaw session per correspondent, regardless of how
 * many distinct email subject-threads they start. Unlike Resend's adapter,
 * AgentMail's SDK can originate a brand-new thread (`messages.send`) as well
 * as reply within one (`messages.reply`), so there is no cold-start
 * limitation — the bot can email a correspondent first, in either mode below.
 *
 * Two inbound modes, chosen by AGENTMAIL_MODE (default: polling):
 *
 *  - polling: no public endpoint needed. Runs on a cron schedule (default
 *    4am/10am/4pm/10pm daily, install timezone) rather than a fixed interval
 *    — reuses the same `cron-parser` dependency already used for scheduled
 *    tasks (src/modules/scheduling/recurrence.ts) and the resolved install
 *    timezone (TIMEZONE, src/config.ts). A self-rescheduling setTimeout chain
 *    (compute next occurrence, sleep, poll, repeat) rather than setInterval,
 *    since cron occurrences aren't necessarily evenly spaced.
 *  - webhook: instant delivery, but needs a public HTTPS endpoint reachable
 *    from AgentMail's servers. Registers a raw route on the shared webhook
 *    server (registerWebhookHandler) and verifies signatures with `svix`
 *    (AgentMail delivers webhooks via Svix).
 *
 * Required env vars (.env): AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID
 * Optional env vars (.env): AGENTMAIL_MODE ("polling" | "webhook", default
 *                           "polling"), AGENTMAIL_POLL_SCHEDULE (cron
 *                           expression, polling mode only, default
 *                           "0 4,10,16,22 * * *"), AGENTMAIL_WEBHOOK_SECRET
 *                           (webhook mode only, required in that mode),
 *                           AGENTMAIL_INBOUND_ALLOW (comma-separated
 *                           addresses and/or "@domain" entries; when set,
 *                           only mail from these senders is routed as a
 *                           chat message — everything else stays in the
 *                           inbox for the agent to read via the API, and
 *                           never triggers a channel-approval card)
 *
 * Inbound text is prefixed with a short header (from, subject, thread and
 * message ids, attachments) so the agent can reply in-thread or fetch
 * attachments through the AgentMail API. The body is AgentMail's
 * extracted_text (quoted history stripped) when available.
 *
 * Polling state (cursor, recent ids, last inbound message per correspondent)
 * persists to data/agentmail-state.json so a host restart neither drops mail
 * that arrived while it was down nor loses reply threading.
 */
import fs from 'node:fs';
import path from 'node:path';

import { CronExpressionParser } from 'cron-parser';

import { AgentMailClient } from 'agentmail';
import { Webhook as SvixWebhook } from 'svix';

import { DATA_DIR, TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const REQUIRED_ENV = ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID'] as const;
const OPTIONAL_ENV = [
  'AGENTMAIL_MODE',
  'AGENTMAIL_POLL_SCHEDULE',
  'AGENTMAIL_WEBHOOK_SECRET',
  'AGENTMAIL_INBOUND_ALLOW',
] as const;
type AgentMailEnv = { [K in (typeof REQUIRED_ENV)[number]]: string } & {
  [K in (typeof OPTIONAL_ENV)[number]]?: string;
};

const DEFAULT_POLL_SCHEDULE = '0 4,10,16,22 * * *';
// Safety-net dedup across poll ticks — boundary messages at the exact
// `after` cutoff could otherwise be delivered twice. Bounded so it never
// grows unbounded over a long-running process.
const MAX_SEEN_IDS = 500;
// On startup, resume from the persisted cursor only if it is this recent —
// a very stale cursor would replay weeks of mail into the agent.
const MAX_RESUME_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const STATE_PATH = path.join(DATA_DIR, 'agentmail-state.json');

/** "user@domain.com" or "Display Name <user@domain.com>" → bare address. */
function extractAddress(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  const addr = (angleMatch ? angleMatch[1] : from).trim();
  return addr.includes('@') ? addr : null;
}

/** Parse AGENTMAIL_INBOUND_ALLOW. Empty/unset → null (route every sender). */
export function parseInboundAllow(raw: string | undefined): string[] | null {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? entries : null;
}

/** Exact address match, or "@domain" suffix match. */
export function senderAllowed(address: string, allow: string[] | null): boolean {
  if (!allow) return true;
  const addr = address.toLowerCase();
  return allow.some((e) => (e.startsWith('@') ? addr.endsWith(e) : addr === e));
}

export interface InboundEmail {
  messageId: string;
  threadId?: string | null;
  from: string;
  subject?: string | null;
  text?: string | null;
  extractedText?: string | null;
  attachments?: Array<{ attachmentId: string; filename?: string | null; size?: number | null }> | null;
}

function humanSize(bytes: number | null | undefined): string {
  if (!bytes) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Header + body text handed to the agent for one inbound email. */
export function formatInboundText(m: InboundEmail): string {
  const lines = [`[email] From: ${m.from}`, `Subject: ${m.subject || '(no subject)'}`];
  lines.push(`thread_id: ${m.threadId ?? '?'} | message_id: ${m.messageId}`);
  const atts = m.attachments ?? [];
  if (atts.length) {
    lines.push(
      'Attachments: ' +
        atts.map((a) => `${a.filename || 'unnamed'} (${humanSize(a.size)}, id ${a.attachmentId})`).join('; '),
    );
  }
  const body = (m.extractedText || m.text || '').trim();
  return `${lines.join('\n')}\n\n${body}`;
}

/**
 * Plain text to send for one outbound message, or null when there is nothing
 * to send. Email has no buttons and a reply can't answer a card, so an
 * interactive question (approval cards, ask_user_question) is refused with an
 * error instead of being dropped: the approval path then removes the pending
 * row and tells the agent, rather than leaving a card nobody can ever act on.
 */
export function outboundText(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  if (c.type === 'ask_question') {
    throw new Error('agentmail cannot deliver interactive questions (email has no buttons)');
  }
  return typeof c.text === 'string' && c.text ? c.text : null;
}

interface PersistedState {
  lastPollTime?: string;
  seen?: string[];
  lastInbound?: Record<string, string>;
}

function loadState(): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as PersistedState;
  } catch {
    return {};
  }
}

interface WireAttachment {
  attachment_id: string;
  filename?: string | null;
  size?: number | null;
}

interface WireMessage {
  message_id: string;
  thread_id: string;
  from: string;
  subject?: string | null;
  text?: string | null;
  extracted_text?: string | null;
  attachments?: WireAttachment[] | null;
}

interface WireEvent {
  type: 'event';
  event_type: string;
  event_id: string;
  message?: WireMessage;
}

function createAdapter(env: AgentMailEnv): ChannelAdapter {
  const client = new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
  const inboxId = env.AGENTMAIL_INBOX_ID;
  const mode = env.AGENTMAIL_MODE === 'webhook' ? 'webhook' : 'polling';
  const pollSchedule = env.AGENTMAIL_POLL_SCHEDULE || DEFAULT_POLL_SCHEDULE;
  const inboundAllow = parseInboundAllow(env.AGENTMAIL_INBOUND_ALLOW);
  const persisted = loadState();

  // Reply-vs-cold-send state: the last inbound message id per correspondent,
  // so a reply threads properly via AgentMail's own In-Reply-To handling.
  // Persisted with the poll cursor so a restart keeps reply threading.
  const lastInboundMessageId = new Map<string, string>(Object.entries(persisted.lastInbound ?? {}));
  let connected = false;

  // --- polling mode state ---
  const seenMessageIds = new Set<string>(persisted.seen ?? []);
  let lastPollTime = new Date();

  function saveState(): void {
    const state: PersistedState = {
      lastPollTime: lastPollTime.toISOString(),
      seen: [...seenMessageIds],
      lastInbound: Object.fromEntries(lastInboundMessageId),
    };
    try {
      fs.writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(state));
      fs.renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
    } catch (err) {
      log.warn('AgentMail: could not persist state', { err });
    }
  }
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;
  let polling = false;

  function nextOccurrence(): Date {
    try {
      return CronExpressionParser.parse(pollSchedule, { tz: TIMEZONE }).next().toDate();
    } catch (err) {
      log.error('AgentMail: invalid AGENTMAIL_POLL_SCHEDULE, falling back to default', { pollSchedule, err });
      return CronExpressionParser.parse(DEFAULT_POLL_SCHEDULE, { tz: TIMEZONE }).next().toDate();
    }
  }

  function scheduleNextPoll(config: ChannelSetup): void {
    const delayMs = Math.max(0, nextOccurrence().getTime() - Date.now());
    pollTimeout = setTimeout(() => {
      void pollOnce(config).finally(() => scheduleNextPoll(config));
    }, delayMs);
  }

  async function deliverInbound(config: ChannelSetup, email: InboundEmail): Promise<void> {
    const { messageId, from } = email;
    const address = extractAddress(from);
    if (!address) {
      log.warn('AgentMail: could not extract sender address', { from });
      return;
    }
    if (!senderAllowed(address, inboundAllow)) {
      log.debug('AgentMail: sender not in AGENTMAIL_INBOUND_ALLOW, left in inbox', { address, messageId });
      return;
    }
    const text = formatInboundText(email);
    const platformId = `agentmail:${address}`;
    lastInboundMessageId.set(platformId, messageId);
    try {
      await config.onInbound(platformId, null, {
        id: messageId,
        kind: 'chat',
        content: { text, sender: address, senderId: address },
        timestamp: new Date().toISOString(),
        isGroup: false,
        isMention: true,
      });
    } catch (err) {
      log.error('AgentMail: error handling incoming message', { err, messageId });
    }
  }

  async function pollOnce(config: ChannelSetup): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const since = lastPollTime;
      let pageToken: string | undefined;
      const items: Array<{ messageId: string; from: string; createdAt: Date }> = [];

      do {
        const res = await client.inboxes.messages.list(inboxId, {
          after: since,
          labels: ['received'],
          limit: 50,
          pageToken,
        });
        for (const m of res.messages) items.push({ messageId: m.messageId, from: m.from, createdAt: m.createdAt });
        pageToken = res.nextPageToken;
      } while (pageToken);

      if (items.length === 0) return;

      items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      for (const item of items) {
        if (seenMessageIds.has(item.messageId)) continue;
        seenMessageIds.add(item.messageId);
        if (seenMessageIds.size > MAX_SEEN_IDS) {
          const oldest = seenMessageIds.values().next().value;
          if (oldest !== undefined) seenMessageIds.delete(oldest);
        }

        const full = await client.inboxes.messages.get(inboxId, item.messageId);
        await deliverInbound(config, {
          messageId: item.messageId,
          threadId: full.threadId,
          from: item.from,
          subject: full.subject,
          text: full.text,
          extractedText: full.extractedText,
          attachments: full.attachments,
        });
      }

      lastPollTime = items[items.length - 1].createdAt;
      saveState();
    } catch (err) {
      log.error('AgentMail: poll failed', { err });
    } finally {
      polling = false;
    }
  }

  function setupWebhook(config: ChannelSetup): void {
    const verifier = new SvixWebhook(env.AGENTMAIL_WEBHOOK_SECRET as string);

    registerWebhookHandler('agentmail', async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const payload = Buffer.concat(chunks).toString('utf-8');

      const svixId = req.headers['svix-id'];
      const svixTimestamp = req.headers['svix-timestamp'];
      const svixSignature = req.headers['svix-signature'];
      try {
        verifier.verify(payload, {
          'svix-id': Array.isArray(svixId) ? svixId[0] : (svixId ?? ''),
          'svix-timestamp': Array.isArray(svixTimestamp) ? svixTimestamp[0] : (svixTimestamp ?? ''),
          'svix-signature': Array.isArray(svixSignature) ? svixSignature[0] : (svixSignature ?? ''),
        });
      } catch (err) {
        log.warn('AgentMail: webhook signature verification failed', { err });
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('invalid signature');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');

      let event: WireEvent;
      try {
        event = JSON.parse(payload);
      } catch (err) {
        log.error('AgentMail: unparseable webhook payload', { err });
        return;
      }

      if (event.event_type !== 'message.received' || !event.message) return;
      const msg = event.message;
      await deliverInbound(config, {
        messageId: msg.message_id,
        threadId: msg.thread_id,
        from: msg.from,
        subject: msg.subject,
        text: msg.text,
        extractedText: msg.extracted_text,
        attachments: (msg.attachments ?? []).map((a) => ({
          attachmentId: a.attachment_id,
          filename: a.filename,
          size: a.size,
        })),
      });
      saveState();
    });
  }

  return {
    name: 'agentmail',
    channelType: 'agentmail',
    supportsThreads: false,
    defaults: AGENTMAIL_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      // Fail fast on bad credentials / unknown inbox before starting either mode.
      await client.inboxes.get(inboxId);
      connected = true;

      if (mode === 'webhook') {
        setupWebhook(config);
        log.info('AgentMail: adapter ready (webhook mode)', { inboxId });
      } else {
        const resumeFrom = persisted.lastPollTime ? new Date(persisted.lastPollTime) : null;
        lastPollTime =
          resumeFrom && !isNaN(resumeFrom.getTime()) && Date.now() - resumeFrom.getTime() < MAX_RESUME_AGE_MS
            ? resumeFrom
            : new Date();
        scheduleNextPoll(config);
        log.info('AgentMail: adapter ready (polling mode)', {
          inboxId,
          pollSchedule,
          resumeFrom: lastPollTime.toISOString(),
          inboundAllow,
          nextPollAt: nextOccurrence().toISOString(),
        });
      }
    },

    async teardown(): Promise<void> {
      if (pollTimeout) clearTimeout(pollTimeout);
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const address = platformId.replace(/^agentmail:/, '');
      const text = outboundText(message.content);
      if (!text) return undefined;

      const replyToId = lastInboundMessageId.get(platformId);
      if (replyToId) {
        const res = await client.inboxes.messages.reply(inboxId, replyToId, { text });
        return res.messageId;
      }

      const res = await client.inboxes.messages.send(inboxId, {
        to: [address],
        subject: 'Message from your NanoClaw assistant',
        text,
      });
      return res.messageId;
    },
  };
}

/**
 * Dedicated inbox identity, so request_approval is sound. Email carries no
 * mention metadata ('dm-only'; the adapter flags DMs only), so group wirings
 * default to a name-pattern trigger. supportsThreads: false — see the adapter
 * doc comment for the flattened-per-correspondent model.
 */
const AGENTMAIL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: {
    engageMode: 'pattern',
    engagePattern: '\\b{name}\\b',
    threads: false,
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'dm-only',
};

registerChannelAdapter('agentmail', {
  factory: () => {
    const env = readEnvFile([...REQUIRED_ENV, ...OPTIONAL_ENV]);
    if (!env.AGENTMAIL_API_KEY || !env.AGENTMAIL_INBOX_ID) return null;
    if (env.AGENTMAIL_MODE === 'webhook' && !env.AGENTMAIL_WEBHOOK_SECRET) return null;
    return createAdapter(env as AgentMailEnv);
  },
  defaults: AGENTMAIL_DEFAULTS,
});
