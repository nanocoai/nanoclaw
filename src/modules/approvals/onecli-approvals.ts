/**
 * Held-request (credential) approval handler.
 *
 * The gateway holds a credentialed request open awaiting a human decision and
 * delivers it through the gateway provider's approvals capability
 * (`GatewayProvider.approvals()` — this module never imports a gateway SDK
 * directly). Per request we:
 *   1. Deliver an ask_question card to the admin channel (same routing as
 *      `requestApproval()`).
 *   2. Persist a `pending_approvals` row (action='onecli_credential') — the
 *      durable, restart-surviving record of the decision being awaited.
 *   3. Wait on an in-memory Promise: resolved by the admin click
 *      (`resolveOneCLIApproval`) or by a local expiry timer.
 *
 * Restart honesty: resolution is ROW-keyed, not map-keyed, so a card from a
 * previous process stays clickable. At startup, surviving rows re-arm: still-
 * open ones stay decidable (a late decision is delivered through the source's
 * `decide` capability when the gateway supports it, and otherwise the card is
 * told the truth — the original request died with the restart and the agent
 * must retry); already-expired ones get an honest timeout edit. A periodic
 * row-driven sweep expires overdue rows, so expiry survives the process that
 * armed the timer. A gateway that redelivers a request we already carded is
 * deduped by request id — never a duplicate card.
 */
import { pickApprovalDelivery, pickApprover } from './primitive.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import {
  getGatewayProvider,
  type GatewayApprovalDecision,
  type GatewayApprovalRequest,
  type GatewayApprovalSource,
  type GatewayApprovalSubscription,
} from '../../gateway-providers/index.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';

export const ONECLI_ACTION = 'onecli_credential';

type Decision = GatewayApprovalDecision;
type ExpiryReason = 'no response' | 'host restarted';

const EXPIRY_SWEEP_MS = 60_000;

