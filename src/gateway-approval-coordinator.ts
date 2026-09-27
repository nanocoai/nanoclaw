import { gatewayApprovalPresentation } from './gateway-approval-presentation.js';
import { permitsConfiguredGatewayRead } from './gateway-read-policy.js';
import { getContainerConfig } from './db/container-configs.js';
import { getProviderHostContract } from './provider-contracts/index.js';
import { resolveProviderName } from './providers/provider-name.js';
/** Core-owned human approval flow shared by every gateway provider. */
import { createHash, randomBytes } from 'node:crypto';

import { normalizeOptions, type RawOption } from './channels/ask-question.js';
import { INSTALL_SLUG } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createPendingApproval,
  bindPendingApprovalMessage,
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  getSession,
  transitionPendingApprovalStatus,
} from './db/sessions.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import {
  gatewayRuntimeIdentity,
  type GatewayApprovalDecision,
  type GatewayApprovalRequest,
  type GatewayProviderDefinition,
} from './gateway-providers/index.js';
import { log } from './log.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';
import { isAuthorizedApprovalClick } from './modules/approvals/response-handler.js';
import { registerResponseHandler, type ResponsePayload } from './response-registry.js';
import type { PendingApproval } from './types.js';

export const GATEWAY_APPROVAL_ACTION = 'gateway_request';

const OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
];
const MAX_TITLE_CHARS = 200;
const MAX_QUESTION_CHARS = 2_600;
const MAX_AUDIT_BYTES = 8_192;
const MAX_PROVIDER_APPROVAL_MS = 60 * 60_000;
/**
 * A bridge that fails fast — a socket that will not bind, a gateway that is
 * down — rejects well inside this window. One that is still running after it
 * has demonstrably reached its provider, so admission may reopen.
 */
const SUBSCRIPTION_READY_MS = 2_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

interface PendingState {
  resolve: (decision: GatewayApprovalDecision) => void;
  timer: NodeJS.Timeout;
  requestKey: string;
  promise: Promise<GatewayApprovalDecision>;
  binding: string;
}

export interface GatewayApprovalCoordinatorOptions {
  waitUntilReady?: boolean;
  timeoutMs?: number;
  maxPending?: number;
  /**
   * Called when a reconnected subscription has stayed up past its fail-fast
   * window. The host reopens session admission here; without it a single
   * blip would close the install for the life of the process.
   */
  onAvailable?: () => void;
}

const pending = new Map<string, PendingState>();
const requestKeys = new Set<string>();
const inFlightRequests = new Map<string, { binding: string; promise: Promise<GatewayApprovalDecision> }>();
let adapter: ChannelDeliveryAdapter | null = null;
let controller: AbortController | null = null;
let subscription: Promise<void> | null = null;
let selectedKind = '';
let startedAt = 0;
let unavailable = false;
let decisionGeneration = 0;
let initialReady: (() => void) | undefined;
let registeredResponseHandler = false;
let timeoutMs = 120_000;
let maxPending = 32;
let reportUnavailable: (reason: string) => void = () => {};
let reportAvailable: () => void = () => {};
let approvalSource: GatewayProviderDefinition['approvals'] | null = null;
let expirySweep: NodeJS.Timeout | null = null;
let healthSource: GatewayProviderDefinition['availability'];
let healthTimer: NodeJS.Timeout | null = null;
let subscriptionHealthy = false;
let healthWrite: Promise<void> = Promise.resolve();
let healthGeneration = 0;
function publishHealth(): Promise<void> {
  if (!healthSource) return Promise.resolve();
  const source = healthSource;
  const generation = healthGeneration;
  healthWrite = healthWrite
    .catch(() => {})
    .then(() => (generation === healthGeneration ? source.publish(subscriptionHealthy) : undefined));
  return healthWrite;
}

