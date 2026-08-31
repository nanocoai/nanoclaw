/**
 * Telegram quick-reply MCP tools: send_quick_replies, clear_quick_replies.
 *
 * Both are non-blocking. They write a `system` row that the host turns into a
 * Bot API call carrying a reply keyboard; the user's tap comes back as an
 * ordinary inbound message, so the agent ends its turn instead of holding the
 * container open the way `ask_user_question` does.
 *
 * Destinations resolve through the same public helpers `core.ts` uses, so this
 * file needs no reach-in there: the agent can only address destinations the
 * host already put in its routing table.
 */
import { findByName, getAllDestinations } from '../destinations.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  return (
    getAllDestinations()
      .map((d) => d.name)
      .join(', ') || '(none)'
  );
}

/**
 * Resolve a named destination to its Telegram routing tuple.
 *
 * Refuses non-Telegram channels here rather than letting the host drop the row
 * silently: an agent that asks WhatsApp for a reply keyboard should be told so
 * in the tool result, while it can still act on it.
 */
function resolveTelegram(to: string): { channelType: string; platformId: string; threadId: string | null } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type !== 'channel' || !dest.channelType || !dest.platformId) {
    return { error: `"${to}" is not a chat destination` };
  }
  if (dest.channelType !== 'telegram' && !dest.channelType.startsWith('telegram-')) {
    return { error: `quick replies are a Telegram feature; "${to}" is on ${dest.channelType}. Use ask_user_question there.` };
  }
  // Preserve the thread only when the destination is the conversation this
  // session is bound to — same rule core.ts applies to send_message.
  const session = getSessionRouting();
  const threadId =
    session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
  return { channelType: dest.channelType, platformId: dest.platformId, threadId };
}

export const sendQuickReplies: McpToolDefinition = {
  tool: {
    name: 'send_quick_replies',
    description:
      'Telegram only. Send a message with tappable answer buttons shown above the user keyboard. Non-blocking: this returns immediately and the tap arrives later as an ordinary message from the user, so end your turn after calling it. Use this instead of ask_user_question when you do not need to block. An option may also request the user share their phone number or location (private chats only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name (the same one you send_message to).' },
        text: { type: 'string', description: 'The message shown above the buttons.' },
        options: {
          type: 'array',
          description:
            'The buttons. Each entry is a label string, or { label, request } where request is "contact" (ask for their phone number) or "location" (ask for their location). Requests work in private chats only.',
          items: { type: ['string', 'object'] },
        },
        columns: { type: 'number', description: 'Buttons per row. Default 2.' },
        persist: {
          type: 'boolean',
          description: 'Keep the buttons visible after a tap. Default false — they disappear once used.',
        },
      },
      required: ['to', 'text', 'options'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    const options = args.options as unknown[];
    if (!to) return err('to (the destination name) is required');
    if (!text || !text.trim()) return err('text is required — it is the message shown above the buttons');
    if (!Array.isArray(options) || options.length === 0) return err('options must be a non-empty array');

    const routing = resolveTelegram(to);
    if ('error' in routing) return err(routing.error);

    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'telegram_quick_replies',
        channelType: routing.channelType,
        platformId: routing.platformId,
        threadId: routing.threadId,
        text,
        options,
        ...(typeof args.columns === 'number' ? { columns: args.columns } : {}),
        ...(args.persist === true ? { persist: true } : {}),
      }),
    });

    log(`send_quick_replies: ${options.length} option(s) -> ${routing.platformId}`);
    return ok(
      `Sent with ${options.length} quick-reply button(s) to "${to}". The user's tap arrives as a normal message — end your turn and wait for it.`,
    );
  },
};

export const clearQuickReplies: McpToolDefinition = {
  tool: {
    name: 'clear_quick_replies',
    description:
      'Telegram only. Take away quick-reply buttons left open by a previous send_quick_replies with persist=true. Sends a short message to carry the removal.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name the buttons are showing in.' },
        text: { type: 'string', description: 'Message to send alongside the removal. Default "Done.".' },
      },
      required: ['to'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    if (!to) return err('to (the destination name) is required');

    const routing = resolveTelegram(to);
    if ('error' in routing) return err(routing.error);

    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'telegram_clear_quick_replies',
        channelType: routing.channelType,
        platformId: routing.platformId,
        threadId: routing.threadId,
        ...(typeof args.text === 'string' && args.text.trim() ? { text: args.text } : {}),
      }),
    });

    log(`clear_quick_replies -> ${routing.platformId}`);
    return ok(`Quick-reply buttons removed in "${to}".`);
  },
};

registerTools([sendQuickReplies, clearQuickReplies]);
