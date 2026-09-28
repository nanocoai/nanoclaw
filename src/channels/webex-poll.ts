/**
 * Webex polling adapter — polls the Webex REST API for new messages.
 *
 * Unlike the webhook adapter (`webex`), this one polls periodically so it
 * works behind firewalls and NAT without a public inbound URL.
 *
 * Flow:
 *   1. Factory gated on WEBEX_BOT_TOKEN in .env.
 *   2. On setup: fetch the bot's personId to filter self-messages.
 *   3. Poll /v1/rooms every POLL_INTERVAL_MS, sorted by lastActivity.
 *      Rooms whose lastActivity hasn't advanced are skipped — zero wasted
 *      fetches for idle spaces.
 *   4. For each changed room, fetch recent messages and route anything newer
 *      than the room's last-seen timestamp via config.onInbound.
 *   5. Outbound: POST /v1/messages with roomId + markdown or text.
 *
 * Mention detection: inbound messages carry `mentionedPeople`; the adapter
 * marks isMention=true when the bot's personId is in that list (or always,
 * for DMs). Group wirings default to `mention` mode; DM wirings to
 * `pattern: '.'` (respond to everything).
 *
 * Self-registers on import.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  ConversationInfo,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';

const WEBEX_API = 'https://webexapis.com/v1';
const POLL_INTERVAL_MS = 5000;
const RATE_LIMIT_BASE_SECS = 10;
const RATE_LIMIT_MAX_RETRIES = 4;

interface WebexRoom {
  id: string;
  title: string;
  type: 'direct' | 'group';
  lastActivity: string;
}

interface WebexMessage {
  id: string;
  roomId: string;
  personId: string;
  personEmail: string;
  text?: string;
  markdown?: string;
  mentionedPeople?: string[];
  created: string;
}

/**
 * Conservative group default — mention engagement only; no sticky because the
 * polling adapter has no webhook subscription primitive. DMs: respond to all.
 * Mentions: platform (mentionedPeople array in the REST response).
 */
const WEBEX_POLL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('webex-poll', {
  factory: () => {
    const env = readEnvFile(['WEBEX_BOT_TOKEN']);
    if (!env.WEBEX_BOT_TOKEN) return null;

    const token = env.WEBEX_BOT_TOKEN;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    let botPersonId = '';
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let connected = false;
    let setupConfig: ChannelSetup;

    // Per-room: ISO timestamp of last processed message (oldest-first scan stops here)
    const roomCursor = new Map<string, string>();
    // Per-room: lastActivity from Webex — skip the room on poll if unchanged
    const roomActivity = new Map<string, string>();

    async function apiFetch<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
      const url = path.startsWith('http') ? path : `${WEBEX_API}${path}`;
      const res = await fetch(url, {
        ...init,
        headers: { ...authHeaders, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      });

      if (res.status === 429) {
        if (attempt >= RATE_LIMIT_MAX_RETRIES) {
          throw new Error(`Webex API ${path} → 429: rate limited after ${attempt} retries`);
        }
        // Respect Retry-After, then double on each successive retry.
        const retryAfterSecs = parseInt(res.headers.get('Retry-After') ?? String(RATE_LIMIT_BASE_SECS), 10);
        const delaySecs = retryAfterSecs * Math.pow(2, attempt);
        log.warn('webex-poll: rate limited', { path, attempt, delaySecs });
        await new Promise((r) => setTimeout(r, delaySecs * 1000));
        return apiFetch<T>(path, init, attempt + 1);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Webex API ${path} → ${res.status}: ${body.slice(0, 200)}`);
      }
      return res.json() as Promise<T>;
    }

    async function pollRoom(room: WebexRoom): Promise<void> {
      const platformId = `webex-poll:${room.id}`;
      const isGroup = room.type === 'group';
      const cursor = roomCursor.get(room.id);

      // Fetch newest-first (API default), up to 50 messages
      const result = await apiFetch<{ items: WebexMessage[] }>(
        `/messages?roomId=${encodeURIComponent(room.id)}&max=50`,
      );

      // Reverse to process oldest-first so cursor advances monotonically
      const messages = [...result.items].reverse();

      setupConfig.onMetadata(platformId, room.title, isGroup);

      let newCursor = cursor;

      for (const msg of messages) {
        // Skip if already seen (cursor is the `created` timestamp of the last processed msg)
        if (cursor && msg.created <= cursor) continue;
        // Skip the bot's own messages
        if (msg.personId === botPersonId) {
          if (!newCursor || msg.created > newCursor) newCursor = msg.created;
          continue;
        }

        const isMention = isGroup ? (msg.mentionedPeople ?? []).includes(botPersonId) : true;

        const inbound: InboundMessage = {
          id: msg.id,
          kind: 'chat',
          content: {
            text: msg.text ?? '',
            senderId: `webex-poll:${msg.personId}`,
            sender: msg.personId,
            senderName: msg.personEmail,
            isGroup,
          },
          isMention,
          isGroup,
          timestamp: new Date(msg.created).toISOString(),
        };

        await setupConfig.onInbound(platformId, null, inbound);

        if (!newCursor || msg.created > newCursor) newCursor = msg.created;
      }

      if (newCursor && newCursor !== cursor) {
        roomCursor.set(room.id, newCursor);
      }
    }

    async function poll(): Promise<void> {
      try {
        const { items: rooms } = await apiFetch<{ items: WebexRoom[] }>('/rooms?sortBy=lastactivity&max=100');

        for (const room of rooms) {
          const prev = roomActivity.get(room.id);
          if (prev === room.lastActivity) continue;

          try {
            await pollRoom(room);
          } catch (err) {
            log.warn('webex-poll: pollRoom error', { roomId: room.id, err });
          }

          roomActivity.set(room.id, room.lastActivity);
        }
      } catch (err) {
        log.warn('webex-poll: poll error', { err });
      }

      if (connected) {
        pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }

    const adapter: ChannelAdapter = {
      name: 'webex-poll',
      channelType: 'webex-poll',
      supportsThreads: false,
      defaults: WEBEX_POLL_DEFAULTS,

      async setup(config: ChannelSetup): Promise<void> {
        setupConfig = config;
        const me = await apiFetch<{ id: string }>('/people/me');
        botPersonId = me.id;
        log.info('webex-poll adapter ready', { botPersonId });
        connected = true;
        void poll();
      },

      async teardown(): Promise<void> {
        connected = false;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      },

      isConnected(): boolean {
        return connected;
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const roomId = platformId.replace(/^webex-poll:/, '');
        const content = message.content as Record<string, unknown>;
        const markdown = content.markdown as string | undefined;
        const text = content.text as string | undefined;

        if (!markdown && !text) return undefined;

        try {
          const body: Record<string, string> = { roomId };
          if (markdown) body.markdown = markdown;
          else body.text = text!;

          const result = await apiFetch<{ id: string }>('/messages', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return result.id;
        } catch (err) {
          log.error('webex-poll: deliver failed', { platformId, err });
          return undefined;
        }
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const { items: rooms } = await apiFetch<{ items: WebexRoom[] }>('/rooms?sortBy=lastactivity&max=100');
          return rooms.map((room) => ({
            platformId: `webex-poll:${room.id}`,
            name: room.title,
            isGroup: room.type === 'group',
          }));
        } catch (err) {
          log.warn('webex-poll: syncConversations error', { err });
          return [];
        }
      },
    };

    return adapter;
  },
  defaults: WEBEX_POLL_DEFAULTS,
});