export async function startGatewayApprovalCoordinator(
  provider: GatewayProviderDefinition,
  deliveryAdapter: ChannelDeliveryAdapter,
  onUnavailable: (reason: string) => void,
  options: GatewayApprovalCoordinatorOptions = {},
): Promise<void> {
  if (controller) throw new Error('Gateway approval coordinator already started');
  timeoutMs = options.timeoutMs ?? 120_000;
  maxPending = options.maxPending ?? 32;
  adapter = deliveryAdapter;
  healthGeneration++;
  healthSource = provider.availability;
  subscriptionHealthy = false;
  await publishHealth();
  if (healthSource) {
    healthTimer = setInterval(() => {
      void publishHealth().catch(() => {});
    }, 5_000);
    healthTimer.unref();
  }
  approvalSource = provider.approvals;
  if (approvalSource.durable && (!approvalSource.decide || !approvalSource.listPending)) {
    throw new Error('Durable gateway approvals require decide and listPending');
  }
  selectedKind = provider.kind;
  startedAt = Date.now();
  unavailable = false;
  reportUnavailable = onUnavailable;
  reportAvailable = options.onAvailable ?? (() => {});
  controller = new AbortController();
  if (!registeredResponseHandler) {
    registerResponseHandler(handleGatewayApprovalResponse, { prepend: true });
    registeredResponseHandler = true;
  }

  await sweepStaleGatewayApprovals(provider.approvals.legacyActions ?? []);
  expirySweep = setInterval(() => {
    void sweepOverdueGatewayApprovals().catch((err) => log.error('Gateway approval expiry sweep failed', { err }));
  }, 60_000);
  expirySweep.unref();

  decisionGeneration++;
  const activeController = controller;
  const ready = new Promise<void>((resolve) => {
    initialReady = resolve;
  });
  subscription = superviseSubscription(provider, activeController);
  if (options.waitUntilReady) {
    await ready;
    await healthWrite;
  }
}

type SubscriptionOutcome = { ok: true } | { ok: false; err: unknown };

/**
 * Keep one subscription alive for as long as the coordinator runs.
 *
 * A bridge that ends — cleanly or not — denies every hold and closes session
 * admission, then is retried with capped exponential backoff. A retry that
 * survives its fail-fast window reopens admission. Without this loop a single
 * gateway restart left the host up but permanently unable to spawn a session,
 * dropping every user message with nothing but a log line to show for it.
 */
async function superviseSubscription(
  provider: GatewayProviderDefinition,
  activeController: AbortController,
): Promise<void> {
  let backoffMs = RECONNECT_BASE_MS;
  while (!activeController.signal.aborted) {
    let running = true;
    const attempt = startSubscription(provider, activeController).finally(() => {
      running = false;
    });

    await Promise.race([attempt, sleep(SUBSCRIPTION_READY_MS, activeController.signal)]);
    if (activeController.signal.aborted) break;
    if (running) {
      restoreAvailability(provider.kind);
      initialReady?.();
      initialReady = undefined;
      backoffMs = RECONNECT_BASE_MS;
    }

    const outcome = await attempt;
    if (activeController.signal.aborted) break;
    if (!outcome.ok) {
      log.error('Gateway approval subscription failed', { gatewayProvider: provider.kind, err: outcome.err });
    }
    await failSubscription(outcome.ok ? 'Gateway approval subscription ended' : 'Gateway approval subscription failed');
    initialReady?.();
    initialReady = undefined;

    await sleep(backoffMs, activeController.signal);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }
}

