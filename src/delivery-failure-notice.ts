/**
 * Tell the agent when one of its messages could not be delivered.
 *
 * After MAX_DELIVERY_ATTEMPTS the delivery loop marks the outbound row failed
 * in the session DB, but the agent never learns about it and believes the
 * message was sent ("sent — check the DM") while the user never sees it. This
 * writes a system note into the session's inbound mailbox and wakes the
 * container so the agent knows.
 *
 * Bounded so a destination that fails every send can't loop
 * (note → wake → agent sends there again → fails → note):
 *   - no note for a message that answers a delivery-failure note;
 *   - at most NOTE_CAP notes per session and destination within NOTE_WINDOW_MS.
 *
 * The note names a fixed reason category, never the remote error text: that
 * text comes from the platform and would otherwise be read as a system
 * instruction. The full error stays in the host log.
 */
import { MissingChannelAdapterError } from './channels/channel-registry.js';
import { DeliveryTargetError } from './delivery-error.js';
import { log } from './log.js';
import type { OutboundMessage } from './mailbox/index.js';
import { notifyAgent } from './modules/approvals/primitive.js';
import type { Session } from './types.js';

const PREVIEW_CHARS = 120;
const NOTE_ID_PREFIX = 'delivery-failed-';
export const NOTE_CAP = 3;
export const NOTE_WINDOW_MS = 10 * 60 * 1000;

export type DeliveryFailureCategory = 'not_connected' | 'rejected' | 'not_authorised' | 'other';

const CATEGORY_TEXT: Record<DeliveryFailureCategory, string> = {
  not_connected: 'the destination is not connected (unknown chat, bot removed, or channel adapter not running)',
  rejected: 'the platform rejected it',
  not_authorised: 'this agent is not authorised to send there',
  other: 'an unexpected error',
};

/** Rows the agent did not author as a user-visible message: no notice. */
export function shouldNoticeDeliveryFailure(msg: Pick<OutboundMessage, 'kind' | 'inReplyTo'>): boolean {
  if (msg.kind === 'system' || msg.kind === 'task_log') return false;
  // The agent's answer to a failure note failed too: stop here.
  if (msg.inReplyTo?.startsWith(NOTE_ID_PREFIX)) return false;
  return true;
}

export function classifyDeliveryFailure(
  msg: Pick<OutboundMessage, 'channelType'>,
  err: unknown,
): DeliveryFailureCategory {
  if (err instanceof DeliveryTargetError) return err.reason;
  if (err instanceof MissingChannelAdapterError) return 'not_connected';
  // Agent-to-agent routing has no platform behind it.
  if (err instanceof Error && msg.channelType !== 'agent') return 'rejected';
  return 'other';
}

export function deliveryFailureText(
  msg: Pick<OutboundMessage, 'id' | 'content' | 'channelType'>,
  category: DeliveryFailureCategory,
): string {
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

  return (
    `Delivery failed: your message${where} (${what}) was NOT delivered after several attempts. ` +
    `Reason: ${CATEGORY_TEXT[category]}. The host log has the details (message ${msg.id}). ` +
    `Further sends to this destination are likely to fail as well: do not resend there.`
  );
}

/** Recent note times per `${sessionId}|${channelType}|${platformId}`. */
const recentNotes = new Map<string, number[]>();

function takeNoteSlot(key: string, now: number): boolean {
  const recent = (recentNotes.get(key) ?? []).filter((t) => now - t < NOTE_WINDOW_MS);
  if (recent.length >= NOTE_CAP) {
    recentNotes.set(key, recent);
    return false;
  }
  recent.push(now);
  recentNotes.set(key, recent);
  return true;
}

/** Test seam. */
export function resetDeliveryFailureNoticeState(): void {
  recentNotes.clear();
}

export async function noticeDeliveryFailure(msg: OutboundMessage, session: Session, err: unknown): Promise<void> {
  if (!shouldNoticeDeliveryFailure(msg)) return;
  const destination = `${session.id}|${msg.channelType ?? ''}|${msg.platformId ?? ''}`;
  if (!takeNoteSlot(destination, Date.now())) {
    log.warn('Delivery failure notice suppressed: too many for this destination', {
      messageId: msg.id,
      sessionId: session.id,
      channelType: msg.channelType,
      platformId: msg.platformId,
    });
    return;
  }
  try {
    await notifyAgent(session, deliveryFailureText(msg, classifyDeliveryFailure(msg, err)), {
      id: `${NOTE_ID_PREFIX}${msg.id}`,
    });
  } catch (noticeErr) {
    log.warn('Failed to notify agent of delivery failure', {
      messageId: msg.id,
      sessionId: session.id,
      err: noticeErr,
    });
  }
}
