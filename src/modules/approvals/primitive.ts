/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, PendingApproval, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/**
 * Card value for the "Reject with reason…" button. Selecting it doesn't
 * finalize the reject — it holds the row and captures the approver's next DM
 * as a one-line reason relayed to the requesting agent. See reason-capture.ts.
 */
export const REJECT_WITH_REASON_VALUE = 'reject_with_reason';

/**
 * Three-button approval UI. Plain Reject is the instant fast path; "Reject with
 * reason…" opts into the reason-capture flow. Shared by every module approval
 * (create_agent, install_packages, add_mcp_server); OneCLI credential cards
 * keep their own two-button set in onecli-approvals.ts.
 */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: REJECT_WITH_REASON_VALUE },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Approval-resolved callbacks ──
// Modules that want to observe approval resolution (any action, approve or
// reject) register here at import time. The response handler fires every
// registered callback after the admin's decision is applied — e.g. a module
// clearing an "awaiting approval" status indicator it set when the card went
// out. Callback errors are logged and isolated; they never block resolution.
//
// Only authorized clicks resolve an approval (the response handler's
// isAuthorizedApprovalClick gate runs first), so callbacks never fire for
// unauthorized responses.

export interface ApprovalResolvedEvent {
  approval: PendingApproval;
  session: Session;
  outcome: 'approve' | 'reject';
  /** Namespaced user ID (`<channel>:<handle>`) of the resolving admin. Empty string if unknown. */
  userId: string;
}

export type ApprovalResolvedHandler = (event: ApprovalResolvedEvent) => Promise<void> | void;

const approvalResolvedHandlers: ApprovalResolvedHandler[] = [];

export function registerApprovalResolvedHandler(handler: ApprovalResolvedHandler): void {
  approvalResolvedHandlers.push(handler);
}

/** Fire every registered approval-resolved callback. Called by the response handler. */
export async function notifyApprovalResolved(event: ApprovalResolvedEvent): Promise<void> {
  for (const handler of approvalResolvedHandlers) {
    try {
      await handler(event);
      // eslint-disable-next-line no-catch-all/no-catch-all -- isolation is the contract: one bad callback must not block resolution or other callbacks
    } catch (err) {
      log.error('Approval-resolved handler threw', {
        approvalId: event.approval.approval_id,
        action: event.approval.action,
        outcome: event.outcome,
        err,
      });
    }
  }
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list. Resolution uses ensureUserDm, which may
 * trigger a platform openDM call on cache miss.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
  /** Deliver the card to this specific user instead of all of the session group's admins. */
  approverUserId?: string;
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName, approverUserId } = opts;

  const approvers = approverUserId ? [approverUserId] : pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
    approver_user_id: approverUserId ?? null,
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
}