/** Normalize a provider's subscribe — sync throw included — into one settled outcome. */
function startSubscription(
  provider: GatewayProviderDefinition,
  activeController: AbortController,
): Promise<SubscriptionOutcome> {
  try {
    return provider.approvals
      .subscribe(
        (request) => decideGatewayRequest(provider.kind, request),
        activeController.signal,
        resolveGatewayRequest,
        { ownsAgentGroup: async (id) => typeof id === 'string' && id.length > 0 && !!(await getAgentGroup(id)) },
      )
      .then<SubscriptionOutcome, SubscriptionOutcome>(
        () => ({ ok: true }),
        (err) => ({ ok: false, err }),
      );
  } catch (err) {
    return Promise.resolve({ ok: false, err });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reopen admission once a reconnected bridge has proven it stays up. */
function restoreAvailability(gatewayProvider: string): void {
  subscriptionHealthy = true;
  void publishHealth().catch(() => {});
  if (!unavailable) return;
  unavailable = false;
  log.info('Gateway approval subscription restored', { gatewayProvider });
  if (!healthSource) reportAvailable();
}

export async function stopGatewayApprovalCoordinator(): Promise<void> {
  const activeController = controller;
  const activeSubscription = subscription;
  if (!activeController) return;
  unavailable = true;
  decisionGeneration++;
  subscriptionHealthy = false;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  healthGeneration++;
  const stoppedHealth = publishHealth().catch(() => {});
  if (expirySweep) clearInterval(expirySweep);
  expirySweep = null;
  activeController.abort();
  initialReady?.();
  initialReady = undefined;
  await denyAll('host restarted');
  if (activeSubscription) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      activeSubscription.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  let healthDeadline: NodeJS.Timeout | undefined;
  await Promise.race([
    stoppedHealth,
    new Promise<void>((resolve) => {
      healthDeadline = setTimeout(resolve, 5_000);
    }),
  ]);
  if (healthDeadline) clearTimeout(healthDeadline);
  if (controller === activeController) {
    controller = null;
    subscription = null;
    adapter = null;
    approvalSource = null;
    selectedKind = '';
    healthSource = undefined;
  }
}

async function failSubscription(reason: string): Promise<void> {
  if (unavailable) return;
  unavailable = true;
  decisionGeneration++;
  subscriptionHealthy = false;
  void publishHealth().catch(() => {});
  reportUnavailable(reason);
  await denyAll('bridge failed');
}

function decideGatewayRequest(providerKind: string, request: GatewayApprovalRequest): Promise<GatewayApprovalDecision> {
  if (!approvalSource?.durable) return processGatewayRequest(providerKind, request);
  const key = `${providerKind}\0${request.id}`;
  const binding = requestBinding(request);
  const existing = inFlightRequests.get(key);
  if (existing) return existing.binding === binding ? existing.promise : Promise.resolve('unavailable');
  const result = processGatewayRequest(providerKind, request).finally(() => {
    if (inFlightRequests.get(key)?.promise === result) inFlightRequests.delete(key);
  });
  inFlightRequests.set(key, { binding, promise: result });
  return result;
}

async function processGatewayRequest(
  providerKind: string,
  request: GatewayApprovalRequest,
): Promise<GatewayApprovalDecision> {
  const owner = controller;
  const generation = decisionGeneration;
  const current = () =>
    owner === controller && owner && !owner.signal.aborted && !unavailable && generation === decisionGeneration;
  try {
    if (!current() || providerKind !== selectedKind) return unavailableDecision();
    validateRequest(request);
    const createdAtMs = Date.parse(request.createdAt);

    const agentGroup = await getAgentGroup(request.agentGroupId);
    if (!agentGroup) return unavailableDecision();
    const session = request.sessionId ? await getSession(request.sessionId) : undefined;
    if (
      request.sessionId &&
      (!session || session.agent_group_id !== request.agentGroupId || session.status !== 'active')
    ) {
      return unavailableDecision();
    }
    if (
      request.runtimeIdentity &&
      (!request.sessionId ||
        request.runtimeIdentity !==
          gatewayRuntimeIdentity({
            installSlug: INSTALL_SLUG,
            agentGroupId: request.agentGroupId,
            sessionId: request.sessionId,
          }))
    ) {
      return unavailableDecision();
    }
    if (pending.size >= maxPending) return unavailableDecision();
    const requestKey = `${providerKind}\0${request.id}`;
    if (requestKeys.has(requestKey)) {
      const held = [...pending.values()].find((state) => state.requestKey === requestKey);
      return approvalSource?.durable && held && held.binding === requestBinding(request)
        ? held.promise
        : unavailableDecision();
    }

    const now = Date.now();
    const providerDeadline = request.expiresAt
      ? Math.min(Date.parse(request.expiresAt) - 1_000, now + MAX_PROVIDER_APPROVAL_MS)
      : now + timeoutMs;
    if (providerDeadline <= now) return unavailableDecision();
    const deadline = providerDeadline;

    const rows = await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION);
    const saved = rows.find(
      (row) => row.request_id === request.id && JSON.parse(row.payload).gatewayProvider === providerKind,
    );
    if (approvalSource?.durable && saved && JSON.parse(saved.payload).requestBinding !== requestBinding(request))
      return 'unavailable';
    if (approvalSource?.durable && saved && saved.status !== 'pending') {
      await deliverDurableDecision(saved);
      return saved.status === 'approved' ? 'approve' : saved.status === 'rejected' ? 'deny' : 'unavailable';
    }
    const existing = rows.find(
      (row) =>
        row.request_id === request.id &&
        row.agent_group_id === request.agentGroupId &&
        row.status === 'pending' &&
        JSON.parse(row.payload).gatewayProvider === providerKind,
    );
    if (existing) {
      if (approvalSource?.durable && !existing.platform_message_id) {
        await expireApproval(existing.approval_id, 'no response');
        return 'unavailable';
      }
      if (request.approverUserId && existing.approver_user_id !== request.approverUserId) return unavailableDecision();
      const savedDeadline = existing.expires_at ? Date.parse(existing.expires_at) : 0;
      if (savedDeadline <= now) {
        await expireApproval(existing.approval_id, 'no response');
        return unavailableDecision();
      }
      return armPending(existing.approval_id, requestKey, Math.min(savedDeadline, deadline), requestBinding(request));
    }
    if (createdAtMs < startedAt && !approvalSource?.durable) return unavailableDecision();
    if (request.trigger === 'default' && request.destination && session) {
      if (permitsConfiguredGatewayRead(request.destination)) return current() ? 'approve' : unavailableDecision();
      const config = await getContainerConfig(request.agentGroupId);
      const providerName = resolveProviderName(session.agent_provider, config?.provider);
      const domains = getProviderHostContract(providerName)?.modelDomains ?? [];
      const host = request.destination.host.toLowerCase().replace(/:443$/, '');
      if (domains.some((domain) => host === domain || host.endsWith(`.${domain}`)))
        return current() ? 'approve' : unavailableDecision();
    }

    const approvers = request.approverUserId ? [request.approverUserId] : await pickApprover(request.agentGroupId);
    if (approvers.length === 0) return unavailableDecision();
    const originChannelType = session?.messaging_group_id
      ? ((await getMessagingGroup(session.messaging_group_id))?.channel_type ?? '')
      : '';
    const policyGroup = request.delivery ? await getMessagingGroup(request.delivery.messagingGroupId) : undefined;
    const target = request.delivery
      ? policyGroup && request.approverUserId
        ? { userId: request.approverUserId, messagingGroup: policyGroup }
        : null
      : await pickApprovalDelivery(approvers, originChannelType, request.approverInstance);
    if (!target || !adapter) return unavailableDecision();
    if (
      request.approverInstance &&
      (target.messagingGroup.instance ?? target.messagingGroup.channel_type) !== request.approverInstance
    )
      return unavailableDecision();

    if (!current()) return unavailableDecision();
    const presentation = gatewayApprovalPresentation(request);
    const approvalId = `ga-${randomBytes(10).toString('hex')}`;
    const sendCard = () =>
      adapter!.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        request.delivery?.threadId ?? null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          requirePresentation: Boolean(request.displayFields),
          questionId: approvalId,
          title: presentation.title,
          question: presentation.question,
          options: OPTIONS,
        }),
        undefined,
        target.messagingGroup.instance,
      );
    const row = {
      approval_id: approvalId,
      session_id: request.sessionId ?? null,
      request_id: request.id,
      action: GATEWAY_APPROVAL_ACTION,
      payload: JSON.stringify({
        gatewayProvider: providerKind,
        audit: request.audit ?? {},
        threadId: request.delivery?.threadId ?? null,
        requestBinding: requestBinding(request),
      }),
      created_at: new Date().toISOString(),
      agent_group_id: request.agentGroupId,
      channel_type: target.messagingGroup.channel_type,
      platform_id: target.messagingGroup.platform_id,
      instance: target.messagingGroup.instance ?? null,
      platform_message_id: null,
      expires_at: new Date(deadline).toISOString(),
      status: 'pending' as const,
      title: presentation.title,
      question: presentation.question,
      options_json: JSON.stringify(normalizeOptions(OPTIONS)),
      approver_user_id: target.userId,
    };
    if (approvalSource?.durable) {
      if (!(await createPendingApproval(row))) return 'unavailable';
      const messageId = await sendCard();
      if (!messageId) {
        await expireApproval(approvalId, 'no response');
        return 'unavailable';
      }
      await bindPendingApprovalMessage(approvalId, messageId);
    } else {
      const messageId = await sendCard();
      if (!(await createPendingApproval({ ...row, platform_message_id: messageId ?? null })))
        return unavailableDecision();
    }

    if (!current()) {
      await expireApproval(approvalId, 'bridge failed');
      return unavailableDecision();
    }
    return await armPending(approvalId, requestKey, deadline, requestBinding(request));
  } catch (err) {
    log.error('Gateway approval request failed closed', { gatewayProvider: providerKind, requestId: request.id, err });
    return unavailableDecision();
  }
}

