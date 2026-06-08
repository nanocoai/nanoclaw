/**
 * OneCLI manual-approval handler.
 *
 * When the OneCLI gateway intercepts a credentialed request that needs human
 * approval, it holds the HTTP connection open and fires our `configureManualApproval`
 * callback. We:
 *   1. Deliver an ask_question card to the admin channel (same routing as
 *      `requestApproval()` — global admin agent group's first messaging group).
 *   2. Persist a `pending_approvals` row (action='onecli_credential') so we can
 *      edit the card on expiry and sweep stale rows at startup.
 *   3. Wait on an in-memory Promise: resolved by the admin click
 *      (`resolveOneCLIApproval`) or by a local expiry timer.
 *   4. On expiry, edit the card to "Expired" and return 'deny' — the gateway's
 *      HTTP side will have already closed, but we need to release the Promise
 *      so the SDK callback returns cleanly.
 *
 * Startup sweep edits any leftover cards from a previous process to
 * "Expired (host restarted)" and drops the rows.
 */
import { randomBytes } from 'node:crypto';

import { OneCLI, type ApprovalRequest, type ManualApprovalHandle } from '@onecli-sh/sdk';

import { pickApprovalDelivery, pickApprover } from './primitive.js';
import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApprovalsByAction,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';

export const ONECLI_ACTION = 'onecli_credential';

type Decision = 'approve' | 'deny';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

interface PendingState {
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingState>();
let handle: ManualApprovalHandle | null = null;
let adapterRef: ChannelDeliveryAdapter | null = null;

/**
 * Generate a short approval id for card buttons.
 *
 * Constraints:
 *   - This id IS the secret. The Chat SDK callback's `actionId` is what
 *     the click resolves against (`resolveOneCLIApproval`). Anyone who can
 *     guess a pending id can approve a credentialed action they shouldn't
 *     be able to. Use a CSPRNG, not Math.random.
 *   - Telegram's callback_data is hard-capped at 64 bytes. The Chat SDK
 *     wraps the id as `chat:{"a":"<id>","v":"<value>"}`, so the budget is
 *     ~64 - 25 (wrapper) - 7 (max value `approve`) = 32 bytes for the id.
 *     A full UUID-with-dashes (36 chars + `oa-` prefix = 39) would not fit.
 *
 * Resolution: 16 random bytes encoded as base64url = 22 chars + `oa-` prefix
 * = 25-char id. 128 bits of entropy, well inside the callback_data budget.
 *
 * The OneCLI native request.id (a UUID) is still kept in the persisted
 * payload for audit; the short id is only the lookup key for the in-memory
 * pending map and the Telegram button.
 */
export function shortApprovalId(): string {
  return `oa-${randomBytes(16).toString('base64url')}`;
}

/** Called from the approvals response handler when a card button is clicked. */
export function resolveOneCLIApproval(approvalId: string, selectedOption: string): boolean {
  const state = pending.get(approvalId);
  if (!state) return false;
  pending.delete(approvalId);
  clearTimeout(state.timer);

  const decision: Decision = selectedOption === 'approve' ? 'approve' : 'deny';
  updatePendingApprovalStatus(approvalId, decision === 'approve' ? 'approved' : 'rejected');
  // Card is auto-edited to "✅ <option>" by chat-sdk-bridge's onAction handler,
  // so we don't need to deliver an edit here.
  deletePendingApproval(approvalId);

  state.resolve(decision);
  log.info('OneCLI approval resolved', { approvalId, decision });
  return true;
}

export function startOneCLIApprovalHandler(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (handle) return;
  adapterRef = deliveryAdapter;

  // Sweep any rows left over from a previous process.
  sweepStaleApprovals().catch((err) => log.error('OneCLI approval sweep failed', { err }));

  handle = onecli.configureManualApproval(async (request: ApprovalRequest): Promise<Decision> => {
    try {
      return await handleRequest(request);
    } catch (err) {
      log.error('OneCLI approval handler errored', { id: request.id, err });
      return 'deny';
    }
  });
  log.info('OneCLI approval handler started');
}

export function stopOneCLIApprovalHandler(): void {
  handle?.stop();
  handle = null;
  for (const state of pending.values()) {
    clearTimeout(state.timer);
  }
  pending.clear();
  adapterRef = null;
}

async function handleRequest(request: ApprovalRequest): Promise<Decision> {
  if (!adapterRef) return 'deny';

  // Originating agent group is carried on the request via OneCLI's agent
  // identifier (set by container-runner.ts to agentGroup.id). Use it as
  // the scope for approver selection: admin @ group → global admin → owner.
  const originGroup = request.agent.externalId ? getAgentGroup(request.agent.externalId) : undefined;
  const agentGroupId = originGroup?.id ?? null;
  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('OneCLI approval auto-denied: no eligible approver', {
      id: request.id,
      host: request.host,
      agent: request.agent.externalId,
    });
    return 'deny';
  }

