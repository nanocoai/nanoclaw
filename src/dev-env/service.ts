/**
 * Dev-env service — the host's claim surface (D11, D12, D18, D21).
 *
 * Composes the durable registry (identity, ownership, lifetime) with a driver
 * (realization). The ordering that matters is claim-time crash safety: intent
 * is PERSISTED before the driver is asked for anything, so a host that dies
 * mid-claim leaves a 'claiming' row adoption can judge against the runtime —
 * an instance that survived is re-adopted (the driver's resume converges it
 * idempotently), one that did not is failed loudly, never re-minted.
 *
 * Lifetime semantics live entirely here (D12: the host owns the coupling):
 * - bound: released when the owner goes — callers invoke releaseBoundTo();
 *   which liveness means "gone" is the code-mode layer's knowledge (T2).
 * - ttl: reaped past its deadline, extendable while live.
 * - pinned: explicit release only; survives restarts by simply being a row.
 *
 * Events exist for D18's async story: a claim that completes after the claim
 * call returned reaches its agent as a session push (claim-notify.ts
 * subscribes; this module only emits — it records WHO waits, never how to
 * reach them).
 */
import { randomUUID } from 'node:crypto';

import type { DbDriver } from '../db/driver.js';
import { log } from '../log.js';

import { DevEnvStore, type EnvRow, type EnvState, type ReleaseCause } from './db.js';
import {
  claimantGroupSelector,
  devEnvFailureDetail,
  devEnvLabels,
  isDevEnvFailure,
  type DevEnvDriver,
  type DevEnvFailure,
  type DevEnvInstanceHandle,
  type DriverClaimSpec,
  type EnvKey,
  type ExposureTargetResolution,
} from './types.js';

export interface EnvSnapshot {
  envId: string;
  ownerRef: string;
  stampId: string;
  /** Which registry definition realized the claim; null = a code-provided stamp. */
  stampVersion: number | null;
  lifetime: EnvRow['lifetime'];
  state: EnvState;
  instanceId: string | null;
  /** Populated only while the current instance is live and ready. */
  endpoints: Record<string, string>;
  access: Record<string, string>;
  createdAt: string;
  releaseCause: ReleaseCause | null;
  /** Why a failed env failed (#20): taxonomy kind + human detail, as recorded on the row. */
  failureKind: string | null;
  failureDetail: string | null;
  /**
   * The session the D18 push will tell when this claim settles — set only when
   * the claim was still in flight as its call returned (a synchronous answer
   * needs no push). Null on host claims: the operator polls.
   */
  claimantSessionId: string | null;
}

export type DevEnvEvent =
  | { kind: 'env-ready'; env: EnvSnapshot }
  | { kind: 'env-failed'; env: EnvSnapshot; failure: DevEnvFailure }
  | { kind: 'env-released'; env: EnvSnapshot; cause: ReleaseCause };

/**
 * Awaited before an env's instance is torn down (see `onBeforeEnvEnd`). A
 * throwing hook must not strand an env: callers log and continue, because a
 * failure to close a hole cannot become a failure to release a machine.
 */
export type EnvEndingHook = (envId: string, ending: 'released' | 'failed') => Promise<void>;

export interface ClaimRequest {
  ownerRef: string;
  stampId: string;
  lifetime: { mode: 'bound' } | { mode: 'ttl'; ttlMs: number } | { mode: 'pinned' };
  options?: Record<string, string>;
  /**
   * The session waiting on this claim (D18): when the claim is still in flight
   * as the call returns, it is recorded on the row and every terminal
   * transition is pushed there instead of leaving the agent to poll. A HOST
   * concept through and through — it never crosses the driver seam
   * (`driverSpec` builds the spec field by field, and DriverClaimSpec has no
   * session to put it in).
   */
  claimantSessionId?: string;
}

