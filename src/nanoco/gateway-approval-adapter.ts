import { log } from '../log.js';
import type { ResponsePayload } from '../response-registry.js';
import { ApprovalContractError } from './approval-contract.js';
import { GatewayApprovalCards } from './approval-cards.js';
import type { GatewayApprovalStore, StoredGatewayApproval } from './approval-store.js';
import { ApprovalTransportUnavailable, type GatewayApprovalTransport } from './approval-transport.js';

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const RESYNC_RETRY_DELAY_MS = 1000;

/**
 * Durable host adapter for the Gateway approval protocol.
 *
 * The central store is the only authority. The reconnect loop and callbacks merely wake
 * work that is rediscovered from the stored cursor, cards, and decisions.
 */
export class GatewayApprovalAdapter {
  readonly #lifetime = new AbortController();
  #runPromise: Promise<void> | null = null;
  #streamAbort: AbortController | null = null;
  #resyncRequested = false;
  #flushPromise: Promise<void> | null = null;
  #flushAgain = false;
  #decisionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #decisionRetryAttempt = 0;

  constructor(
    private readonly store: GatewayApprovalStore,
    private readonly cards: GatewayApprovalCards,
    private readonly transport: GatewayApprovalTransport,
  ) {}

  start(): void {
    if (this.#runPromise) return;
    this.#runPromise = this.#run();
  }

  async stop(): Promise<void> {
    this.#lifetime.abort();
    this.#streamAbort?.abort();
    if (this.#decisionRetryTimer) clearTimeout(this.#decisionRetryTimer);
    await this.#runPromise;
    await this.#flushPromise;
  }

  async handleClick(payload: ResponsePayload): Promise<boolean> {
    const row = await this.store.getByQuestionId(payload.questionId);
    if (!row) return false;
    if (payload.value !== 'approve' && payload.value !== 'reject') return true;

    const result = await this.store.recordHumanDecision(
      payload.questionId,
      namespacedUserId(payload),
      payload.value,
    );
    if (result.status === 'unauthorized') {
      log.warn('Ignoring click from a user other than the selected NanoCo approver', {
        approvalId: row.approval_id,
      });
    } else if (result.status === 'decided') {
      this.decisionReady();
    }
    return true;
  }

  decisionReady(): void {
    this.#flushAgain = true;
    if (!this.#decisionRetryTimer && !this.#flushPromise && !this.#lifetime.signal.aborted) {
      let flushEpoch: string | null = null;
      this.#flushPromise = this.store
        .cursor()
        .then((cursor) => {
          flushEpoch = cursor?.gateway_epoch ?? null;
          return this.#flushDecisions(flushEpoch);
        })
        .catch(async (error: unknown) => {
          if (this.#lifetime.signal.aborted) return;
          if (!(await this.#isCurrentEpoch(flushEpoch))) return;
          // An acknowledgement/evidence invariant failed outside ordinary
          // transport retry handling. Keep central state unchanged, recover the
          // authoritative snapshot, and retry only the durable command.
          log.warn('NanoCo approval decision state will resync', { code: safeErrorCode(error) });
          this.#requestResync();
          this.#scheduleDecisionRetry();
        })
        .finally(() => {
          this.#flushPromise = null;
          if (this.#flushAgain) this.decisionReady();
        });
    }
  }

  async #run(): Promise<void> {
    let reconnectAttempt = 0;
    while (!this.#lifetime.signal.aborted) {
      try {
        const snapshot = await this.transport.snapshot(this.#lifetime.signal);
        const previousEpoch = (await this.store.cursor())?.gateway_epoch ?? null;
        const cards = await this.store.reconcileSnapshot(snapshot);
        if (previousEpoch && previousEpoch !== snapshot.gatewayEpoch) {
          this.#resetDecisionRetry();
        }

        // An attempted card without a successful-return marker is the only
        // uncertain side-effect window. Never send a duplicate after restart.
        for (const row of await this.store.uncertainCardAttempts(snapshot.gatewayEpoch)) {
          await this.store.recordUnavailable(key(row));
        }
        for (const row of cards) await this.cards.deliver(row);
        this.decisionReady();
        await this.#flushPromise;

        if (this.#resyncRequested) {
          this.#resyncRequested = false;
          continue;
        }

        reconnectAttempt = 0;
        const cursor = await this.store.cursor();
        if (!cursor || cursor.gateway_epoch !== snapshot.gatewayEpoch) {
          throw new Error('NanoCo approval cursor was not committed with its snapshot');
        }

        this.#streamAbort = new AbortController();
        const signal = AbortSignal.any([this.#lifetime.signal, this.#streamAbort.signal]);
        const result = await this.transport.events(
          cursor.gateway_epoch,
          cursor.cursor,
          async (event) => {
            const row = await this.store.recordEvent(event);
            if (row) await this.cards.deliver(row);
            this.decisionReady();
          },
          signal,
        );
        this.#streamAbort = null;
        if (result === 'resync_required') {
          // A durable Gateway can legitimately ask for one fresh snapshot
          // during epoch/replay turnover. If the same condition persists,
          // however, an immediate retry becomes a cross-service busy loop:
          // snapshot + cursor writes on NanoClaw and failed subscriptions on
          // Gateway/PostgreSQL. Keep recovery automatic but bounded.
          await abortableDelay(RESYNC_RETRY_DELAY_MS, this.#lifetime.signal);
          continue;
        }
        if (this.#resyncRequested) continue;
      } catch (error) {
        this.#streamAbort = null;
        if (this.#lifetime.signal.aborted) return;
        if (this.#resyncRequested) {
          this.#resyncRequested = false;
          continue;
        }
        log.warn('NanoCo approval connection will retry', { code: safeErrorCode(error) });
      }

      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
      reconnectAttempt += 1;
      await abortableDelay(delay, this.#lifetime.signal);
    }
  }

  async #flushDecisions(flushEpoch: string | null): Promise<void> {
    do {
      this.#flushAgain = false;
      if (!flushEpoch || !(await this.#isCurrentEpoch(flushEpoch))) return;
      const rows = await this.store.decisionsToSubmit(flushEpoch);
      for (const row of rows) {
        if (this.#lifetime.signal.aborted) return;
        let submission;
        try {
          submission = await this.transport.submit(this.store.decisionCommand(row), this.#lifetime.signal);
        } catch (error) {
          if (!(await this.#isCurrentEpoch(flushEpoch))) return;
          if (!this.#lifetime.signal.aborted) {
            log.warn('NanoCo approval decision delivery will retry', { code: safeErrorCode(error) });
            this.#scheduleDecisionRetry();
          }
          return;
        }
        if (!(await this.#isCurrentEpoch(flushEpoch))) return;
        if (submission.status === 'acknowledged') {
          await this.store.acknowledge(row, submission.acknowledgement);
          this.#decisionRetryAttempt = 0;
          continue;
        }
        if (submission.status === 'resync_required') {
          this.#requestResync();
          return;
        }
        if (submission.status === 'retry') {
          this.#scheduleDecisionRetry();
          return;
        }
        // Gone, conflicting, or invalid evidence cannot become permission.
        // Stop retrying this exact stale decision and let audit retain it.
        await this.store.markDecisionGone(row);
      }
    } while (this.#flushAgain);
  }

  #scheduleDecisionRetry(): void {
    if (this.#decisionRetryTimer || this.#lifetime.signal.aborted) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#decisionRetryAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.#decisionRetryAttempt += 1;
    this.#decisionRetryTimer = setTimeout(() => {
      this.#decisionRetryTimer = null;
      this.decisionReady();
    }, delay);
  }

  #resetDecisionRetry(): void {
    if (this.#decisionRetryTimer) clearTimeout(this.#decisionRetryTimer);
    this.#decisionRetryTimer = null;
    this.#decisionRetryAttempt = 0;
  }

  async #isCurrentEpoch(gatewayEpoch: string | null): Promise<boolean> {
    return ((await this.store.cursor())?.gateway_epoch ?? null) === gatewayEpoch;
  }

  #requestResync(): void {
    this.#resyncRequested = true;
    this.#streamAbort?.abort();
  }
}

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

function key(row: StoredGatewayApproval): {
  deploymentId: string;
  gatewayEpoch: string;
  approvalId: string;
} {
  return {
    deploymentId: row.deployment_id,
    gatewayEpoch: row.gateway_epoch,
    approvalId: row.approval_id,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ApprovalTransportUnavailable) return error.code;
  if (error instanceof ApprovalContractError) return 'contract';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'internal';
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
