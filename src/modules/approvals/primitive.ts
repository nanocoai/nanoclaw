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
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** Two-button approval UI — the only options the primitive supports today. */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
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
 * Operator-set channel that always wins over the origin-channel heuristic.
 * When set, approvals are routed there regardless of where the agent is being
 * driven from. Empty string = no preference, fall back to origin matching.
 *
 * Read once at module load; changes require a host restart (same as every
 * other env-driven config in nanoclaw).
 */
const PREFERRED_CHANNEL = (readEnvFile(['APPROVAL_PREFERRED_CHANNEL']).APPROVAL_PREFERRED_CHANNEL ?? '')
  .trim()
  .toLowerCase();

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break order:
 *   1. Operator-pinned `APPROVAL_PREFERRED_CHANNEL` (if set) — useful when the
 *      operator drives the agent from one channel but wants approval prompts
 *      on a quieter one (e.g. WhatsApp for work, Telegram for approvals).
 *   2. Same channel kind as the inbound origin.
 *   3. First approver with any reachable DM.
 *
 * Resolution uses ensureUserDm, which may trigger a platform openDM call on
 * cache miss.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (PREFERRED_CHANNEL) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== PREFERRED_CHANNEL) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
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
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName } = opts;

  const approvers = pickApprover(session.agent_group_id);
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
