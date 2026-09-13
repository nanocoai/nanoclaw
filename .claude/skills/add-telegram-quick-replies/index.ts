/**
 * Telegram quick replies — tappable answer buttons the user can hit instead of
 * typing, driven by Telegram's reply keyboard.
 *
 * NanoClaw can already put buttons on a card (`ask_user_question`), but that
 * path is inline-keyboard only and blocking: the container stays open polling
 * for the click. A reply keyboard is the other half of Telegram's model and
 * costs nothing to wait on — the tap arrives as an ordinary text message, so
 * the agent offers options, ends its turn, and is woken by the answer like any
 * other message. It is also the only way to ask Telegram for a contact or a
 * location.
 *
 * The Chat SDK adapter emits inline keyboards only and has no raw-API seam, so
 * this module calls the Bot API directly, the same way the Telegram channel's
 * own connect-group prompt does.
 *
 * Registered as two delivery actions; the container tools that write the rows
 * live in container/agent-runner/src/mcp-tools/telegram-keyboard.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { unguarded } from '../../guard/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import {
  buildQuickReplyMarkup,
  buildRemoveMarkup,
  normalizeOption,
  QuickReplyError,
  tokenEnvKey,
  type ReplyMarkup,
} from './keyboard.js';

/**
 * Resolve the destination and prove this session is allowed to address it.
 *
 * The container picks the destination by name out of the routing table the
 * host gave it, so it cannot invent a chat id — but this row reaches the Bot
 * API directly, around the delivery path's own destination handling, so the
 * wiring is re-checked here rather than assumed. An agent that is not wired to
 * the group does not get to put a keyboard in it.
 */
async function resolveTarget(
  content: Record<string, unknown>,
  session: Session,
): Promise<{ token: string; chatId: string; isGroup: boolean } | null> {
  const channelType = typeof content.channelType === 'string' ? content.channelType : '';
  const platformId = typeof content.platformId === 'string' ? content.platformId : '';
  if (!channelType || !platformId) {
    log.warn('Telegram quick replies: row missing channelType/platformId', { sessionId: session.id });
    return null;
  }

  const envKey = tokenEnvKey(channelType);
  if (!envKey) {
    log.warn('Telegram quick replies: not a Telegram channel', { channelType, sessionId: session.id });
    return null;
  }

  const mg = await getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) {
    log.warn('Telegram quick replies: unknown messaging group', { channelType, platformId });
    return null;
  }

  const agents = await getMessagingGroupAgents(mg.id);
  if (!agents.some((a) => a.agent_group_id === session.agent_group_id)) {
    log.warn('Telegram quick replies: agent is not wired to this group — refusing', {
      agentGroupId: session.agent_group_id,
      messagingGroupId: mg.id,
    });
    return null;
  }

  const token = readEnvFile([envKey])[envKey];
  if (!token) {
    log.warn('Telegram quick replies: no bot token', { envKey });
    return null;
  }

  // platform ids are `telegram:<chat id>`; the id itself may contain a colon.
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) {
    log.warn('Telegram quick replies: malformed platform id', { platformId });
    return null;
  }

  return { token, chatId, isGroup: mg.is_group === 1 };
}

/** One Bot API sendMessage carrying the markup. Never throws. */
async function sendWithMarkup(
  token: string,
  chatId: string,
  text: string,
  replyMarkup: ReplyMarkup,
  threadId: string | null,
): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(threadId ? { message_thread_id: Number(threadId) } : {}),
        reply_markup: replyMarkup,
      }),
    });
    if (!res.ok) {
      log.warn('Telegram quick replies: sendMessage non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram quick replies: sendMessage failed', { err });
  }
}

function threadOf(content: Record<string, unknown>): string | null {
  return typeof content.threadId === 'string' && content.threadId ? content.threadId : null;
}

registerDeliveryAction(
  'telegram_quick_replies',
  async (content, session) => {
    const target = await resolveTarget(content, session);
    if (!target) return;

    const text = typeof content.text === 'string' ? content.text : '';
    if (!text.trim()) {
      log.warn('Telegram quick replies: empty text', { sessionId: session.id });
      return;
    }

    let markup: ReplyMarkup;
    try {
      const options = (Array.isArray(content.options) ? content.options : []).map(normalizeOption);
      markup = buildQuickReplyMarkup(
        {
          options,
          columns: typeof content.columns === 'number' ? content.columns : undefined,
          persist: content.persist === true,
          selective: content.selective !== false,
        },
        target.isGroup,
      );
    } catch (err) {
      // A malformed keyboard is the agent's mistake, not an outage: log it
      // with the reason and drop the row rather than retrying forever.
      if (err instanceof QuickReplyError) {
        log.warn('Telegram quick replies: rejected', { reason: err.message, sessionId: session.id });
        return;
      }
      throw err;
    }

    await sendWithMarkup(target.token, target.chatId, text, markup, threadOf(content));
    log.info('Telegram quick replies sent', { sessionId: session.id, chatId: target.chatId });
  },
  unguarded('sends only to a group the session agent is already wired to; same reach as send_message'),
);

registerDeliveryAction(
  'telegram_clear_quick_replies',
  async (content, session) => {
    const target = await resolveTarget(content, session);
    if (!target) return;
    const text = typeof content.text === 'string' && content.text.trim() ? content.text : 'Done.';
    await sendWithMarkup(
      target.token,
      target.chatId,
      text,
      buildRemoveMarkup(content.selective !== false, target.isGroup),
      threadOf(content),
    );
    log.info('Telegram quick replies cleared', { sessionId: session.id, chatId: target.chatId });
  },
  unguarded('removes a keyboard from a group the session agent is already wired to'),
);