function armPending(
  approvalId: string,
  requestKey: string,
  deadline: number,
  binding: string,
): Promise<GatewayApprovalDecision> {
  requestKeys.add(requestKey);
  let resolve!: (decision: GatewayApprovalDecision) => void;
  const promise = new Promise<GatewayApprovalDecision>((done) => {
    resolve = done;
  });
  const timer = setTimeout(
    () => {
      void expireApproval(approvalId, 'no response').catch((err) =>
        log.error('Gateway approval expiry failed', { approvalId, err }),
      );
    },
    Math.max(1, deadline - Date.now()),
  );
  pending.set(approvalId, { resolve, timer, requestKey, promise, binding });
  return promise;
}

export async function handleGatewayApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  let state: PendingState | undefined;
  try {
    const approval = await getPendingApproval(payload.questionId);
    if (!approval || approval.action !== GATEWAY_APPROVAL_ACTION) return false;
    state = pending.get(payload.questionId);
    if (!(await isAuthorizedApprovalClick(approval, payload))) return true;
    if (
      approvalSource?.durable &&
      (payload.instance !== (approval.instance ?? approval.channel_type) ||
        payload.channelType !== approval.channel_type ||
        (payload.messageId !== undefined && payload.messageId !== approval.platform_message_id) ||
        (payload.platformId && payload.platformId !== approval.platform_id))
    )
      return true;
    if (!approval.expires_at || Date.parse(approval.expires_at) <= Date.now()) {
      await expireApproval(approval.approval_id, 'no response');
      return true;
    }
    const decision: GatewayApprovalDecision = payload.value === 'approve' ? 'approve' : 'deny';
    const claimed = await transitionPendingApprovalStatus(
      approval.approval_id,
      'pending',
      decision === 'approve' ? 'approved' : 'rejected',
    );
    if (!claimed) return true;
    // The database claim owns the outcome; expiry must not override it while
    // card updates or gateway delivery are still in flight.
    if (state) clearTimeout(state.timer);
    if (approvalSource?.durable) {
      await editGatewayApprovalCard(approval, decision === 'approve' ? '✅ Approved' : '❌ Rejected');
      await deliverDurableDecision({ ...approval, status: decision === 'approve' ? 'approved' : 'rejected' });
      if (state) settle(approval.approval_id, state, decision);
      return true;
    }
    await editGatewayApprovalCard(approval, decision === 'approve' ? '✅ Approved' : '❌ Rejected');
    await deletePendingApproval(approval.approval_id);
    if (state) settle(approval.approval_id, state, decision);
    else {
      let delivered = false;
      if (approvalSource?.decide && approval.request_id) {
        try {
          delivered = await approvalSource.decide(approval.request_id, decision);
        } catch (err) {
          log.warn('Late approval decision not accepted by gateway', { approvalId: approval.approval_id, err });
        }
      }
      if (decision === 'approve' && !delivered) {
        await editGatewayApprovalCard(
          approval,
          '✅ Approved — recorded, but the original request ended when the host restarted. Ask the agent to retry the action.',
        );
      }
    }
    return true;
  } catch (err) {
    if (state) settle(payload.questionId, state, unavailableDecision());
    log.error('Gateway approval response failed closed', { approvalId: payload.questionId, err });
    return true;
  }
}

