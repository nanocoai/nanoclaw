/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with an inbound
 * interceptor for setup pairing and the owner/global-admin `/connect_group` command.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner, isGlobalAdmin, isOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Dedicated bot identity, non-threaded platform (supportsThreads:false), so
 * group engagement can never be sticky-per-thread — 'mention' keeps a group
 * wiring from staying engaged forever in the single shared session.
 */
const TELEGRAM_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const text = 'text' in message.content && typeof message.content.text === 'string' ? message.content.text : '';
  const author = 'author' in message.content ? message.content.author : null;
  const authorUserId =
    author && typeof author === 'object' && 'userId' in author && typeof author.userId === 'string'
      ? author.userId
      : null;
  return { text, authorUserId };
}

/**
 * `/connect_group` only opens Telegram's native picker. The existing
 * unknown-channel approval flow remains the authority that creates a wiring.
 */
function isConnectGroupCommand(text: string, botUsername: string | null): boolean {
  const command = text.trim().toLowerCase();
  return (
    command === '/connect_group' || (botUsername !== null && command === `/connect_group@${botUsername.toLowerCase()}`)
  );
}

function isStartGroupConnectCommand(text: string, botUsername: string | null): boolean {
  return botUsername !== null && text.trim().toLowerCase() === `/start@${botUsername.toLowerCase()} connect`;
}

function withInboundText(message: InboundMessage, text: string): InboundMessage {
  if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content)) return message;
  return { ...message, content: { ...message.content, text } };
}

async function sendTelegramMessage(token: string, platformId: string, body: Record<string, unknown>): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      log.warn('Telegram sendMessage non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram sendMessage failed', { err });
  }
}

function sendConnectGroupReply(token: string, platformId: string, text: string, botUsername?: string): Promise<void> {
  return sendTelegramMessage(token, platformId, {
    text,
    ...(botUsername
      ? {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Add me to a group',
                  url: `https://t.me/${encodeURIComponent(botUsername)}?startgroup=connect`,
                },
              ],
            ],
          },
        }
      : {}),
  });
}

async function handleConnectGroupCommand(
  token: string,
  platformId: string,
  authorUserId: string | null,
  knownBotUsername: string | null,
): Promise<string | null> {
  const userId = authorUserId ? `telegram:${authorUserId}` : null;
  const isAuthorized = userId ? (await isOwner(userId)) || (await isGlobalAdmin(userId)) : false;

  if (!isAuthorized) {
    log.warn('Telegram connect-group command denied', { userId, platformId });
    await sendConnectGroupReply(token, platformId, 'Only a NanoClaw owner or global admin can connect a group.');
    return null;
  }

  // Startup's best-effort lookup may have failed transiently. Retry only when
  // this command actually needs the username; normal inbound stays unchanged.
  const botUsername = knownBotUsername ?? (await fetchBotUsername(token));
  if (!botUsername) {
    await sendConnectGroupReply(
      token,
      platformId,
      "I couldn't open Telegram's group picker right now. Please try /connect_group again.",
    );
    return null;
  }

  await sendConnectGroupReply(
    token,
    platformId,
    'First, make sure Group Privacy is off in BotFather (changing it requires removing and re-adding me). Then choose a group below and approve the registration card when it arrives.',
    botUsername,
  );
  return botUsername;
}

/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  await sendTelegramMessage(token, platformId, {
    text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
  });
}

export function createTelegramInboundInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    const { text, authorUserId } = readInboundFields(message);
    const botUsername = await botUsernamePromise;

    if (!isGroupPlatformId(platformId) && isConnectGroupCommand(text, botUsername)) {
      try {
        const resolvedBotUsername = await handleConnectGroupCommand(token, platformId, authorUserId, botUsername);
        if (resolvedBotUsername) botUsernamePromise = Promise.resolve(resolvedBotUsername);
      } catch (err) {
        // A recognized host command is consumed even when authorization or DB
        // access fails; forwarding it would turn a denied control action into
        // an ordinary agent prompt.
        log.error('Telegram connect-group command failed', { err, platformId, authorUserId });
      }
      return;
    }

    if (isGroupPlatformId(platformId) && isStartGroupConnectCommand(text, botUsername)) {
      await hostOnInbound(
        platformId,
        threadId,
        withInboundText(
          message,
          'This Telegram group was just connected. Follow the welcome skill exactly: introduce yourself in this group first, then begin onboarding. Send every response back to this same group.',
        ),
      );
      return;
    }

    try {
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = await getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        await updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        await createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          // Same context-appropriate default as router auto-create, so a
          // paired chat behaves like any other telegram messaging group.
          unknown_sender_policy: (consumed.consumed!.isGroup ? TELEGRAM_DEFAULTS.group : TELEGRAM_DEFAULTS.dm)
            .unknownSenderPolicy,
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      await upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!(await hasAnyOwner())) {
        await grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
      longPolling: {
        // Telegram persists allowed_updates server-side per bot token: if it
        // is ever omitted, "the previous setting will be used" (Bot API
        // docs). Pinning the full list here means a token that previously
        // polled with a narrower set (e.g. a v1 install) can never silently
        // blackhole update types we depend on, such as channel posts.
        allowedUpdates: [
          'message',
          'edited_message',
          'channel_post',
          'edited_channel_post',
          'callback_query',
        ],
      },
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      defaults: TELEGRAM_DEFAULTS,
      // No transformOutboundText: @chat-adapter/telegram >= 4.29 parses
      // CommonMark and renders escaped MarkdownV2 itself. The legacy-Markdown
      // sanitizer this replaced was written for the old converter and, run in
      // front of the new one, downgraded **bold** to *single-star* — which the
      // adapter then parsed as emphasis and rendered as _italic_.
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createTelegramInboundInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
  defaults: TELEGRAM_DEFAULTS,
});
