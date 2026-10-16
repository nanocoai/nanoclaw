/**
 * Tell the agent when one of its messages could not be delivered.
 *
 * After MAX_DELIVERY_ATTEMPTS the delivery loop marks the outbound row failed
 * in the session DB, but the agent never learns about it and believes the
 * message was sent ("sent — check the DM") while the user never sees it. This
 * writes a system note into the session's inbound mailbox and wakes the
 * container so the agent can say so.
 */
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import type { OutboundMessage } from './mailbox/index.js';
import { requestWake } from './request-wake.js';
import { writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const PREVIEW_CHARS = 120;

/** Rows the agent did not author as a user-visible message: no notice. */
export function shouldNoticeDeliveryFailure(msg: Pick<OutboundMessage, 'kind'>): boolean {
  return msg.kind !== 'system' && msg.kind !== 'task_log';
}

export function deliveryFailureText(msg: Pick<OutboundMessage, 'content' | 'channelType'>, err: unknown): string {
  let content: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(msg.content);
    if (parsed && typeof parsed === 'object') content = parsed as Record<string, unknown>;
  } catch {
    // Unparseable content: describe it generically below.
  }

  const parts: string[] = [];
  const files = Array.isArray(content.files) ? content.files.filter((f): f is string => typeof f === 'string') : [];
  if (files.length > 0) parts.push(`file${files.length > 1 ? 's' : ''} ${files.join(', ')}`);
  if (typeof content.text === 'string' && content.text.trim()) {
    const text = content.text.trim().replace(/\s+/g, ' ');
    parts.push(`text "${text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}"`);
  }
  if (typeof content.operation === 'string') parts.push(`${content.operation} operation`);
  const what = parts.length > 0 ? parts.join(' with ') : 'a message';
  const where = msg.channelType ? ` to ${msg.channelType}` : '';
  const reason = err instanceof Error ? err.message : String(err);

  return (
    `Delivery failed: your message${where} (${what}) was NOT delivered. ` +
    `The platform rejected it after several attempts: ${reason}. ` +
    `The recipient did not receive it. Tell them it failed and why; ` +
    `do not resend the same thing unless the cause is fixed.`
  );
}

export async function noticeDeliveryFailure(msg: OutboundMessage, session: Session, err: unknown): Promise<void> {
  if (!shouldNoticeDeliveryFailure(msg)) return;
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `delivery-failed-${msg.id}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text: deliveryFailureText(msg, err), sender: 'system', senderId: 'system' }),
    });
    const fresh = await getSession(session.id);
    if (fresh) await requestWake(fresh, 'inbound-message');
  } catch (noticeErr) {
    log.warn('Failed to notify agent of delivery failure', {
      messageId: msg.id,
      sessionId: session.id,
      err: noticeErr,
    });
  }
}
