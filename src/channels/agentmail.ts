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
 *                           (webhook mode only, required in that mode)
 */
import { CronExpressionParser } from 'cron-parser';

import { AgentMailClient } from 'agentmail';
import { Webhook as SvixWebhook } from 'svix';

import { TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const REQUIRED_ENV = ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID'] as const;
const OPTIONAL_ENV = ['AGENTMAIL_MODE', 'AGENTMAIL_POLL_SCHEDULE', 'AGENTMAIL_WEBHOOK_SECRET'] as const;
type AgentMailEnv = { [K in (typeof REQUIRED_ENV)[number]]: string } & {
  [K in (typeof OPTIONAL_ENV)[number]]?: string;
};

const DEFAULT_POLL_SCHEDULE = '0 4,10,16,22 * * *';
// Safety-net dedup across poll ticks — boundary messages at the exact
// `after` cutoff could otherwise be delivered twice. Bounded so it never
// grows unbounded over a long-running process.
const MAX_SEEN_IDS = 500;

/** "user@domain.com" or "Display Name <user@domain.com>" → bare address. */
function extractAddress(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  const addr = (angleMatch ? angleMatch[1] : from).trim();
  return addr.includes('@') ? addr : null;
}

interface WireMessage {
  message_id: string;
  thread_id: string;
  from: string;
  subject?: string | null;
  text?: string | null;
  extracted_text?: string | null;
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

  // Reply-vs-cold-send state: the last inbound message id per correspondent,
  // so a reply threads properly via AgentMail's own In-Reply-To handling.
  // In-memory only — a host restart falls back to a cold send for that
  // correspondent's next reply, same tradeoff as Resend's ThreadResolver.
  const lastInboundMessageId = new Map<string, string>();
  let connected = false;

  // --- polling mode state ---
  const seenMessageIds = new Set<string>();
  let lastPollTime = new Date();
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

  async function deliverInbound(config: ChannelSetup, messageId: string, from: string, text: string): Promise<void> {
    const address = extractAddress(from);
    if (!address) {
      log.warn('AgentMail: could not extract sender address', { from });
      return;
    }
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
        await deliverInbound(config, item.messageId, item.from, full.text || full.extractedText || '');
      }

      lastPollTime = items[items.length - 1].createdAt;
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
      await deliverInbound(config, msg.message_id, msg.from, msg.text || msg.extracted_text || '');
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
        lastPollTime = new Date();
        scheduleNextPoll(config);
        log.info('AgentMail: adapter ready (polling mode)', {
          inboxId,
          pollSchedule,
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
      const content = message.content as Record<string, unknown>;
      const text = typeof content.text === 'string' ? content.text : '';
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