export interface DevEnvServiceConfig {
  db: DbDriver;
  driver: DevEnvDriver;
  installScope: string;
  /**
   * The namespace this install's agent session pods run in — set only when
   * sessions are pod-realized (the k8s overlay). It is the WHERE half of
   * claimant placement (D19); the WHO half — the GROUP-granular selector —
   * rides every claim regardless, because a driver on a flat runtime needs
   * the claimant just as much and has no scope to be told about. Unset means
   * a driver that requires a scope authors nothing, which fails closed.
   */
  claimantNamespace?: string;
  /** Injectable for tests; TTL math never reads the wall clock directly. */
  now?: () => number;
  reapIntervalMs?: number;
  /**
   * The stamps registry's provenance answer: which approved definition
   * version a stamp id resolves to right now (undefined/null = a
   * code-provided stamp). Recorded on the claim row — the registry is a
   * HOST concept, so the lookup lives here and never crosses the driver seam.
   */
  resolveStampVersion?: (stampId: string) => Promise<number | null | undefined>;
  /**
   * The C15 approve-to-place gate: the refusal text for a stamp whose image
   * is not yet in the driver's store, or null when the claim may proceed
   * (placed, node-local, code-provided, unknown — the driver's own refusal
   * covers unknown). Answered ABOVE the driver seam so the refusal lands in
   * seconds with the placement state on it, never as a boot timeout — the
   * whole of #22 for the common case. Deliberately unguarded: this reads the
   * same registry the claim is about to write, and degrading open would hand
   * out exactly the timeout the gate exists to kill.
   */
  imageGate?: (stampId: string) => Promise<string | null>;
}

const DEFAULT_REAP_INTERVAL_MS = 30_000;

export class DevEnvService {
  private store: DevEnvStore;
  private driver: DevEnvDriver;
  private installScope: string;
  private claimantNamespace: string | null;
  private now: () => number;
  private reapIntervalMs: number;
  private resolveStampVersion: ((stampId: string) => Promise<number | null | undefined>) | null;
  private imageGate: ((stampId: string) => Promise<string | null>) | null;
  private handles = new Map<string, DevEnvInstanceHandle>();
  private listeners = new Set<(event: DevEnvEvent) => void>();
  private endingHooks = new Set<EnvEndingHook>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(config: DevEnvServiceConfig) {
    this.store = new DevEnvStore(config.db);
    this.driver = config.driver;
    this.installScope = config.installScope;
    this.claimantNamespace = config.claimantNamespace ?? null;
    this.now = config.now ?? Date.now;
    this.reapIntervalMs = config.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.resolveStampVersion = config.resolveStampVersion ?? null;
    this.imageGate = config.imageGate ?? null;
  }

