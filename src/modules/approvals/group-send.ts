/**
 * Hard host-side gate for group sends.
 *
 * Policy: the agent never posts into a group chat (is_group=1) without
 * explicit per-message operator approval — including replies to messages
 * that @-mentioned it. Enforced in delivery.ts (the only path from
 * messages_out to a platform adapter), so no container-side behavior,
 * prompt instruction, or MCP tool choice can bypass it.
 *
 * Flow: deliverMessage() detects a group-bound row and calls
 * gateGroupSend() instead of delivering. The row is marked delivered by
 * the normal caller path (so it is never retried); the pending approval
 * carries everything needed to deliver later. On operator approve, the
 * handler below performs the actual adapter delivery.
 */
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { clearOutbox, readOutboxFiles } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from './primitive.js';

export interface GroupSendMessage {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

/** True when this outbound row must be held for operator approval. */
export function shouldGateGroupSend(isGroup: number, channelType: string | null): boolean {
  // channel_type 'agent' (a2a) and system rows never reach this check —
  // deliverMessage returns earlier for them — but keep the guard total so
  // the function is safe to call from anywhere.
  return isGroup === 1 && channelType !== null && channelType !== 'agent';
}

/** Hold a group-bound outbound message behind a per-message operator approval. */
export async function gateGroupSend(msg: GroupSendMessage, session: Session, groupLabel: string): Promise<void> {
  let preview = '';
  try {
    const content = JSON.parse(msg.content) as { text?: string };
    preview = typeof content.text === 'string' ? content.text : msg.content;
  } catch {
    preview = msg.content;
  }
  if (preview.length > 700) preview = `${preview.slice(0, 700)}…`;

  await requestApproval({
    session,
    agentName: session.agent_group_id,
    action: 'group_send',
    payload: {
      message_out_id: msg.id,
      kind: msg.kind,
      channel_type: msg.channel_type,
      platform_id: msg.platform_id,
      thread_id: msg.thread_id,
      content: msg.content,
    },
    title: `Group message → ${groupLabel}`,
    question: `The agent wants to post to the group "${groupLabel}":\n\n${preview}\n\nDeliver it?`,
  });
  log.info('Group send held for operator approval', {
    messageId: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
  });
}

registerApprovalHandler('group_send', async ({ session, payload, notify }) => {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('group_send approved but no delivery adapter is configured');

  const channelType = payload.channel_type as string;
  const platformId = payload.platform_id as string;
  const threadId = (payload.thread_id as string | null) ?? null;
  const kind = payload.kind as string;
  const content = payload.content as string;
  const messageOutId = payload.message_out_id as string;

  let files;
  try {
    const parsed = JSON.parse(content) as { files?: string[] };
    files =
      Array.isArray(parsed.files) && parsed.files.length > 0
        ? readOutboxFiles(session.agent_group_id, session.id, messageOutId, parsed.files)
        : undefined;
  } catch {
    files = undefined;
  }

  await adapter.deliver(channelType, platformId, threadId, kind, content, files);
  clearOutbox(session.agent_group_id, session.id, messageOutId);
  log.info('Approved group message delivered', { messageId: messageOutId, channelType, platformId });
  notify('Your group message was approved by the operator and delivered.');
});
