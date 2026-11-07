import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface ZulipChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ZulipMessage {
  id: number;
  type: 'stream' | 'private';
  sender_email: string;
  sender_full_name: string;
  content: string;
  timestamp: number;
  stream_id?: number;
  subject?: string; // topic (for stream messages)
  display_recipient?: string | Array<{ email: string; full_name: string }>;
}

interface ZulipEvent {
  type: string;
  id: number;
  message?: ZulipMessage;
}

/**
 * ZulipChannel connects to a Zulip server using HTTP Basic Auth and the
 * Zulip REST API event queue (long-polling).
 *
 * JID format: `zl:<stream_name>/<topic>`
 *   e.g. `zl:general/bot-requests`
 *
 * No npm dependency — uses Node.js built-in fetch (available since v18).
 */
export class ZulipChannel implements Channel {
  name = 'zulip';

  private opts: ZulipChannelOpts;
  private site: string;
  private botEmail: string;
  private authHeader: string;
  private connected = false;
  // Cache stream name → stream_id for typing notifications
  private streamIds = new Map<string, number>();

  constructor(
    site: string,
    botEmail: string,
    botApiKey: string,
    opts: ZulipChannelOpts,
  ) {
    this.site = site.replace(/\/$/, '');
    this.botEmail = botEmail;
    this.authHeader =
      'Basic ' +
      Buffer.from(`${botEmail}:${botApiKey}`).toString('base64');
    this.opts = opts;
  }

  // --- HTTP helpers ---

