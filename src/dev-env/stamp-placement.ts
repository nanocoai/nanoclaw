/**
 * The placement reconciler (C15) — host-side, beside the pool reconciler.
 *
 * Each tick: re-probe current-version `placed` rows against the driver's
 * store (an evicted image flips back to `pending`, closing the claim gate
 * honestly — the image genuinely is not there), then take the oldest
 * current-version `pending` row (concurrency 1 per install), flip it
 * `placing`, call the driver's one placement verb under a hard timeout, and
 * record `placed` + digest or `failed` + the reason (#20: a failure without
 * a recorded reason is a support ticket).
 *
 * Two structural properties are the point of living IN-PROCESS with the
 * host. First, no `mark-*` verbs exist: the reconciler writes the ledger
 * itself, so "an agent that could mark-placed could forge the state the
 * claim gate trusts" is answered by the verb not existing. Second, the
 * split-brain failure mode dies: "placement down" and "claims down" are the
 * same outage and the same page. What remains is the host dying mid-flight,
 * and the ownership model dictates the recovery — the reconciler is single
 * and call-and-await, so NO in-flight placement survives a host death:
 * `adopt()` flips ALL `placing` rows to `failed` with a host-lost reason, no
 * age gate (a gate is a lease pattern for work a peer might still hold; here
 * no peer can, and a row it excused would be re-examined by nothing ever).
 *
 * Placement completions notify like claim completions do (#223's seam): the
 * events here feed wireStampPlacementPush below — same session-message
 * transport, no second mechanism.
 */
import { log } from '../log.js';

import { deliverClaimPushToSession, type ClaimPushDeliver } from './claim-notify.js';
import { imageGateNoRecord, imageGateRefusal, type StampImageRow, type StampImageStore } from './stamp-images.js';
import type { NodeImageProbe, StampRegistryStore } from './stamp-registry.js';
import { imageRefDigest, stampImageOrigin, type K8sStampConfig } from './stamps.js';
import { DEV_ENV_LABELS, type DevEnvDriver, type DriverPlaceSpec } from './types.js';

export interface StampPlacementEvent {
  kind: 'image-placed' | 'image-failed';
  row: StampImageRow;
}

