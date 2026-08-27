/**
 * Session events hub — the ONE trunk layer that turns a driver's best-effort
 * watch stream into the supervised handle's `onTerminal`.
 *
 * Drivers emit hints for ALL observed terminal transitions, with no intent
 * filtering and no delivery guarantees (drop, duplicate, coalesce, unknown
 * keys — see `SessionEvent`). Everything on top of that lives here, once, for
 * every driver:
 *
 * - truth: an event is never acted on directly — the hub re-reads the
 *   handle's `status()` and fires only on a confirmed end, which is what
 *   keeps replayed watch events (watch transports re-send existing state on
 *   reconnect; docker events can duplicate) from firing terminals for sessions that still run. A
 *   hint landing while a read is in flight queues one re-check — the read may
 *   have snapshotted a truth older than the hint;
 * - at-most-once: one terminal delivery per incarnation, however many hints;
 * - stop-intent: `onTerminal` fires only for ends the host did NOT request
 *   via `stop()`. The hub observes `stop()` through the handles it wraps, so
 *   the wrapper is applied at the driver boundary (`createSessionDriver`) —
 *   every handle a consumer can reach, prepared or adopted, is a wrapped one;
 * - arming order: a terminal confirmed before `onTerminal` is armed is
 *   buffered per key and delivered on registration, so adoption cannot lose
 *   an end that lands between `listSessions()` and arming.
 */
import type {
  SessionDriver,
  SessionEvent,
  SessionExecSpec,
  SessionFailure,
  SessionHandle,
  SessionKey,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
  SessionWatch,
} from './types.js';

/**
 * What consumers hold after the hub wraps a driver: the raw contract plus
 * `onTerminal` — at-most-once, verified-against-truth, stop-intent-suppressed.
 * Drivers never implement this; it exists only on hub-wrapped handles.
 */
export interface SupervisedHandle extends SessionHandle {
  /** Fires at most once, on any end the host did not request via stop(). */
  onTerminal(cb: (failure?: SessionFailure) => void): void;
}

export interface SupervisedSnapshot extends Omit<SessionSnapshot, 'handle'> {
  handle: SupervisedHandle;
}

export interface SessionEventsDriver extends SessionDriver {
  prepare(spec: SessionSpec): Promise<SupervisedHandle>;
  listSessions(installSlug: string): Promise<SupervisedSnapshot[]>;
  /**
   * Re-list and reconcile terminals the watch stream may have missed (r4).
   * Deliberately not periodic machinery: wire it where a re-list is already
   * cheap — the adoption path does. Sessions the host itself stopped are
   * intent-suppressed like any other terminal.
   */
  resync(installSlug: string): Promise<void>;
}

/** Raw fakes installed via `resetSessionDriver` are not hubs; probe, never assume. */
export function isSessionEventsDriver(driver: SessionDriver): driver is SessionEventsDriver {
  return typeof (driver as Partial<SessionEventsDriver>).resync === 'function';
}

