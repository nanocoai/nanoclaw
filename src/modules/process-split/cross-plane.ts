/**
 * Cross-plane machinery — how the gateway asks and the controller answers.
 *
 * Recipes overlay module (process-split skill). The mail is the request: the
 * gateway writes messages (mailbox) and durable wake signals (`wake_signals`,
 * from the trunk coordination schema); the controller consumes signals and
 * honors durable stop intents. No RPC, no shared memory — every cross-plane
 * fact is a row, so either plane can restart without losing the other's
 * requests.
 *
 * In role 'all' none of this engages: `requestWakeForPlane` is the same
 * delegation to `wakeContainer` the trunk seam performs, and the consumer is
 * never started.
 */
import { honorPendingStopIntents, wakeContainer } from '../../container-runner.js';
import { listSessionsWithStopIntent, takeWakeSignals, writeWakeSignal } from '../../db/coordination.js';
import { getHostInstanceId } from '../../host-instance.js';
import { log } from '../../log.js';
import { enqueueSessionReconcile } from '../../reconcile-feeds.js';
import type { WakeReason } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { isSplitGateway } from './role.js';

/**
 * The wake seam's split-aware implementation. Controller and all-role are the
 * trunk behavior verbatim (delegate to the runtime). The split gateway never
 * touches containers: the caller has already written the mail, so the wake
 * request becomes a durable signal row the controller's consumer serves
 * within its poll cadence. Returning true mirrors the "wake requested"
 * contract — the gateway cannot know spawn outcomes, and the controller's
 * reconcile (level-triggered, resync floor) owns retries from here.
 */
export async function requestWakeForPlane(session: Session, reason: WakeReason): Promise<boolean> {
  if (!isSplitGateway()) return wakeContainer(session);
  /* eslint-disable no-catch-all/no-catch-all -- a failed signal write costs latency (the controller resync covers it), never the caller's write path */
  try {
    await writeWakeSignal(session.id, reason, new Date().toISOString());
  } catch (err) {
    log.warn('Cross-plane wake signal write failed — the resync floor will cover it', {
      sessionId: session.id,
      reason,
      err,
    });
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return true;
}

const CONSUMER_POLL_MS = 2_000;

let consumerTimer: NodeJS.Timeout | null = null;
let consumerBusy = false;

/**
 * The controller-side consumer: every poll, take pending wake signals and
 * enqueue each session for reconcile (the queue coalesces; reconcile is
 * level-triggered, so duplicates are free), then honor any durable stop
 * intents — that is how gateway-side restart flows (which cannot kill
 * containers) reach the plane that can. Runs only in the split controller;
 * the 60s resync remains the loss floor for everything here.
 */
export function startWakeSignalConsumer(pollMs: number = CONSUMER_POLL_MS): void {
  if (consumerTimer) throw new Error('wake-signal consumer already started');
  consumerTimer = setInterval(() => {
    if (consumerBusy) return; // a slow poll must not stack another behind it
    consumerBusy = true;
    void consumeOnce().finally(() => {
      consumerBusy = false;
    });
  }, pollMs);
  consumerTimer.unref?.();
}

export function stopWakeSignalConsumer(): void {
  if (consumerTimer) {
    clearInterval(consumerTimer);
    consumerTimer = null;
  }
}

/** One consumer pass. Exported for tests; never throws. */
export async function consumeOnce(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the consumer is a background loop; a failed pass costs latency and the resync floor covers it */
  try {
    const signals = await takeWakeSignals({
      consumerId: getHostInstanceId() ?? 'controller',
      now: new Date().toISOString(),
    });
    for (const signal of signals) enqueueSessionReconcile(signal.session_id);
    // Stop intents are the durable cross-plane restart channel: the gateway
    // (and any flow running there, e.g. an approved self-mod apply) writes
    // respawn_after_stop; only this plane can execute the kill + respawn.
    const intents = await listSessionsWithStopIntent();
    if (intents.some((intent) => intent.stop_intent === 'respawn_after_stop')) {
      await honorPendingStopIntents();
    }
  } catch (err) {
    log.warn('Wake-signal consumer pass failed', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Gateway boot: wait until the schema is current instead of running
 * migrations — the controller (or the deployment's migration role) is the
 * single migration owner. Bounded so a missing migrator surfaces as a clear
 * failure, not an infinite hang.
 */
export async function awaitSchemaCurrent(
  runValidate: () => Promise<void>,
  options: { retryMs?: number; maxTries?: number } = {},
): Promise<void> {
  const retryMs = options.retryMs ?? 2_000;
  const maxTries = options.maxTries ?? 150;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    /* eslint-disable no-catch-all/no-catch-all -- validation failure here means "schema not current yet"; the bounded loop rethrows at the end */
    try {
      await runValidate();
      return;
    } catch (err) {
      lastError = err;
      if (attempt === 1) {
        log.info('gateway: waiting for the schema to be migrated by the controller plane', { retryMs, maxTries });
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  throw new Error(
    `gateway: schema never became current after ${maxTries} attempts — is the controller (or migration role) running? Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