  // No origin channel preference — OneCLI requests don't carry one. First
  // approver with a reachable DM wins.
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.warn('OneCLI approval auto-denied: no DM channel for any approver', {
      id: request.id,
      approvers,
    });
    return 'deny';
  }

  // Use a short id for the card/button so Chat SDK's Telegram adapter can
  // fit everything inside the 64-byte callback_data limit. The OneCLI
  // request.id stays in the payload for audit.
  const approvalId = shortApprovalId();
  const question = buildQuestion(request, originGroup?.name ?? request.agent.name);

  const onecliTitle = 'Credentials Request';
  const onecliOptions = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  ];
  let platformMessageId: string | undefined;
  try {
    platformMessageId = await adapterRef.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title: onecliTitle,
        question,
        options: onecliOptions,
      }),
    );
  } catch (err) {
    log.error('Failed to deliver OneCLI approval card', { approvalId, oneCliRequestId: request.id, err });
    return 'deny';
  }

  createPendingApproval({
    approval_id: approvalId,
    session_id: null,
    request_id: request.id,
    action: ONECLI_ACTION,
    payload: JSON.stringify({
      oneCliRequestId: request.id,
      method: request.method,
      host: request.host,
      path: request.path,
      bodyPreview: request.bodyPreview,
      agent: request.agent,
      approver: target.userId,
    }),
    created_at: new Date().toISOString(),
    agent_group_id: agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: platformMessageId ?? null,
    expires_at: request.expiresAt,
    status: 'pending',
    title: onecliTitle,
    options_json: JSON.stringify(onecliOptions),
  });

  // Expiry timer fires just before the gateway's own TTL so our decision lands
  // in time to be recorded, even though the HTTP side will already be closing.
  const expiresAtMs = new Date(request.expiresAt).getTime();
  const timeoutMs = Math.max(1000, expiresAtMs - Date.now() - 1000);

  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(approvalId)) return;
      pending.delete(approvalId);
      expireApproval(approvalId, 'no response').catch((err) =>
        log.error('Failed to mark OneCLI approval expired', { approvalId, err }),
      );
      resolve('deny');
    }, timeoutMs);

    pending.set(approvalId, { resolve, timer });
  });
}

async function expireApproval(approvalId: string, reason: string): Promise<void> {
  const rows = getPendingApprovalsByAction(ONECLI_ACTION).filter((r) => r.approval_id === approvalId);
  const row = rows[0];
  if (!row) return;

  updatePendingApprovalStatus(approvalId, 'expired');
  await editCardExpired(row, reason);
  deletePendingApproval(approvalId);
  log.info('OneCLI approval expired', { approvalId, reason });
}

async function editCardExpired(row: PendingApproval, reason: string): Promise<void> {
  if (!adapterRef || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  try {
    await adapterRef.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: `Expired (${reason})`,
      }),
    );
  } catch (err) {
    log.warn('Failed to edit expired OneCLI approval card', { approvalId: row.approval_id, err });
  }
}

async function sweepStaleApprovals(): Promise<void> {
  const rows = getPendingApprovalsByAction(ONECLI_ACTION);
  if (rows.length === 0) return;
  log.info('Sweeping stale OneCLI approvals from previous process', { count: rows.length });
  for (const row of rows) {
    await editCardExpired(row, 'host restarted');
    deletePendingApproval(row.approval_id);
  }
}

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [
    'Credential access request',
    `Agent: ${agentName}`,
    '```',
    `${request.method} ${request.host}${request.path}`,
    '```',
  ];
  if (request.bodyPreview) {
    lines.push('Body:', '```', request.bodyPreview, '```');
  }
  return lines.join('\n');
}