  onEvent(cb: (event: DevEnvEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Called on every path that ENDS an env — release, TTL reap, bound-owner
   * release, terminal failure — BEFORE the instance is torn down, and awaited.
   * The closeClaimRoute ordering, generalized: reachability must not outlive
   * the instance, not even for the window a teardown takes. Deliberately not
   * an event: `emit` is fire-and-forget, and a hole that closes "eventually"
   * is a hole that was open when the instance went away.
   *
   * Supersession is NOT an ending (D21) — `reclaimInstance` releases the old
   * handle without firing this, so a live env's exposure is PARKED across the
   * gap rather than revoked.
   */
  onBeforeEnvEnd(hook: EnvEndingHook): () => void {
    this.endingHooks.add(hook);
    return () => this.endingHooks.delete(hook);
  }

  /**
   * Resolve one exposure's target inside this env's current instance (C14).
   * Rides the driver's optional handle capability: called at grant with the
   * port alone to freeze a service name, and per connection with that frozen
   * name for the address to dial NOW. Null = no live handle or a MISS, which
   * every caller treats as a refused connection; `undefined` = this driver
   * does not resolve targets at all, which is a grant-time refusal and not a
   * miss (the two must not be confused: one is "not there right now", the
   * other is "never could be").
   */
  async resolveExposureTarget(
    envId: string,
    request: { service?: string; port: number },
  ): Promise<ExposureTargetResolution | null | undefined> {
    const handle = this.handles.get(envId);
    if (!handle) return null;
    if (!handle.resolveExposureTarget) return undefined;
    return handle.resolveExposureTarget(request);
  }

  async claim(request: ClaimRequest): Promise<EnvSnapshot> {
    if (request.lifetime.mode === 'ttl' && request.lifetime.ttlMs <= 0) {
      throw new Error(`ttl lifetime requires a positive ttlMs, got ${request.lifetime.ttlMs}`);
    }
    // The C15 gate, BEFORE intent is persisted: a stamp whose image is not
    // placed cannot possibly realize, so this is an input refusal like the
    // ttl one above — instant, with the placement state and its start time on
    // it — not an env that failed. The gate opens at `placed`; #22's
    // approve-to-place window answers in seconds instead of a boot timeout.
    const gateRefusal = await this.imageGate?.(request.stampId);
    if (gateRefusal) throw new Error(gateRefusal);
    const envId = `env-${randomUUID()}`;
    const instanceId = `ins-${randomUUID()}`;
    const lifetime =
      request.lifetime.mode === 'ttl'
        ? ({ mode: 'ttl', expiresAtMs: this.now() + request.lifetime.ttlMs } as const)
        : request.lifetime;
    // Provenance resolved at claim: the registry version this stamp id means
    // RIGHT NOW (null = code-provided). Guarded — a registry blip must not
    // refuse a claim; it costs the row its version stamp, nothing else.
    const stampVersion = await this.resolveStampVersion?.(request.stampId)?.catch?.(() => null);
    // Intent first, driver second — the crash-safety ordering this module is built around.
    await this.store.insertEnv({
      envId,
      ownerRef: request.ownerRef,
      stampId: request.stampId,
      stampVersion: stampVersion ?? null,
      driverKind: this.driver.kind,
      lifetime,
      instanceId,
      claimOptions: request.options ?? {},
    });
    await this.claimInstance(envId, { envId, instanceId });
    // Arm the readiness push (D18) only if the claim is STILL in flight now
    // that the driver has answered: a synchronous settle (warm pool, instant
    // refusal) already told the caller everything in this call's own return,
    // and a push behind it would be noise. Armed AFTER the settle check, so a
    // completion that raced this write fired its event against an unarmed row
    // — the snapshot below then reports the terminal state instead of
    // promising a notification nobody will send.
    if (request.claimantSessionId && (await this.mustGet(envId)).state === 'claiming') {
      await this.store.setClaimantSession(envId, request.claimantSessionId);
    }
    return this.snapshot(envId);
  }

  async status(envId: string): Promise<EnvSnapshot> {
    return this.snapshot(envId);
  }

  async list(filter: { ownerRef?: string; live?: boolean } = {}): Promise<EnvSnapshot[]> {
    const rows = await this.store.listEnvs({
      ownerRef: filter.ownerRef,
      states: filter.live ? ['claiming', 'active'] : undefined,
    });
    return rows.map((row) => this.snapshotOfRow(row, null));
  }

  async release(envId: string, cause: ReleaseCause = 'requested'): Promise<void> {
    const row = await this.mustGet(envId);
    if (row.state === 'released') return; // the reaper and an explicit release both win
    // Reachability closes FIRST, before any teardown (C14) — an exposed port
    // must not outlive the instance it points into, not even by a finalizer.
    await this.runEndingHooks(envId, 'released');
    const handle = this.handles.get(envId);
    // Teardown before eviction: a throwing teardown must leave the handle in
    // the map, or the retry that follows finds nothing and completes as a
    // registry-only release while the instance keeps running.
    if (handle) await handle.release(cause);
    this.handles.delete(envId);
    if (row.currentInstanceId) await this.store.settleInstanceIfLive(row.currentInstanceId, 'released');
    await this.store.markReleased(envId, cause);
    this.emit({ kind: 'env-released', env: this.snapshotOfRow(await this.mustGet(envId), null), cause });
  }

  /** D13: flipping code mode off (or the owner sandbox ending) releases the owner's BOUND envs only. */
  async releaseBoundTo(ownerRef: string): Promise<void> {
    for (const row of await this.store.listEnvs({ ownerRef, states: ['claiming', 'active'] })) {
      if (row.lifetime.mode === 'bound') await this.release(row.envId, 'owner-released');
    }
  }

  async extend(envId: string, ttlMs: number): Promise<EnvSnapshot> {
    const row = await this.mustGet(envId);
    if (row.lifetime.mode !== 'ttl') {
      throw new Error(`env ${envId} has lifetime '${row.lifetime.mode}'; only ttl envs extend`);
    }
    if (row.state !== 'claiming' && row.state !== 'active') {
      throw new Error(`env ${envId} is ${row.state}; only live envs extend`);
    }
    if (ttlMs <= 0) throw new Error(`extend requires a positive ttlMs, got ${ttlMs}`);
    await this.store.extendTtl(envId, this.now() + ttlMs);
    return this.snapshot(envId);
  }

  /**
   * The succession primitive (D21): a fresh instance under the same env
   * identity. Dev flow uses it to recover a failed env; promotion (v2) grows
   * from it. The old instance is superseded — never mutated.
   */
  async reclaimInstance(envId: string): Promise<EnvSnapshot> {
    const row = await this.mustGet(envId);
    if (row.state === 'released') throw new Error(`env ${envId} is released; claim a new env instead`);
    const previous = this.handles.get(envId);
    this.handles.delete(envId);
    if (previous) await previous.release('superseded');
    const instanceId = `ins-${randomUUID()}`;
    await this.store.bindNewInstance(envId, instanceId);
    await this.claimInstance(envId, { envId, instanceId });
    return this.snapshot(envId);
  }

  /**
   * Startup re-adoption, from the host-lifecycle start callback. Reconciles
   * three truths that diverged while the host was down: what the registry
   * intended, what the runtime still runs, and what time has done to TTLs.
   */
  async adopt(): Promise<void> {
    // Adoption failures degrade, never abort: this runs from onHostStart,
    // where a throw is fatal to the whole host (startHostModules rethrows).
    // The session-adoption precedent warns and continues for the same reason —
    // one misbehaving driver answer must not crash-loop a host whose chat
    // surface is otherwise fine.
    let live: DevEnvInstanceHandle[];
    try {
      live = await this.driver.listInstances(this.installScope);
    } catch (error) {
      log.warn('Dev-env adoption skipped: driver discovery failed', { error: String(error) });
      return;
    }
    const liveByInstance = new Map(live.map((h) => [h.key.instanceId, h]));

    for (const row of await this.store.listEnvs({ states: ['claiming', 'active'] })) {
      const handle = row.currentInstanceId ? liveByInstance.get(row.currentInstanceId) : undefined;
      if (handle) {
        liveByInstance.delete(row.currentInstanceId!);
        if (row.state === 'claiming') {
          // An in-flight claim whose instance survived the restart: RE-ADOPT.
          // The driver's resume converges whatever the dying host left
          // half-done (idempotent — steps that already ran are no-ops), and
          // the adopted handle then waits out readiness on the same probe
          // path a fresh claim uses. Guarded: a converge blip must degrade
          // to a slower boot, never fail a healthy env — sweeping these rows
          // to failed over a live instance was the 13:15 lane-tick incident.
          await this.driver
            .resumeClaim?.(this.driverSpec(row, { envId: row.envId, instanceId: row.currentInstanceId! }))
            ?.catch((error) => {
              log.warn('Dev-env adoption: resume converge failed; the adopted handle keeps probing', {
                envId: row.envId,
                error: String(error),
              });
            });
        }
        await this.attachAdopted(row, handle).catch((error) => {
          log.warn('Dev-env adoption: attach failed for env', { envId: row.envId, error: String(error) });
        });
      } else if (row.state === 'claiming') {
        // In flight when the host died, and the runtime no longer holds it —
        // or never did. Fail loudly rather than mint a fresh instance the
        // claimant stopped waiting for (reclaimInstance is the sanctioned way
        // back); retryable, because a new claim faces none of this.
        await this.failEnv(row.envId, row.currentInstanceId, {
          kind: 'instantiation-failed',
          retryable: true,
          detail: 'host restarted mid-claim and the instance did not survive',
        });
      } else {
        // An active env whose instance vanished while we were down.
        await this.failEnv(row.envId, row.currentInstanceId, { kind: 'instance-died', retryable: false });
      }
    }

    // Runtime objects no live env accounts for: superseded instances a dying
    // host never tore down, releases that never finished. Their env's record
    // already holds the truth; the runtime side is residue.
    for (const orphan of liveByInstance.values()) {
      await orphan.release('adopt-reconcile').catch((error) => {
        log.warn('Dev-env adoption: orphan release failed', { instance: orphan.name, error: String(error) });
      });
    }
    await this.driver.reapResidue?.(this.installScope)?.catch((error) => {
      log.warn('Dev-env adoption: residue reap failed', { error: String(error) });
    });

    // Guarded like every other call above it, and for the same reason: this
    // one reaches the DRIVER too (an expired TTL is a release, and a release
    // is a teardown that can refuse — a docker network the operator attached
    // something to says so out loud). A TTL that cannot be reaped at boot is
    // reaped by the next reaper tick; a throw here would take the host down.
    try {
      await this.reapExpired();
    } catch (error) {
      log.warn('Dev-env adoption: expired-TTL reap failed; the reaper retries', { error: String(error) });
    }
  }

  /** TTL enforcement; adoption calls it for deadlines that passed while the host was down. */
  async reapExpired(): Promise<void> {
    for (const row of await this.store.listEnvs({ states: ['claiming', 'active'] })) {
      if (row.lifetime.mode === 'ttl' && row.lifetime.expiresAtMs <= this.now()) {
        await this.release(row.envId, 'ttl-expired');
      }
    }
  }

  startReaper(signal?: AbortSignal): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      // The same guard adopt()'s call carries, and it matters more here: a
      // `void`ed rejection off a timer is an UNHANDLED rejection, which ends
      // the process rather than the tick. One env whose teardown refuses must
      // cost the tick, never the host.
      void this.reapExpired().catch((error) => {
        log.warn('Dev-env reaper: expired-TTL reap failed; the next tick retries', { error: String(error) });
      });
    }, this.reapIntervalMs);
    this.reaper.unref?.();
    signal?.addEventListener('abort', () => this.stopReaper());
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }

  // ---------- internals ----------

  /**
   * The driver's view of one claim, rebuilt the same way every time it is
   * needed — the fresh claim and adoption's resume must present the SAME
   * spec, or the resume would converge toward a different env than the one
   * the row records.
   */
  private driverSpec(row: EnvRow, key: EnvKey): DriverClaimSpec {
    return {
      key,
      stampId: row.stampId,
      labels: devEnvLabels(this.installScope, key, row.stampId),
      options: row.claimOptions,
      // The owner, opaquely: a driver that mints access material keeps one
      // owner's out of another's reach by laying it out under this. Passed
      // exactly like stampId — the host says who, the driver decides how.
      materialsScope: row.ownerRef,
      // Claimant placement (D19): WHO is claiming, always — the GROUP's
      // workloads, derived from the same labels every session driver stamps,
      // so the reachability a driver authors from it survives a respawn.
      // Passed on the resume path too: adoption's converge is where missing
      // reachability gets healed. An ownerRef that is not a group (host
      // claims say HOST_OWNER_REF) selects nothing, which admits nobody —
      // fail-closed, never fail-open. That is an INVARIANT, not a naming
      // convention: createAgentGroup refuses the sentinel as a group id, so
      // no workload can ever wear the matching group label.
      claimantSelector: claimantGroupSelector(this.installScope, row.ownerRef),
      // WHERE, only for a runtime that scopes its selectors: set when this
      // install's sessions are scope-realized (the pod overlay's namespace),
      // absent on a flat runtime. A driver that needs a scope and gets none
      // authors nothing.
      ...(this.claimantNamespace ? { claimantNamespace: this.claimantNamespace } : {}),
    };
  }

  private async claimInstance(envId: string, key: EnvKey): Promise<void> {
    const row = await this.mustGet(envId);
    try {
      const handle = await this.driver.claim(this.driverSpec(row, key));
      await this.attach(envId, handle);
    } catch (error) {
      const failure: DevEnvFailure = isDevEnvFailure(error)
        ? error
        : { kind: 'unknown', retryable: false, opaqueRef: String(error) };
      await this.failEnv(envId, key.instanceId, failure);
      throw error;
    }
  }

  /** Wire a handle's transitions into the registry, then reconcile its current truth. */
  private async attach(envId: string, handle: DevEnvInstanceHandle): Promise<void> {
    const row = await this.mustGet(envId);
    if (row.state === 'released' || row.state === 'failed') {
      // The env ended while the driver was still realizing it — the reaper on
      // a short TTL, or releaseBoundTo when the owner died mid-claim. The row
      // already holds the ending's truth; the fresh instance is teardown debt.
      // Installing the handle instead would leave a live instance nothing can
      // reach: release() early-returns on ended envs, so only a restart's
      // adopt() sweep would ever collect it.
      await handle.release('released-mid-claim');
      await this.store.settleInstanceIfLive(handle.key.instanceId, 'released');
      return;
    }
    this.handles.set(envId, handle);
    // The seam's transition callbacks are synchronous (`() => void`) while the
    // settle they trigger is registry I/O, so a transition observed by the
    // driver lands in the registry a tick later — the same shape the session
    // hub's watch events already have.
    handle.onReady(() => void this.settleReady(envId, handle));
    handle.onTerminal((failure) => {
      if (this.currentHandleIs(envId, handle)) {
        void this.failEnv(envId, handle.key.instanceId, failure ?? { kind: 'instance-died', retryable: false });
      }
    });
    const status = await handle.status();
    if (status.phase === 'ready') await this.settleReady(envId, handle);
    else if (status.phase === 'failed') await this.failEnv(envId, handle.key.instanceId, status.failure);
  }

  private async attachAdopted(row: EnvRow, handle: DevEnvInstanceHandle): Promise<void> {
    // Discovery rebuilds a handle from runtime labels, which cannot say who
    // owns it — the registry can, and never forgot. Say it BEFORE attach, whose
    // first status() is what mints access material: told afterwards, the first
    // re-mint of an instance realized before the per-owner layout would land
    // where its owner's sandbox does not look.
    handle.setMaterialsScope?.(row.ownerRef);
    await this.attach(row.envId, handle);
    // A 'released' runtime answer would mean the runtime tore down without us;
    // attach() already settled ready/failed. Nothing else to reconcile: a
    // claiming env with a provisioning handle just keeps waiting — its
    // readiness now fires on the ADOPTED handle, which is the D18 story
    // surviving a restart.
    const status = await handle.status();
    if (status.phase === 'released') {
      await this.store.settleInstanceIfLive(handle.key.instanceId, 'released');
      await this.store.markReleased(row.envId, 'adopt-reconcile');
    }
  }

  private async settleReady(envId: string, handle: DevEnvInstanceHandle): Promise<void> {
    if (!this.currentHandleIs(envId, handle)) return;
    const row = await this.mustGet(envId);
    if (row.state !== 'claiming') return;
    await this.store.setInstanceState(handle.key.instanceId, 'ready');
    await this.store.setEnvState(envId, 'active');
    // The ready event carries the realized endpoints/access: the D18 push
    // tells a waiting agent what to connect to, not merely that it may now
    // poll for it. Re-probed defensively — a crash in the same tick answers
    // not-ready, and the event then carries the bare row honestly.
    const status = await handle.status();
    this.emit({
      kind: 'env-ready',
      env: this.snapshotOfRow(await this.mustGet(envId), status.phase === 'ready' ? status : null),
    });
  }

  private async failEnv(envId: string, instanceId: string | null, failure: DevEnvFailure): Promise<void> {
    const row = await this.mustGet(envId);
    if (row.state === 'released' || row.state === 'failed') return;
    // Same ordering as release: a failed env has no reachability to keep, and
    // the hole closes before the row's ending is recorded (C14).
    await this.runEndingHooks(envId, 'failed');
    if (instanceId) await this.store.settleInstanceIfLive(instanceId, 'failed', failure);
    // Reason and state are ONE write (#20): a failed row with no recorded why
    // was the whoami-acceptance hole — nothing to render, nothing to grep.
    await this.store.markFailed(envId, failure);
    this.handles.delete(envId);
    // The guaranteed host-log line for a failure, carrying the env id — the
    // acceptance grepped the host log for the failed id and found nothing.
    log.warn('Dev-env: env failed', {
      envId,
      instanceId,
      stamp: row.stampId,
      kind: failure.kind,
      detail: devEnvFailureDetail(failure) ?? undefined,
    });
    this.emit({ kind: 'env-failed', env: this.snapshotOfRow(await this.mustGet(envId), null), failure });
  }

  private async runEndingHooks(envId: string, ending: 'released' | 'failed'): Promise<void> {
    for (const hook of [...this.endingHooks]) {
      try {
        await hook(envId, ending);
      } catch (error) {
        // A hole we could not close must not become a machine we cannot
        // release: the hook's own ledger keeps the truth, and heal re-runs.
        log.warn('Dev-env: env-ending hook failed; continuing the teardown', {
          envId,
          ending,
          error: String(error),
        });
      }
    }
  }

  private currentHandleIs(envId: string, handle: DevEnvInstanceHandle): boolean {
    return this.handles.get(envId) === handle;
  }

  private async snapshot(envId: string): Promise<EnvSnapshot> {
    const row = await this.mustGet(envId);
    const handle = this.handles.get(envId);
    if (row.state === 'active' && handle) {
      const status = await handle.status();
      if (status.phase === 'ready') return this.snapshotOfRow(row, status);
    }
    return this.snapshotOfRow(row, null);
  }

  private snapshotOfRow(
    row: EnvRow,
    ready: { endpoints: Record<string, string>; access: Record<string, string> } | null,
  ): EnvSnapshot {
    return {
      envId: row.envId,
      ownerRef: row.ownerRef,
      stampId: row.stampId,
      stampVersion: row.stampVersion,
      lifetime: row.lifetime,
      state: row.state,
      instanceId: row.currentInstanceId,
      endpoints: ready?.endpoints ?? {},
      access: ready?.access ?? {},
      createdAt: row.createdAt,
      releaseCause: row.releaseCause,
      failureKind: row.failureKind,
      failureDetail: row.failureDetail,
      claimantSessionId: row.claimantSessionId,
    };
  }

  private async mustGet(envId: string): Promise<EnvRow> {
    const row = await this.store.getEnv(envId);
    if (!row) throw new Error(`no dev env ${envId}`);
    return row;
  }

  private emit(event: DevEnvEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's bug must not break lifetime enforcement.
      }
    }
  }
}