export interface StampPlacementConfig {
  images: StampImageStore;
  registry: StampRegistryStore;
  driver: DevEnvDriver;
  installScope: string;
  /** Refreshed after every transition, so the gate/pool see it within the tick that made it. */
  source?: { refresh(): Promise<void> };
  tickIntervalMs?: number;
  /** The hard timeout the seam contract says the caller owns. */
  placeTimeoutMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const DEFAULT_PLACE_TIMEOUT_MS = 10 * 60_000;

export class StampPlacementReconciler {
  private images: StampImageStore;
  private registry: StampRegistryStore;
  private driver: DevEnvDriver;
  private installScope: string;
  private source: { refresh(): Promise<void> } | null;
  private tickIntervalMs: number;
  private placeTimeoutMs: number;
  private listeners = new Set<(event: StampPlacementEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(config: StampPlacementConfig) {
    this.images = config.images;
    this.registry = config.registry;
    this.driver = config.driver;
    this.installScope = config.installScope;
    this.source = config.source ?? null;
    this.tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.placeTimeoutMs = config.placeTimeoutMs ?? DEFAULT_PLACE_TIMEOUT_MS;
  }

  onEvent(cb: (event: StampPlacementEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Boot sweep, before the interval starts — see the module header for why there is no age gate. */
  async adopt(): Promise<void> {
    const failed = await this.images.failAllPlacing(
      'host restarted mid-placement — the in-flight placement did not survive; ncl stamps place <id> re-runs the approved origin',
    );
    for (const row of failed) this.emit({ kind: 'image-failed', row });
    if (failed.length > 0) await this.refreshSource();
  }

  start(signal?: AbortSignal): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
    signal?.addEventListener('abort', () => this.stop());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reconcile pass; exposed for tests and for callers that want placement now, not next interval. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.reprobePlaced();
      const row = await this.images.oldestCurrentPending();
      if (row) await this.place(row);
    } catch (error) {
      log.warn('Dev-env: placement reconcile failed', { error: String(error) });
    } finally {
      this.inFlight = false;
    }
  }

  // ---------- internals ----------

  private async place(row: StampImageRow): Promise<void> {
    const spec = await this.placeSpec(row);
    if (typeof spec === 'string') {
      // A row the reconciler cannot even build a spec from is failed WITH the
      // reason — never skipped silently (a skipped head row would wedge the
      // concurrency-1 queue behind it forever).
      this.emit({ kind: 'image-failed', row: await this.images.markFailed(row.stampId, row.version, spec) });
      await this.refreshSource();
      return;
    }
    if (!(await this.images.markPlacing(row.stampId, row.version))) return; // a racer won the flip
    try {
      const { storeId } = await this.withTimeout(this.driver.placeImage!(spec));
      const placed = await this.images.markPlaced(row.stampId, row.version, storeId);
      if (placed.digestChangedAt && placed.priorDigest) {
        // Digest-change visibility (the C1 lesson): never absorbed silently.
        log.warn('Dev-env: re-place landed a DIFFERENT digest for the same version', {
          stamp: row.stampId,
          version: row.version,
          prior: placed.priorDigest,
          digest: placed.digest ?? undefined,
        });
      }
      this.emit({ kind: 'image-placed', row: placed });
    } catch (error) {
      const failed = await this.images.markFailed(row.stampId, row.version, String(error).slice(0, 500));
      this.emit({ kind: 'image-failed', row: failed });
    }
    await this.refreshSource();
  }

  /** The fully-resolved spec, or the failure reason when the row cannot yield one. */
  private async placeSpec(row: StampImageRow): Promise<DriverPlaceSpec | string> {
    if (!this.driver.placeImage) {
      return `driver '${this.driver.kind}' has no placement verb — its capabilities do not realize the ${row.origin} origin`;
    }
    if (row.origin !== 'pull') {
      return `the ${row.origin} origin is not realized on this deployment`;
    }
    const digest = imageRefDigest(row.sourceRef);
    if (!digest) {
      return `placement row carries no signed digest in '${row.sourceRef}' — re-approve via stamps update so resolution pins one`;
    }
    const registered = await this.registry.get(row.stampId);
    const config: K8sStampConfig | undefined = registered?.config;
    const origin = config ? stampImageOrigin(config) : undefined;
    return {
      stampId: row.stampId,
      version: row.version,
      ref: row.ref,
      labels: { [DEV_ENV_LABELS.install]: this.installScope, [DEV_ENV_LABELS.stamp]: row.stampId },
      origin: {
        kind: 'pull',
        digest,
        sourceRef: row.sourceRef,
        // The credential NAME rides the spec (custody holds the value): read
        // from the LIVE config, so a rotated credential name applies to the
        // next placement without a new approval — the digest, not the
        // credential, is what approval signed.
        ...(origin?.kind === 'pull' && origin.credential ? { credential: origin.credential } : {}),
      },
    };
  }

  /**
   * The re-probe: `placed` is a database claim about a store whose eviction
   * policy the platform does not own (kubelet image GC). A driver without a
   * cheap truthful probe declines the verb and this leg stands down — a
   * guessed "absent" would close the claim gate over a live image. Probe
   * WEATHER never flips a row: only a confident absence does.
   */
  private async reprobePlaced(): Promise<void> {
    if (!this.driver.probeImage) return;
    let flipped = false;
    for (const row of await this.images.currentPlaced()) {
      let present: boolean;
      try {
        present = await this.driver.probeImage(row.ref);
      } catch (error) {
        log.warn('Dev-env: placed-image re-probe failed; leaving the row placed', {
          stamp: row.stampId,
          version: row.version,
          error: String(error),
        });
        continue;
      }
      if (present) continue;
      await this.images.resetToPending(
        row.stampId,
        row.version,
        'evicted from the driver store (image GC); re-placing the approved digest',
      );
      log.warn('Dev-env: placed image evicted from the store; claim gate closed, re-placing', {
        stamp: row.stampId,
        version: row.version,
        ref: row.ref,
      });
      flipped = true;
    }
    if (flipped) await this.refreshSource();
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`placement timed out after ${this.placeTimeoutMs}ms`)),
        this.placeTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refreshSource(): Promise<void> {
    try {
      await this.source?.refresh();
    } catch (error) {
      log.warn('Dev-env: stamp source refresh after placement transition failed', { error: String(error) });
    }
  }

  private emit(event: StampPlacementEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's bug must not break the placement queue.
      }
    }
  }
}