function idOf(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

interface KeyState {
  /** Latest inner (unwrapped) handle for this key — the truth-read channel. */
  handle: SessionHandle;
  cb: ((failure?: SessionFailure) => void) | null;
  stopIntent: boolean;
  fired: boolean;
  /** Terminal confirmed before a callback was armed; delivered on arming. */
  pending?: { failure?: SessionFailure };
  verifying: boolean;
  /** A hint landed mid-verify; re-read truth once the in-flight read returns. */
  recheck: boolean;
}

class SessionEventsHub {
  readonly #states = new Map<string, KeyState>();
  readonly #watches = new Map<string, SessionWatch>();

  constructor(private readonly driver: SessionDriver) {}

  /** A fresh incarnation resets the key: fired/stop-intent belong to the old one. */
  trackPrepared(handle: SessionHandle): void {
    this.#states.set(idOf(handle.key), {
      handle,
      cb: null,
      stopIntent: false,
      fired: false,
      verifying: false,
      recheck: false,
    });
  }

  /** A listed handle refreshes the truth-read channel without resetting state. */
  trackListed(handle: SessionHandle): void {
    const state = this.#states.get(idOf(handle.key));
    if (state) state.handle = handle;
    else this.trackPrepared(handle);
  }

  arm(key: SessionKey, cb: (failure?: SessionFailure) => void): void {
    const state = this.#states.get(idOf(key));
    if (!state) return; // only handles this hub wrapped can register
    state.cb = cb;
    this.#ensureWatch(key.installSlug);
    if (state.pending) {
      const { failure } = state.pending;
      state.pending = undefined;
      queueMicrotask(() => cb(failure));
    }
  }

  /** Intent first: events the teardown itself provokes must already be suppressed. */
  markStopIntent(key: SessionKey): void {
    const state = this.#states.get(idOf(key));
    if (state) state.stopIntent = true;
  }

  async resync(installSlug: string): Promise<void> {
    const armed = [...this.#states.values()].filter(
      (s) => s.handle.key.installSlug === installSlug && s.cb && !s.fired && !s.stopIntent,
    );
    if (armed.length === 0) return;
    const snapshots = await this.driver.listSessions(installSlug);
    const byId = new Map(snapshots.map((s) => [idOf(s.handle.key), s]));
    for (const state of armed) {
      const snapshot = byId.get(idOf(state.handle.key));
      if (snapshot && snapshot.phase !== 'terminal') continue; // still live — nothing was missed
      if (snapshot) this.#deliver(state, snapshot.failure);
      else await this.#verify(state); // gone from the list — confirm via the handle's own truth read
    }
  }

  #ensureWatch(installSlug: string): void {
    if (this.#watches.has(installSlug)) return;
    // Minimal test fakes may lack watchSessions; the hub must not crash on them.
    if (typeof this.driver.watchSessions !== 'function') return;
    this.#watches.set(
      installSlug,
      this.driver.watchSessions(installSlug, (event) => this.#onEvent(event)),
    );
  }

  #onEvent(event: SessionEvent): void {
    if (event.kind !== 'terminal') return; // phase/hint carry nothing onTerminal acts on
    const state = this.#states.get(idOf(event.key));
    if (!state) return; // hints may reference keys we never handed out
    void this.#verify(state);
  }

  /** The hint discipline: re-read truth, then (maybe) fire — never fire on the event alone. */
  async #verify(state: KeyState): Promise<void> {
    if (state.fired || state.stopIntent) return;
    if (state.verifying) {
      // Never drop a hint into an in-flight read: on a driver whose status()
      // is a remote round trip, the read may have snapshotted
      // 'running' before this hint's death happened. Queue one re-check; the
      // loop below drains it.
      state.recheck = true;
      return;
    }
    state.verifying = true;
    try {
      do {
        state.recheck = false;
        try {
          const status = await state.handle.status();
          if (status.phase === 'stopped' || status.phase === 'failed') {
            this.#deliver(state, status.phase === 'failed' ? status.failure : undefined);
            return;
          }
          // spurious or replayed hint — unless a newer hint queued a re-check
        } catch {
          /* truth read failed; a queued hint re-reads, else the next hint or resync retries */
        }
      } while (state.recheck && !state.fired && !state.stopIntent);
    } finally {
      state.verifying = false;
    }
  }

  #deliver(state: KeyState, failure?: SessionFailure): void {
    if (state.fired || state.stopIntent) return;
    state.fired = true;
    if (state.cb) state.cb(failure);
    else state.pending = { failure };
  }
}

class HubHandle implements SupervisedHandle {
  constructor(
    private readonly inner: SessionHandle,
    private readonly hub: SessionEventsHub,
  ) {}

  get key(): SessionKey {
    return this.inner.key;
  }
  get name(): string {
    return this.inner.name;
  }
  start(): Promise<void> {
    return this.inner.start();
  }
  status(): Promise<SessionStatus> {
    return this.inner.status();
  }
  execSpec(command: string[]): SessionExecSpec {
    return this.inner.execSpec(command);
  }
  stop(reason: string): Promise<void> {
    this.hub.markStopIntent(this.inner.key);
    return this.inner.stop(reason);
  }
  onTerminal(cb: (failure?: SessionFailure) => void): void {
    this.hub.arm(this.inner.key, cb);
  }
}

/**
 * Wrap a driver so every handle it hands out routes `onTerminal` and stop
 * intent through one shared hub. Applied by `createSessionDriver` to whatever
 * the registry's factory produced — overlays get the hub for free.
 */
export function withSessionEvents(driver: SessionDriver): SessionEventsDriver {
  const hub = new SessionEventsHub(driver);
  const wrapped: SessionEventsDriver = {
    kind: driver.kind,
    capabilities: () => driver.capabilities(),
    prepare: async (spec) => {
      const handle = await driver.prepare(spec);
      hub.trackPrepared(handle);
      return new HubHandle(handle, hub);
    },
    listSessions: async (installSlug) =>
      (await driver.listSessions(installSlug)).map((snapshot): SupervisedSnapshot => {
        hub.trackListed(snapshot.handle);
        return { ...snapshot, handle: new HubHandle(snapshot.handle, hub) };
      }),
    watchSessions: (installSlug, onEvent) => driver.watchSessions(installSlug, onEvent),
    resync: (installSlug) => hub.resync(installSlug),
  };
  if (driver.ensureReady) wrapped.ensureReady = (): Promise<void> => driver.ensureReady!();
  if (driver.reapResidue) wrapped.reapResidue = (installSlug): Promise<void> => driver.reapResidue!(installSlug);
  return wrapped;
}
