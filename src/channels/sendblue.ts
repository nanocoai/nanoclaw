/** Direct text iMessage/SMS channel, installed by /add-sendblue. */
import { timingSafeEqual } from 'node:crypto';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { normalizeOptions, type NormalizedOption, type RawOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import { SendblueDeliveryError } from './sendblue-delivery.js';

const PHONE = /^\+[1-9][0-9]{7,14}$/;
const API = 'https://api.sendblue.com/api/send-message';
export const SENDBLUE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

export interface SendblueConfig {
  apiKey: string;
  apiSecret: string;
  signingSecret: string;
  fromNumber: string;
  allowFrom: string[];
}

interface PendingQuestion {
  id: string;
  options: NormalizedOption[];
  expires: number;
}

export function createSendblueAdapter(config: SendblueConfig, request: typeof fetch = fetch): ChannelAdapter {
  if (!config.apiKey || !config.apiSecret || !config.signingSecret || !PHONE.test(config.fromNumber)) {
    throw new Error('Sendblue requires API credentials, webhook secret and an assigned E.164 line; run /add-sendblue');
  }
  if (!config.allowFrom.length || config.allowFrom.some((n) => n !== '*' && !PHONE.test(n))) {
    throw new Error('Sendblue requires an E.164 allowlist or explicit *; run /add-sendblue');
  }
  let connected = false;
  let pending = 0;
  const seen = new Map<string, boolean>();
  const questions = new Map<string, PendingQuestion>();
  const allowed = (number: string) => config.allowFrom.includes(number) || config.allowFrom.includes('*');

  async function sendText(recipient: string, text: string): Promise<string | undefined> {
    let handle: string | undefined;
    const characters = Array.from(text);
    for (let offset = 0; offset < characters.length; offset += 2000) {
      let result: unknown;
      try {
        const response = await request(API, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Content-Type': 'application/json',
            'sb-api-key-id': config.apiKey,
            'sb-api-secret-key': config.apiSecret,
          },
          body: JSON.stringify({
            number: recipient,
            from_number: config.fromNumber,
            content: characters.slice(offset, offset + 2000).join(''),
          }),
        });
        if (!response.ok) throw new Error(`Sendblue HTTP ${response.status}`);
        result = await response.json();
      } catch (error) {
        // External transport boundary: preserve the cause, never retry this POST.
        throw new SendblueDeliveryError('Sendblue acceptance unconfirmed; inspect provider status before retrying', {
          cause: error,
        });
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new SendblueDeliveryError('Sendblue returned an invalid acceptance response');
      }
      const data = result as Record<string, unknown>;
      if (
        typeof data.message_handle !== 'string' ||
        !data.message_handle ||
        !['QUEUED', 'SENT', 'DELIVERED', 'READ'].includes(String(data.status)) ||
        (data.error_code != null && data.error_code !== 0)
      ) {
        throw new SendblueDeliveryError('Sendblue did not confirm acceptance; inspect provider status before retrying');
      }
      handle = data.message_handle;
    }
    return handle;
  }

  async function receive(
    setup: ChannelSetup,
    req: Parameters<Parameters<typeof registerWebhookHandler>[1]>[0],
    res: Parameters<Parameters<typeof registerWebhookHandler>[1]>[1],
  ): Promise<void> {
    const reply = (status: number) => {
      res.writeHead(status);
      res.end();
    };
    if (!connected) return reply(503);
    if (req.method !== 'POST') return reply(405);
    const supplied = Buffer.from(
      typeof req.headers['sb-signing-secret'] === 'string' ? req.headers['sb-signing-secret'] : '',
    );
    const expected = Buffer.from(config.signingSecret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401);
    if (pending >= 128) return reply(503);
    pending++;
    let handle: string | undefined;
    let claimed = false;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 65536) return reply(413);
        chunks.push(bytes);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) return reply(400);
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(400);
      const p = payload as Record<string, unknown>;
      if (
        p.is_outbound !== false ||
        p.status !== 'RECEIVED' ||
        (p.group_id != null && p.group_id !== '') ||
        p.to_number !== config.fromNumber
      )
        return reply(200);
      if (
        typeof p.from_number !== 'string' ||
        !PHONE.test(p.from_number) ||
        typeof p.message_handle !== 'string' ||
        !p.message_handle ||
        p.message_handle.length > 256 ||
        (p.content != null && typeof p.content !== 'string') ||
        (p.media_url != null && typeof p.media_url !== 'string')
      )
        return reply(400);
      if (!allowed(p.from_number)) return reply(200);
      handle = p.message_handle;
      if (seen.has(handle)) return reply(seen.get(handle) ? 200 : 503);
      let text = typeof p.content === 'string' ? p.content : '';
      if (p.media_url)
        text += '\n[Attachment received; this channel supports text only. Please resend its contents as text.]';
      if (!text.trim()) return reply(200);
      seen.set(handle, false);
      claimed = true;
      const question = questions.get(p.from_number);
      const answer = text.trim().match(/^\/sendblue\s+(\S+)\s+(\d+)$/);
      if (answer && question && question.id === answer[1] && question.expires > Date.now()) {
        const choice = question.options[Number(answer[2]) - 1];
        if (choice) {
          setup.onAction(question.id, choice.value, p.from_number, {
            instance: 'sendblue',
            platformId: p.from_number,
            threadId: null,
          });
          questions.delete(p.from_number);
          seen.set(handle, true);
          return reply(200);
        }
      }
      await setup.onInbound(p.from_number, null, {
        id: handle,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: false,
        content: {
          text,
          sender: p.from_number,
          senderId: `sendblue:${p.from_number}`,
          senderName: p.from_number,
          isGroup: false,
        },
      });
      seen.set(handle, true);
      reply(200);
      // eslint-disable-next-line no-catch-all/no-catch-all -- raw HTTP boundary must reject failed routing for retry
    } catch (error) {
      // External ingress boundary: failed routing stays retryable, without logging payloads.
      if (claimed && handle) seen.delete(handle);
      log.warn('Sendblue callback could not be routed', {
        messageHandle: handle,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      if (!res.headersSent) reply(503);
    } finally {
      pending--;
      if (seen.size > 4096) {
        for (const [id, complete] of seen) {
          if (complete) {
            seen.delete(id);
            break;
          }
        }
      }
    }
  }

  return {
    name: 'sendblue',
    channelType: 'sendblue',
    supportsThreads: false,
    defaults: SENDBLUE_DEFAULTS,
    async setup(setup) {
      connected = true;
      registerWebhookHandler('sendblue', (req, res) => receive(setup, req, res));
    },
    async teardown() {
      connected = false;
      questions.clear();
    },
    isConnected() {
      return connected;
    },
    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      if (!connected) throw new Error('Sendblue adapter is disconnected');
      if (!PHONE.test(platformId) || !allowed(platformId))
        throw new SendblueDeliveryError('Sendblue destination is not allowed');
      if (message.files?.length) throw new SendblueDeliveryError('Sendblue file delivery is unsupported');
      if (typeof message.content === 'string') return sendText(platformId, message.content);
      if (!message.content || typeof message.content !== 'object')
        throw new SendblueDeliveryError('Sendblue requires text content');
      const content = message.content as Record<string, unknown>;
      if (content.type === 'ask_question' && typeof content.questionId === 'string' && Array.isArray(content.options)) {
        if (
          !/^[-\w]+$/.test(content.questionId) ||
          !content.options.length ||
          content.options.some(
            (o: unknown) =>
              typeof o !== 'string' &&
              (!o || typeof o !== 'object' || typeof (o as Record<string, unknown>).label !== 'string'),
          )
        )
          throw new SendblueDeliveryError('Sendblue question requires an identifier and text options');
        const options = normalizeOptions(content.options as RawOption[]);
        const text = `${content.title ?? 'Question'}\n${content.question ?? ''}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n\nReply: /sendblue ${content.questionId} NUMBER`;
        const handle = await sendText(platformId, text);
        questions.set(platformId, { id: content.questionId, options, expires: Date.now() + 10 * 60_000 });
        if (questions.size > 128) questions.delete(questions.keys().next().value!);
        return handle;
      }
      if (typeof content.text !== 'string' || content.attachments || content.operation)
        throw new SendblueDeliveryError('Sendblue supports text delivery only');
      return sendText(platformId, content.text);
    },
  };
}

registerChannelAdapter('sendblue', {
  defaults: SENDBLUE_DEFAULTS,
  factory: () => {
    const env = readEnvFile([
      'SENDBLUE_API_KEY',
      'SENDBLUE_API_SECRET',
      'SENDBLUE_SIGNING_SECRET',
      'SENDBLUE_FROM_NUMBER',
      'SENDBLUE_ALLOW_FROM',
    ]);
    if (!Object.keys(env).length) return null;
    return createSendblueAdapter({
      apiKey: env.SENDBLUE_API_KEY ?? '',
      apiSecret: env.SENDBLUE_API_SECRET ?? '',
      signingSecret: env.SENDBLUE_SIGNING_SECRET ?? '',
      fromNumber: env.SENDBLUE_FROM_NUMBER ?? '',
      allowFrom: (env.SENDBLUE_ALLOW_FROM ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  },
});