/**
 * The service's C15 claim-gate hook, composed from the registry + ledger.
 * Null = the claim may proceed: code-provided ids (`reservedIds`), unknown
 * ids (the driver's stamp-unknown refusal is the right one), retired rows
 * (likewise), node-local and imageless shapes. Pull-origin rows answer from
 * their placement row — and an approved pull row with NO record refuses with
 * the honest predates-the-path message rather than a fake pending.
 */
export function makeStampImageGate(deps: {
  registry: StampRegistryStore;
  images: StampImageStore;
  reservedIds: () => string[];
  /**
   * The code-provided table, so a BUILTIN's node-image assertion is gated
   * too: the mute failure this closes (a node-imported image that never
   * arrived) was first recorded against a builtin, and a gate that only ever
   * looked at rows would have missed it.
   */
  codeProvided?: (stampId: string) => K8sStampConfig | undefined;
  /** The driver's bulk node-image probe; absent = the assertion cannot be answered (see NodeImageProbe). */
  probeNodeImages?: NodeImageProbe;
}): (stampId: string) => Promise<string | null> {
  return async (stampId: string) => {
    const reserved = deps.reservedIds().includes(stampId);
    const row = reserved ? undefined : await deps.registry.get(stampId);
    const config = reserved ? deps.codeProvided?.(stampId) : row?.state === 'active' ? row.config : undefined;
    if (!config) return null;
    // The node-presence assertion, answered LIVE at the claim rather than off
    // the reconcile snapshot: this is the difference between "refused in
    // seconds, naming the image to import" and a ten-minute boot budget spent
    // on ImagePullBackOff, so it is worth one node read.
    const missing = await missingNodeImages(stampId, config, deps.probeNodeImages);
    if (missing) return missing;
    if (!row) return null;
    if (stampImageOrigin(config).kind !== 'pull') return null;
    const image = await deps.images.get(stampId, row.version);
    if (!image) return imageGateNoRecord(stampId, row.version);
    return imageGateRefusal(image);
  };
}

/** The refusal text for a stamp whose declared node images are not all there — or null. */
async function missingNodeImages(
  stampId: string,
  config: K8sStampConfig,
  probe: NodeImageProbe | undefined,
): Promise<string | null> {
  const declared = config.nodeImages ?? [];
  if (declared.length === 0 || !probe) return null;
  let missing: string[];
  try {
    missing = await probe(declared);
  } catch (error) {
    // Weather never refuses a claim — the same rule the placed-image re-probe
    // holds. An unreadable node is not an absent image.
    log.warn('Dev-env: node-image gate probe failed; letting the claim through', {
      stamp: stampId,
      error: String(error),
    });
    return null;
  }
  if (missing.length === 0) return null;
  return (
    `stamp '${stampId}' declares ${declared.length} node-local image(s) and this node's store is missing ` +
    `${missing.length}: ${missing.join(', ')} — nothing pulls at claim time, so import them on the node ` +
    `(docker save | ctr images import) and claim again.`
  );
}

/**
 * Placement completions reach the session that registered the stamp on the
 * SAME transport claim completions ride (#223 / D18): one notification
 * mechanism, two subscribers. A row without a recorded session (host
 * callers, pre-C15 rows) notifies nobody — the operator polls `stamps get`.
 */
export function wireStampPlacementPush(
  reconciler: StampPlacementReconciler,
  deliver: ClaimPushDeliver = deliverClaimPushToSession,
): () => void {
  return reconciler.onEvent((event) => {
    if (!event.row.claimantSessionId) return;
    void deliver(event.row.claimantSessionId, placementPushText(event)).catch((error) => {
      log.warn('Dev-env: placement push not delivered', {
        stamp: event.row.stampId,
        version: event.row.version,
        error: String(error),
      });
    });
  });
}

function placementPushText(event: StampPlacementEvent): string {
  const { row } = event;
  if (event.kind === 'image-placed') {
    return (
      `Stamp '${row.stampId}' v${row.version} image placed — pulled from ${row.sourceRef}. ` +
      `Claims are open: ncl envs claim --stamp ${row.stampId}`
    );
  }
  // The reason travels ON the push (#20's recorded why), same rule as the
  // claim-failure push.
  return (
    `Stamp '${row.stampId}' v${row.version} image placement failed — ${row.error ?? 'no reason recorded'}. ` +
    `Not claimable at v${row.version}; ncl stamps place ${row.stampId} re-runs the approved pull once the cause is fixed.`
  );
}