interface PendingState {
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingState>();
let subscription: GatewayApprovalSubscription | null = null;
let approvalSource: GatewayApprovalSource | null = null;
let expirySweep: NodeJS.Timeout | null = null;
let adapterRef: ChannelDeliveryAdapter | null = null;
let started = false;

/**
 * Generate a short approval id for card buttons.
 *
 * The gateway's native request.id is a UUID (36 bytes). When we put it into a
 * card button's action id as `ncq:<uuid>:Approve`, Chat SDK's Telegram adapter
 * then serializes both `id` and `value` into the Telegram `callback_data`
 * field, which has a hard 64-byte limit. UUIDs push past that limit.
 *
 * Instead we generate a 10-byte id (`oa-` + 8 base36 chars) for the card, and
 * keep the gateway request.id on the row (`request_id`) for audit and
 * reconnect dedupe. The pending map, DB row, and button callback all use this
 * short id.
 */
function shortApprovalId(): string {
  return `oa-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Called from the approvals response handler when a card button is clicked.
 * Row-keyed: the click works whether or not this process armed the card. A
 * live request resolves its waiting Promise; a re-armed card from a previous
 * process takes the late-decision path.
 */
export async function resolveOneCLIApproval(approvalId: string, selectedOption: string): Promise<boolean> {
  const row = await getPendingApproval(approvalId);
  if (!row || row.action !== ONECLI_ACTION) return false;

  const decision: Decision = selectedOption === 'approve' ? 'approve' : 'deny';
  const claimed = await transitionPendingApprovalStatus(
    approvalId,
    'pending',
    decision === 'approve' ? 'approved' : 'rejected',
  );
  if (!claimed) return false;
  const state = pending.get(approvalId);
  if (state) {
    pending.delete(approvalId);
    clearTimeout(state.timer);
  }
  // Card is auto-edited to "✅ <option>" by chat-sdk-bridge's onAction handler,
  // so the happy path needs no edit here.
  await deletePendingApproval(approvalId);

  if (state) {
    state.resolve(decision);
    log.info('Gateway approval resolved', { approvalId, decision });
    return true;
  }
  await deliverLateDecision(row, decision);
  return true;
}

/**
 * A decision for a request whose waiting callback died with a previous
 * process. Deliver it through the gateway when it can accept one; otherwise
 * an approval must tell the human the truth — the credentialed call is gone
 * and the agent has to retry it.
 */
async function deliverLateDecision(row: PendingApproval, decision: Decision): Promise<void> {
  let delivered = false;
  if (approvalSource?.decide && row.request_id) {
    try {
      delivered = await approvalSource.decide(row.request_id, decision);
    } catch (err) {
      log.warn('Late approval decision not accepted by the gateway', { approvalId: row.approval_id, err });
    }
  }
  if (decision === 'approve' && !delivered) {
    await editCardResolution(
      row,
      '✅ Approved — recorded, but the original request ended when the host restarted. Ask the agent to retry the action.',
    );
  }
  log.info('Gateway approval resolved late', { approvalId: row.approval_id, decision, delivered });
}

export function startOneCLIApprovalHandler(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (started) return;
  started = true;
  adapterRef = deliveryAdapter;
  approvalSource = getGatewayProvider().approvals?.() ?? null;

  reattachSurvivingApprovals().catch((err) => log.error('Approval re-attach failed', { err }));

  if (approvalSource) {
    subscription = approvalSource.subscribe(async (request: GatewayApprovalRequest): Promise<Decision> => {
      try {
        return await handleRequest(request);
      } catch (err) {
        log.error('Gateway approval handler errored', { id: request.id, err });
        return 'deny';
      }
    });
    log.info('Gateway approval handler started');
  } else {
    log.info('Gateway provider exposes no approvals capability — held-request approvals disabled');
  }

  // Row-driven expiry: overdue rows expire on the sweep regardless of which
  // process armed them — a timer that dies with its process is not the record.
  expirySweep = setInterval(() => {
    void expireOverdueApprovals();
  }, EXPIRY_SWEEP_MS);
  expirySweep.unref?.();
}

export function stopOneCLIApprovalHandler(): void {
  subscription?.stop();
  subscription = null;
  approvalSource = null;
  if (expirySweep) {
    clearInterval(expirySweep);
    expirySweep = null;
  }
  for (const state of pending.values()) {
    clearTimeout(state.timer);
  }
  pending.clear();
  adapterRef = null;
  started = false;
}

/** Arm the in-memory Promise for a live request, with its pre-TTL expiry timer. */
function armPendingPromise(approvalId: string, expiresAt: string): Promise<Decision> {
  // Expiry timer fires just before the gateway's own TTL so our decision lands
  // in time to be recorded, even though the HTTP side will already be closing.
  const timeoutMs = Math.max(1000, new Date(expiresAt).getTime() - Date.now() - 1000);
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(approvalId)) return;
      pending.delete(approvalId);
      expireApproval(approvalId, 'no response').catch((err) =>
        log.error('Failed to mark approval expired', { approvalId, err }),
      );
      resolve('deny');
    }, timeoutMs);

    pending.set(approvalId, { resolve, timer });
  });
}

async function handleRequest(request: GatewayApprovalRequest): Promise<Decision> {
  if (!adapterRef) return 'deny';

  // Reconnect dedupe: a gateway that redelivers a request we already carded
  // gets the existing card re-armed — never a duplicate card.
  const existing = (await getPendingApprovalsByAction(ONECLI_ACTION)).find(
    (row) => row.request_id === request.id && row.status === 'pending',
  );
  if (existing && !pending.has(existing.approval_id)) {
    log.info('Re-armed existing card for redelivered approval request', {
      approvalId: existing.approval_id,
      requestId: request.id,
    });
    return armPendingPromise(existing.approval_id, request.expiresAt);
  }

  // Originating agent group is carried on the request via the gateway's agent
  // identifier (set by container-runner.ts to agentGroup.id). Use it as
  // the scope for approver selection: admin @ group → global admin → owner.
  const originGroup = request.agent.externalId ? await getAgentGroup(request.agent.externalId) : undefined;
  const agentGroupId = originGroup?.id ?? null;
  const approvers = await pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Gateway approval auto-denied: no eligible approver', {
      id: request.id,
      host: request.host,
      agent: request.agent.externalId,
    });
    return 'deny';
  }

  // No origin channel preference — held requests don't carry one. First
  // approver with a reachable DM wins.
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.warn('Gateway approval auto-denied: no DM channel for any approver', {
      id: request.id,
      approvers,
    });
    return 'deny';
  }

  const approvalId = shortApprovalId();
  const question = buildQuestion(request, originGroup?.name ?? request.agent.name);

  const cardTitle = 'Credentials Request';
  const cardOptions = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' as const },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' as const },
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
        title: cardTitle,
        question,
        options: cardOptions,
      }),
      undefined,
      // ensureUserDm may resolve the DM through a named instance (its registry
      // lookup falls back across instances of a channel type); dispatch here is
      // exact-key, so the card must be addressed to the instance that owns the
      // conversation or it cannot be posted at all.
      target.messagingGroup.instance,
    );
  } catch (err) {
    log.error('Failed to deliver approval card', { approvalId, requestId: request.id, err });
    return 'deny';
  }

  await createPendingApproval({
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
    instance: target.messagingGroup.instance ?? null,
    platform_message_id: platformMessageId ?? null,
    expires_at: request.expiresAt,
    status: 'pending',
    title: cardTitle,
    question,
    options_json: JSON.stringify(cardOptions),
    // The DM'd approver is the one identity allowed to resolve this card.
    approver_user_id: target.userId,
  });

  return armPendingPromise(approvalId, request.expiresAt);
}

async function expireApproval(approvalId: string, reason: ExpiryReason): Promise<void> {
  const row = await getPendingApproval(approvalId);
  if (!row || row.action !== ONECLI_ACTION) return;

  if (!(await transitionPendingApprovalStatus(approvalId, 'pending', 'expired'))) return;
  await editCardExpired(row, reason);
  await deletePendingApproval(approvalId);
  log.info('Gateway approval expired', { approvalId, reason });
}

/**
 * Re-attach surviving rows after a restart instead of blanket-expiring them:
 * a still-open row stays decidable (resolution is row-keyed), an overdue one
 * gets an honest timeout. When the gateway can enumerate its held requests,
 * record whether each survivor is still live gateway-side.
 */
async function reattachSurvivingApprovals(): Promise<void> {
  const rows = await getPendingApprovalsByAction(ONECLI_ACTION);
  if (rows.length === 0) return;

  let heldAtGateway: Set<string> | null = null;
  if (approvalSource?.listPending) {
    try {
      heldAtGateway = new Set((await approvalSource.listPending()).map((request) => request.id));
    } catch (err) {
      log.warn('Gateway pending-approvals listing failed during re-attach', { err });
    }
  }

  let rearmed = 0;
  let expired = 0;
  for (const row of rows) {
    const stillOpen = row.expires_at !== null && new Date(row.expires_at).getTime() > Date.now();
    if (!stillOpen) {
      await expireApproval(row.approval_id, 'no response');
      expired += 1;
      continue;
    }
    rearmed += 1;
    log.info('Re-armed approval from previous process', {
      approvalId: row.approval_id,
      heldAtGateway: heldAtGateway ? heldAtGateway.has(row.request_id ?? '') : null,
    });
  }
  log.info('Approval re-attach complete', { rearmed, expired });
}

/** Row-driven expiry sweep: overdue rows expire regardless of which process armed them. */
async function expireOverdueApprovals(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the sweep must survive any single row's failure */
  try {
    const rows = await getPendingApprovalsByAction(ONECLI_ACTION);
    for (const row of rows) {
      if (row.expires_at !== null && new Date(row.expires_at).getTime() > Date.now()) continue;
      // Live requests have their own pre-TTL timer; the sweep owns the rest.
      if (pending.has(row.approval_id)) continue;
      await expireApproval(row.approval_id, 'no response');
    }
  } catch (err) {
    log.warn('Approval expiry sweep failed', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Exported for tests — the sweep and the expiry timer are its only callers. */
export async function editCardExpired(row: PendingApproval, reason: ExpiryReason): Promise<void> {
  const resolution =
    reason === 'no response' ? '⏱️ Timed out — no response' : '⏱️ Timed out — host restarted before resolution';
  await editCardResolution(row, resolution);
}

async function editCardResolution(row: PendingApproval, resolution: string): Promise<void> {
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
        // Native adapters that cannot edit rich cards treat this as a
        // terminal follow-up; Chat SDK adapters prefer terminalCard below.
        text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
        terminalCard: {
          title: row.title,
          question: row.question,
          resolution,
        },
      }),
      undefined,
      // Dispatch is exact-key: editing through the bare channel type finds no
      // adapter at all on an install whose bots are all named instances.
      row.instance ?? row.channel_type,
    );
  } catch (err) {
    // Louder than a warn: the row is deleted straight after, so a swallowed
    // failure leaves a card showing live Approve/Reject buttons that resolve
    // nothing, with no other trace that it happened.
    log.error('Failed to edit resolved approval card', { approvalId: row.approval_id, err });
  }
}

/** The hosted gateway's structured request summary: the action being
 *  performed plus labeled fields (To / Subject / Body for email sends). */
const SUMMARY_VALUE_EXCERPT_CHARS = 900;

function buildQuestion(request: GatewayApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* ${agentName}`];

  const summary = request.summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* ${summary.action}`);
    // A render bug here must never decide the request: handleRequest's catch
    // returns 'deny', so stay defensive — coerce non-string values instead of
    // assuming the gateway's shape, and keep the card under Slack's 3000-char
    // section limit or delivery itself fails.
    let budget = 2600;
    for (const { label, value } of summary.details) {
      const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      const cap = Math.min(SUMMARY_VALUE_EXCERPT_CHARS, Math.max(0, budget));
      if (cap === 0) {
        lines.push(`_…${summary.details.length} field(s) omitted for length — see the audit payload._`);
        break;
      }
      const v = raw.length > cap ? `${raw.slice(0, cap)}…` : raw;
      budget -= v.length + String(label).length + 8;
      // Multi-line values (message bodies) read better fenced; short labeled
      // fields (To, Subject) inline.
      if (v.includes('\n')) lines.push(`*${label}:*`, '```', v, '```');
      else lines.push(`*${label}:* ${v}`);
    }
  } else if (request.bodyPreview) {
    lines.push('```', request.bodyPreview.slice(0, SUMMARY_VALUE_EXCERPT_CHARS * 2), '```');
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  } else {
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  }
  return lines.join('\n');
}