async function expireApproval(
  approvalId: string,
  reason: 'no response' | 'host restarted' | 'bridge failed' | 'request changed',
): Promise<void> {
  const state = pending.get(approvalId);
  let expired = false;
  try {
    const row = await getPendingApproval(approvalId);
    if (row && (await transitionPendingApprovalStatus(approvalId, 'pending', 'expired'))) {
      expired = true;
      await editExpiredGatewayApprovalCard(row, reason);
      if (approvalSource?.durable) await deliverDurableDecision({ ...row, status: 'expired' });
      else await deletePendingApproval(approvalId);
    }
  } catch (err) {
    if (state) settle(approvalId, state, unavailableDecision());
    throw err;
  } finally {
    if (expired && state) settle(approvalId, state, unavailableDecision());
  }
}

async function denyAll(reason: 'host restarted' | 'bridge failed'): Promise<void> {
  if (approvalSource?.durable) {
    for (const [id, state] of pending) settle(id, state, 'unavailable');
    return;
  }
  await Promise.all([...pending.keys()].map((approvalId) => expireApproval(approvalId, reason)));
}

function settle(approvalId: string, state: PendingState, decision: GatewayApprovalDecision): void {
  if (pending.get(approvalId) !== state) return;
  pending.delete(approvalId);
  requestKeys.delete(state.requestKey);
  clearTimeout(state.timer);
  state.resolve(decision);
}

