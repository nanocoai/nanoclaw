/**
 * "Reject with reason…" capture flow.
 *
 * When an admin clicks the third approval button, the reject is held instead of
 * finalized: the row is parked at status='awaiting_reason' and the admin is
 * prompted in their DM for a one-line reason. Their next DM (≤ 280 chars) is
 * captured by a router message-interceptor and relayed to the requesting agent
 * as one combined message — `Your <action> request was rejected by admin:
 * "<reason>"`. A plain Reject never arms this, so an unrelated DM is never
 * swallowed.
 *
 * Restart-safety: arming lives in an in-memory map (lost on restart, like the
 * agent-naming capture it mirrors), but the hold is a durable DB row. If the
 * admin never replies — or the host restarts mid-capture — the host sweep
 * (sweepAwaitingReasonRejects, run each tick) finalizes a plain reject once the
 * row's window elapses, so the requesting agent is never stranded.
 *
 * Reuses, not reinvents: the agent-naming prompt-then-capture pattern
 * (in-memory map + next-DM interceptor) and the shared finalizeReject path.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import {
  deletePendingApproval,
  findSessionByAgentGroup,
  getExpiredAwaitingReasonApprovals,
  getPendingApproval,
  getSession,
  markApprovalAwaitingReason,
} from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import type { PendingApproval, Session } from '../../types.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { finalizeReject } from './finalize.js';
import { getReasonRejectFinalizer } from './primitive.js';

/** How long an awaiting-reason hold waits for the admin's reply before the sweep finalizes a plain reject. */
const REASON_CAPTURE_WINDOW_MS = 5 * 60 * 1000;
/** Cap on the relayed reason — one cheap guardrail against a wall of text landing in another team's agent context. */
const MAX_REASON_LEN = 280;

const PROMPT_TEXT =
  "Reply with a one-line reason for the rejection — I'll relay it to the agent. " +
  'No reply within ~5 min declines it without a reason.';

interface ReasonArming {
  approvalId: string;
  /** Namespaced id of the admin who clicked, for resolution attribution. */
  userId: string;
}

/**
 * Approvers waiting to type a rejection reason, keyed by their DM channel
 * (`<channelType>:<dmPlatformId>`). A DM's platform id is unique per user, so
 * the inbound reply matches by channel alone — no sender re-parsing needed, and
 * a group message can never collide with an armed DM. Cleared on receipt,
 * staleness, or restart.
 */
const awaitingReason = new Map<string, ReasonArming>();

function dmKey(channelType: string, platformId: string): string {
  return `${channelType}:${platformId}`;
}

function clampReason(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_REASON_LEN) return trimmed;
  return trimmed.slice(0, MAX_REASON_LEN - 1) + '…';
}

function extractText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

/**
 * Begin the reject-with-reason hold for an approval the admin chose not to
 * finalize outright. Prompts the admin's DM, then parks the row and arms
 * capture. If we can't reach the admin (no DM, no adapter, delivery throws) we
 * finalize a plain reject immediately rather than strand the requesting agent.
 */
export async function armReasonCapture(approval: PendingApproval, session: Session, userId: string): Promise<void> {
  const dm = userId ? await ensureUserDm(userId) : null;
  const adapter = getDeliveryAdapter();
  if (!dm || !adapter) {
    log.warn('reject-with-reason: cannot reach approver, finalizing plain reject', {
      approvalId: approval.approval_id,
      userId,
      hasDm: Boolean(dm),
      hasAdapter: Boolean(adapter),
    });
    await finalizeReject(approval, session, userId);
    return;
  }

  try {
    await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text: PROMPT_TEXT }));
  } catch (err) {
    log.error('reject-with-reason: reason prompt delivery failed, finalizing plain reject', {
      approvalId: approval.approval_id,
      err,
    });
    await finalizeReject(approval, session, userId);
    return;
  }

  // Prompt is out — now hold the row and arm capture. Order matters: a reply
  // can't arrive before the prompt is read, so there's no lost-message window.
  const expiresAt = new Date(Date.now() + REASON_CAPTURE_WINDOW_MS).toISOString();
  markApprovalAwaitingReason(approval.approval_id, expiresAt);
  awaitingReason.set(dmKey(dm.channel_type, dm.platform_id), { approvalId: approval.approval_id, userId });
  log.info('reject-with-reason: awaiting reason reply', { approvalId: approval.approval_id, userId });
}

/**
 * Router message-interceptor: capture the next DM from an admin who armed a
 * reason. Returns true (consume the message) when this DM is an armed reason
 * channel and still holds a live row; false otherwise so normal routing runs.
 *
 * Exported for tests; registered as the interceptor below.
 */
export async function captureReasonReply(event: InboundEvent): Promise<boolean> {
  const arming = awaitingReason.get(dmKey(event.channelType, event.platformId));
  if (!arming) return false;

  // This DM is an armed reason channel — disarm regardless of outcome.
  awaitingReason.delete(dmKey(event.channelType, event.platformId));

  const approval = getPendingApproval(arming.approvalId);
  if (!approval || approval.status !== 'awaiting_reason') {
    // Already finalized (e.g. ghosted by the sweep). The reply is no longer a
    // reason — let it route normally instead of swallowing it.
    return false;
  }

  // OneCLI credential rows carry no session_id — fall back to the originating
  // agent group's active session so the reason still reaches the agent.
  const session =
    (approval.session_id ? getSession(approval.session_id) : null) ??
    (approval.agent_group_id ? findSessionByAgentGroup(approval.agent_group_id) : null);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return true;
  }

  const reason = clampReason(extractText(event));
  // Action-specific delivery (e.g. OneCLI injects the reason into the failed
  // tool call); default is the chat-message relay.
  const finalizer = getReasonRejectFinalizer(approval.action) ?? finalizeReject;
  await finalizer(approval, session, arming.userId, reason || undefined);
  log.info('reject-with-reason: reason captured and relayed', {
    approvalId: approval.approval_id,
    hasReason: reason.length > 0,
  });
  return true;
}

registerMessageInterceptor(captureReasonReply);

/**
 * Host-sweep finalizer: any reject-with-reason hold whose window elapsed (admin
 * ghosted, or the host restarted mid-capture and lost the in-memory arming) is
 * finalized as a plain reject. Restart-safe — the hold is a durable row, so the
 * requesting agent always gets its decision. Called once per sweep tick.
 */
export async function sweepAwaitingReasonRejects(): Promise<void> {
  const rows = getExpiredAwaitingReasonApprovals(new Date().toISOString());
  for (const approval of rows) {
    const session =
      (approval.session_id ? getSession(approval.session_id) : null) ??
      (approval.agent_group_id ? findSessionByAgentGroup(approval.agent_group_id) : null);
    if (!session) {
      deletePendingApproval(approval.approval_id);
      continue;
    }
    // Plain reject, unknown resolver — the admin opted in but never typed.
    await finalizeReject(approval, session, '');
    log.info('reject-with-reason: window elapsed, finalized as plain reject', { approvalId: approval.approval_id });
  }
}