  private async apiGet(path: string): Promise<any> {
    const resp = await fetch(`${this.site}${path}`, {
      headers: { Authorization: this.authHeader },
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      const err = new Error(
        `Zulip API GET ${path} failed: ${resp.status}`,
      ) as any;
      err.code = body.code;
      err.status = resp.status;
      throw err;
    }
    return body;
  }

  private async apiPost(
    path: string,
    params: Record<string, string>,
  ): Promise<any> {
    const resp = await fetch(`${this.site}${path}`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      const err = new Error(
        `Zulip API POST ${path} failed: ${resp.status}`,
      ) as any;
      err.code = body.code;
      err.status = resp.status;
      throw err;
    }
    return body;
  }

  // --- Channel interface ---

  async connect(): Promise<void> {
    // Verify credentials before starting the event loop
    const me = await this.apiGet('/api/v1/users/me');
    if (me.result !== 'success') {
      throw new Error('Zulip authentication failed');
    }

    this.connected = true;

    logger.info(
      { email: this.botEmail, site: this.site, name: me.full_name },
      'Zulip bot connected',
    );
    console.log(`\n  Zulip bot: ${me.full_name} <${this.botEmail}>`);
    console.log(
      `  @mention the bot and type "chatid" to get a stream's registration JID\n`,
    );

    // Start event polling in the background — do not await
    this.startEventLoop().catch((err) => {
      logger.error({ err }, 'Zulip event loop crashed');
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Zulip channel not connected');
      return;
    }

    try {
      const { streamName, topic } = parseJid(jid);
      if (!streamName || !topic) {
        logger.warn({ jid }, 'Invalid Zulip JID (expected zl:<stream>/<topic>)');
        return;
      }

      // Zulip supports up to 10 000 chars; split conservatively at 9 000
      const MAX_LENGTH = 9000;
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await this.apiPost('/api/v1/messages', {
          type: 'stream',
          to: streamName,
          subject: topic,
          content: text.slice(i, i + MAX_LENGTH),
        });
      }

      logger.info({ jid, length: text.length }, 'Zulip message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Zulip message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('zl:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('Zulip bot stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    try {
      const { streamName, topic } = parseJid(jid);
      if (!streamName || !topic) return;

      // Typing notifications require the numeric stream ID
      const streamId = this.streamIds.get(streamName);
      if (!streamId) return;

      await this.apiPost('/api/v1/typing', {
        op: isTyping ? 'start' : 'stop',
        type: 'stream',
        stream_id: String(streamId),
        topic,
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Zulip typing indicator');
    }
  }

  // --- Event loop ---

  private async startEventLoop(): Promise<void> {
    let queueId = '';
    let lastEventId = -1;

    const register = async (): Promise<void> => {
      const data = await this.apiPost('/api/v1/register', {
        event_types: JSON.stringify(['message']),
      });
      queueId = data.queue_id;
      lastEventId = data.last_event_id;
    };

    await register();

    while (this.connected) {
      try {
        // Zulip long-polling: server holds the request until events arrive
        // (up to ~90 s). We add a 120 s client-side timeout as a safety net.
        const data = await this.apiGet(
          `/api/v1/events?queue_id=${encodeURIComponent(queueId)}&last_event_id=${lastEventId}`,
        );

        for (const event of (data.events || []) as ZulipEvent[]) {
          lastEventId = Math.max(lastEventId, event.id);
          if (event.type === 'message' && event.message) {
            await this.handleMessage(event.message);
          }
        }
      } catch (err: any) {
        if (!this.connected) break;

        if (err.code === 'BAD_EVENT_QUEUE_ID') {
          logger.info('Zulip event queue expired, re-registering');
          await register();
          continue;
        }

        // Network error or transient failure — back off and retry
        logger.warn(
          { err: err.message },
          'Zulip event poll error, retrying in 5 s',
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // Exposed as a method (not private) so unit tests can inject messages
  // without having to control the fetch-based event loop.
  async handleMessage(msg: ZulipMessage): Promise<void> {
    // Ignore messages from the bot itself
    if (msg.sender_email === this.botEmail) return;

    // Only handle stream (channel) messages — skip DMs for now
    if (msg.type !== 'stream') return;

    const streamName = msg.display_recipient as string;
    const topic = msg.subject ?? '';
    const chatJid = `zl:${streamName}/${topic}`;

    // Cache stream_id for typing notifications
    if (msg.stream_id) {
      this.streamIds.set(streamName, msg.stream_id);
    }

    const timestamp = new Date(msg.timestamp * 1000).toISOString();
    const senderName = msg.sender_full_name || msg.sender_email || 'Unknown';
    const sender = msg.sender_email;
    const msgId = String(msg.id);
    const chatName = `${streamName} > ${topic}`;

    // Translate Zulip @mentions into TRIGGER_PATTERN format.
    // Zulip mentions look like @**Bot Name** (linked) or @_Bot Name_ (silent).
    // Neither matches TRIGGER_PATTERN (e.g. ^@Andy\b) so we normalise.
    let content = msg.content;
    const linkedMention = new RegExp(
      `@\\*\\*${ASSISTANT_NAME}[^*]*\\*\\*`,
      'gi',
    );
    const silentMention = new RegExp(`@_${ASSISTANT_NAME}[^_]*_`, 'gi');
    const wasMentioned =
      linkedMention.test(content) || silentMention.test(content);

    if (wasMentioned) {
      content = content
        .replace(linkedMention, '')
        .replace(silentMention, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Respond to "chatid" command — lets users discover the registration JID
    const trimmed = content.trim().toLowerCase();
    if (trimmed === 'chatid' || trimmed.startsWith('chatid ')) {
      await this.apiPost('/api/v1/messages', {
        type: 'stream',
        to: streamName,
        subject: topic,
        content: `Stream JID: \`${chatJid}\`\nStream: **${streamName}** › **${topic}**`,
      }).catch((err) => logger.warn({ err }, 'Failed to send chatid reply'));
      return;
    }

    // Store chat metadata (used by getAvailableGroups)
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'zulip', true);

    // Only deliver full message payload for registered streams
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Zulip stream',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Zulip message stored',
    );
  }
}

// --- Helpers ---

/**
 * Parse a Zulip JID into its stream name and topic components.
 * JID format: `zl:<stream_name>/<topic>`
 * Topic is everything after the first `/`, so topics with slashes are supported.
 */
function parseJid(jid: string): { streamName: string; topic: string } {
  const withoutPrefix = jid.slice('zl:'.length);
  const slashIdx = withoutPrefix.indexOf('/');
  if (slashIdx === -1) {
    return { streamName: withoutPrefix, topic: '' };
  }
  return {
    streamName: withoutPrefix.slice(0, slashIdx),
    topic: withoutPrefix.slice(slashIdx + 1),
  };
}