export async function editExpiredGatewayApprovalCard(
  row: PendingApproval,
  reason: 'no response' | 'host restarted' | 'bridge failed' | 'request changed',
): Promise<void> {
  const resolution =
    reason === 'no response'
      ? '⏱️ Timed out — no response'
      : reason === 'host restarted'
        ? '⏱️ Timed out — host restarted before resolution'
        : reason === 'request changed'
          ? '❌ Expired — request changed'
          : '❌ Denied — approval bridge failed';
  await editGatewayApprovalCard(row, resolution);
}

async function editGatewayApprovalCard(row: PendingApproval, resolution: string): Promise<void> {
  if (!adapter || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  try {
    await adapter.deliver(
      row.channel_type,
      row.platform_id,
      JSON.parse(row.payload).threadId ?? null,
      'chat-sdk',
      JSON.stringify({
        questionId: row.approval_id,
        operation: 'edit',
        messageId: row.platform_message_id,
        text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
        terminalCard: { title: row.title, question: row.question, resolution },
      }),
      undefined,
      row.instance ?? row.channel_type,
    );
  } catch (err) {
    log.error('Failed to edit expired gateway approval card', { approvalId: row.approval_id, err });
  }
}

async function sweepStaleGatewayApprovals(legacyActions: readonly string[]): Promise<void> {
  if (approvalSource?.listPending) {
    try {
      const snapshot = await approvalSource.listPending();
      if (approvalSource.durable) {
        const live = new Map(snapshot.map((request) => [request.id, requestBinding(request)]));
        for (const row of await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)) {
          if (JSON.parse(row.payload).gatewayProvider !== selectedKind) continue;
          if (row.request_id && !live.has(row.request_id)) await resolveGatewayRequest(row.request_id);
          else if (row.request_id && live.get(row.request_id) !== JSON.parse(row.payload).requestBinding) {
            await editExpiredGatewayApprovalCard(row, 'request changed');
            await deletePendingApproval(row.approval_id);
          } else if (row.status === 'approved' || row.status === 'rejected' || row.status === 'expired')
            await deliverDurableDecision(row);
        }
      }
    } catch (err) {
      log.warn('Gateway pending approvals unavailable during restart recovery', { err });
    }
  }
  for (const action of new Set([GATEWAY_APPROVAL_ACTION, ...legacyActions])) {
    for (const row of await getPendingApprovalsByAction(action)) {
      if (
        action === GATEWAY_APPROVAL_ACTION &&
        (approvalSource?.durable || (row.expires_at && Date.parse(row.expires_at) > Date.now())) &&
        JSON.parse(row.payload).gatewayProvider === selectedKind
      )
        continue;
      await editExpiredGatewayApprovalCard(
        row,
        row.expires_at && Date.parse(row.expires_at) <= Date.now() ? 'no response' : 'host restarted',
      );
      await deletePendingApproval(row.approval_id);
    }
  }
}

async function sweepOverdueGatewayApprovals(): Promise<void> {
  for (const row of await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)) {
    if (JSON.parse(row.payload).gatewayProvider !== selectedKind) continue;
    if (
      approvalSource?.durable &&
      (row.status === 'approved' || row.status === 'rejected' || row.status === 'expired')
    ) {
      await deliverDurableDecision(row);
      continue;
    }
    if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) {
      await expireApproval(row.approval_id, 'no response');
    }
  }
}

function validateRequest(request: GatewayApprovalRequest): void {
  gatewayApprovalPresentation(request);
  if (request.approverUserId !== undefined && !/^[^:\s]+:[^\s]+$/.test(request.approverUserId)) {
    throw new Error('Gateway selected approver is invalid');
  }
  if (request.trigger !== undefined && !['default', 'policy'].includes(request.trigger)) {
    throw new Error('Gateway approval trigger is invalid');
  }
  if (
    request.destination &&
    (typeof request.destination.host !== 'string' ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::[0-9]{1,5})?$/i.test(request.destination.host))
  ) {
    throw new Error('Gateway destination host is invalid');
  }
  if (!request.id || request.id.length > 200) throw new Error('Gateway approval id is invalid');
  if (!request.agentGroupId || request.agentGroupId.length > 200) throw new Error('Gateway agent identity is invalid');
  if (request.sessionId !== undefined && (!request.sessionId || request.sessionId.length > 200)) {
    throw new Error('Gateway session identity is invalid');
  }
  if (request.runtimeIdentity !== undefined && (!request.runtimeIdentity || request.runtimeIdentity.length > 600)) {
    throw new Error('Gateway runtime identity is invalid');
  }
  if (!Number.isFinite(Date.parse(request.createdAt))) throw new Error('Gateway approval creation time is invalid');
  if (request.expiresAt !== undefined && !Number.isFinite(Date.parse(request.expiresAt))) {
    throw new Error('Gateway approval expiry is invalid');
  }
  if (!request.title || request.title.length > (request.displayFields ? 256 : MAX_TITLE_CHARS))
    throw new Error('Gateway approval title is invalid');
  if (!request.question || request.question.length > MAX_QUESTION_CHARS) {
    throw new Error('Gateway approval question is invalid');
  }
  if (request.audit) {
    if (
      Object.entries(request.audit).some(
        ([key, value]) =>
          !key || key.length > 100 || (!['string', 'number', 'boolean'].includes(typeof value) && value !== null),
      )
    ) {
      throw new Error('Gateway approval audit payload is invalid');
    }
    if (Buffer.byteLength(JSON.stringify(request.audit), 'utf8') > MAX_AUDIT_BYTES) {
      throw new Error('Gateway approval audit payload is too large');
    }
  }
}

function unavailableDecision(): GatewayApprovalDecision {
  return approvalSource?.durable ? 'unavailable' : 'deny';
}

async function deliverDurableDecision(row: PendingApproval): Promise<void> {
  if (!row.request_id || !approvalSource?.decide) return;
  try {
    const accepted = await approvalSource.decide(
      row.request_id,
      row.status === 'approved' ? 'approve' : row.status === 'expired' ? 'unavailable' : 'deny',
    );
    if (accepted) await deletePendingApproval(row.approval_id);
  } catch (err) {
    log.warn('Gateway decision retained for retry', { approvalId: row.approval_id, err });
  }
}

async function resolveGatewayRequest(requestId: string): Promise<void> {
  for (const row of await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)) {
    if (row.request_id !== requestId || JSON.parse(row.payload).gatewayProvider !== selectedKind) continue;
    // A gateway terminal event can arrive before its decision HTTP response.
    // Claim only an undecided row; never overwrite a persisted human decision.
    await transitionPendingApprovalStatus(row.approval_id, 'pending', 'expired');
    const current = await getPendingApproval(row.approval_id);
    if (!current) continue;
    const decision =
      current.status === 'approved' ? 'approve' : current.status === 'rejected' ? 'deny' : unavailableDecision();
    await editGatewayApprovalCard(
      current,
      decision === 'approve'
        ? '✅ Approved'
        : current.status === 'rejected'
          ? '❌ Rejected'
          : 'Request ended at the gateway.',
    );
    await deletePendingApproval(row.approval_id);
    const state = pending.get(row.approval_id);
    if (state) settle(row.approval_id, state, decision);
  }
}

/** Bind duplicate/replayed ids to the complete immutable request, independent of object key order. */
function requestBinding(request: GatewayApprovalRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(request)))
    .digest('hex');
}
