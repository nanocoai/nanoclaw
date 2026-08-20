/**
 * The session-events hub — the ONE trunk layer behind `onTerminal`.
 *
 * These cases pin the hub's own obligations against a scripted driver, so
 * they hold for every driver at once: hints are never acted on without a
 * truth read, delivery is at-most-once per incarnation, stop-intent observed
 * through any wrapped handle suppresses, pre-arming terminals are buffered,
 * and resync reconciles what the stream dropped. The docker realization of
 * the stream itself is covered in `docker-driver.test.ts`; the consumer-facing
 * floor is in `conformance.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { isSessionEventsDriver, withSessionEvents, type SupervisedHandle } from './session-events.js';
import { fixtureSpec } from './spec-fixture.js';
import type {
  DriverCapabilities,
  SessionDriver,
  SessionEvent,
  SessionHandle,
  SessionKey,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
} from './types.js';

function makeKey(sessionId: string): SessionKey {
  return { installSlug: 'spike', agentGroupId: 'g1', sessionId };
}

class FakeHandle implements SessionHandle {
  /** What the next truth read reports — the hub must believe this, not the hint. */
  statusValue: SessionStatus = { phase: 'running' };
  /** When set, each status() blocks until the test settles it — an async truth read. */
  manualStatus = false;
  readonly pendingStatus: Array<{ resolve: (status: SessionStatus) => void; reject: (err: Error) => void }> = [];
  readonly stops: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name = `ncl-${sessionIdOf(key)}`,
  ) {}

  async start(): Promise<void> {}
  async status(): Promise<SessionStatus> {
    if (this.manualStatus) {
      return new Promise((resolve, reject) => this.pendingStatus.push({ resolve, reject }));
    }
    return this.statusValue;
  }
  async stop(reason: string): Promise<void> {
    this.stops.push(reason);
  }
  onTerminal(): void {
    throw new Error('raw handle onTerminal must never be reached');
  }
}

function sessionIdOf(key: SessionKey): string {
  return key.sessionId;
}

class FakeDriver implements SessionDriver {
  readonly kind = 'fake';
  nextPrepared: FakeHandle | null = null;
  snapshots: SessionSnapshot[] = [];
  listCalls = 0;
  watchCalls = 0;
  readonly subscribers = new Set<(event: SessionEvent) => void>();

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }
  async prepare(_spec: SessionSpec): Promise<SessionHandle> {
    return this.nextPrepared!;
  }
  async listSessions(): Promise<SessionSnapshot[]> {
    this.listCalls += 1;
    return this.snapshots;
  }
  watchSessions(_installSlug: string, onEvent: (event: SessionEvent) => void): { stop(): void } {
    this.watchCalls += 1;
    this.subscribers.add(onEvent);
    return { stop: () => this.subscribers.delete(onEvent) };
  }
  emit(event: SessionEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function prepared(
  driver: FakeDriver,
  sessionId: string,
): Promise<{ inner: FakeHandle; handle: SupervisedHandle; hub: ReturnType<typeof withSessionEvents> }> {
  const hub = withSessionEvents(driver);
  const inner = new FakeHandle(makeKey(sessionId));
  driver.nextPrepared = inner;
  const handle = await hub.prepare(fixtureSpec());
  return { inner, handle, hub };
}

describe('hint discipline: events are re-read, never acted on', () => {
  it('does not fire while the truth read still says running', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    // A replayed/spurious hint (watch transports re-send existing state on reconnect).
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();
    expect(terminal).not.toHaveBeenCalled();

    inner.statusValue = { phase: 'stopped' };
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();
    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('delivers a confirmed failure at most once, however many hints arrive', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    const failure = { kind: 'started-then-died' as const, retryable: false as const, exitCode: 3 };
    inner.statusValue = { phase: 'failed', failure };
    driver.emit({ key: inner.key, kind: 'terminal' });
    driver.emit({ key: inner.key, kind: 'terminal' });
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();

    expect(terminal).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('re-checks a hint that lands during an in-flight truth read instead of dropping it', async () => {
    // On a driver whose status() is a remote round trip, a
    // replayed hint's read can snapshot 'running' before the incarnation
    // actually dies — and the real death hint then arrives mid-read. Dropping
    // it would leave the session 'active' until the heartbeat sweep.
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    inner.manualStatus = true;
    driver.emit({ key: inner.key, kind: 'terminal' }); // replayed hint — read goes in flight
    await settled();
    driver.emit({ key: inner.key, kind: 'terminal' }); // the real death, mid-read
    await settled();
    expect(inner.pendingStatus).toHaveLength(1); // queued, not raced into a second read
    inner.pendingStatus.shift()!.resolve({ phase: 'running' }); // pre-death truth
    await settled();

    expect(inner.pendingStatus).toHaveLength(1); // the queued hint re-read
    inner.pendingStatus.shift()!.resolve({ phase: 'stopped' });
    await settled();

    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('a hint queued behind a failed truth read still re-reads', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    inner.manualStatus = true;
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();
    driver.emit({ key: inner.key, kind: 'terminal' });
    inner.pendingStatus.shift()!.reject(new Error('apiserver hiccup'));
    await settled();
    inner.pendingStatus.shift()!.resolve({ phase: 'stopped' });
    await settled();

    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('ignores hints for keys it never handed out', async () => {
    const driver = new FakeDriver();
    const { handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    driver.emit({ key: makeKey('someone-else'), kind: 'terminal' });
    await settled();

    expect(terminal).not.toHaveBeenCalled();
  });
});

describe('stop-intent suppression is hub-owned', () => {
  it('suppresses the terminal for a stop requested through the wrapped handle', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    await handle.stop('host-shutdown');
    inner.statusValue = { phase: 'stopped' };
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();

    expect(inner.stops).toEqual(['host-shutdown']);
    expect(terminal).not.toHaveBeenCalled();
  });

  it('sees stop() on adopted handles too — the wrapper rides the driver boundary', async () => {
    const driver = new FakeDriver();
    const hub = withSessionEvents(driver);
    const inner = new FakeHandle(makeKey('s1'));
    driver.snapshots = [{ handle: inner, phase: 'running' }];

    const [{ handle }] = await hub.listSessions('spike');
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.stop('orphan-at-startup');
    inner.statusValue = { phase: 'stopped' };
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();

    expect(inner.stops).toEqual(['orphan-at-startup']);
    expect(terminal).not.toHaveBeenCalled();
  });
});

describe('arming order', () => {
  it('buffers a terminal confirmed before onTerminal is armed and delivers on arming', async () => {
    const driver = new FakeDriver();
    // Arming any key starts the install-wide subscription; the second key's
    // end then lands before its own callback exists — the adoption gap.
    const first = await prepared(driver, 's1');
    first.handle.onTerminal(vi.fn());

    const second = new FakeHandle(makeKey('s2'));
    driver.nextPrepared = second;
    const handle = await first.hub.prepare(fixtureSpec());
    second.statusValue = { phase: 'stopped' };
    driver.emit({ key: second.key, kind: 'terminal' });
    await settled();

    const late = vi.fn();
    handle.onTerminal(late);
    await settled();
    expect(late).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('a fresh incarnation resets fired and stop-intent for its key', async () => {
    const driver = new FakeDriver();
    const first = await prepared(driver, 's1');
    first.handle.onTerminal(vi.fn());
    await first.handle.stop('host-shutdown'); // old incarnation, host-requested end

    const secondInner = new FakeHandle(makeKey('s1'));
    driver.nextPrepared = secondInner;
    const handle = await first.hub.prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    secondInner.statusValue = { phase: 'stopped' };
    driver.emit({ key: secondInner.key, kind: 'terminal' });
    await settled();

    // The old incarnation's stop-intent must not swallow the new one's end.
    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});

describe('resync', () => {
  it('delivers a terminal the stream dropped, once', async () => {
    const driver = new FakeDriver();
    const { inner, handle, hub } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    const failure = { kind: 'started-then-died' as const, retryable: false as const, exitCode: 9 };
    driver.snapshots = [{ handle: inner, phase: 'terminal', failure }];
    await hub.resync('spike');
    await hub.resync('spike');

    expect(terminal).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('confirms via the handle itself when the session is gone from the list', async () => {
    const driver = new FakeDriver();
    const { inner, handle, hub } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    driver.snapshots = []; // reaped runtime object: absence is the hint
    inner.statusValue = { phase: 'stopped' };
    await hub.resync('spike');

    expect(terminal).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('never re-fires for sessions the host itself stopped', async () => {
    const driver = new FakeDriver();
    const { inner, handle, hub } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    await handle.stop('orphan-at-startup');
    driver.snapshots = [{ handle: inner, phase: 'terminal' }];
    await hub.resync('spike');

    expect(terminal).not.toHaveBeenCalled();
  });

  it('does not even re-list when nothing is armed — no periodic machinery to feed', async () => {
    const driver = new FakeDriver();
    const hub = withSessionEvents(driver);
    await hub.resync('spike');
    expect(driver.listCalls).toBe(0);
  });
});

describe('wrapper shape', () => {
  it('shares ONE watch subscription per install across every armed session', async () => {
    const driver = new FakeDriver();
    const first = await prepared(driver, 's1');
    first.handle.onTerminal(vi.fn());
    const secondInner = new FakeHandle(makeKey('s2'));
    driver.nextPrepared = secondInner;
    const handle = await first.hub.prepare(fixtureSpec());
    handle.onTerminal(vi.fn());

    expect(driver.watchCalls).toBe(1);
  });

  it('survives a minimal driver without watchSessions instead of crashing arming', async () => {
    const driver = new FakeDriver();
    (driver as { watchSessions?: unknown }).watchSessions = undefined;
    const { handle } = await prepared(driver, 's1');
    expect(() => handle.onTerminal(vi.fn())).not.toThrow();
  });

  it('is probe-detectable, and raw drivers are not', () => {
    const driver = new FakeDriver();
    expect(isSessionEventsDriver(driver)).toBe(false);
    expect(isSessionEventsDriver(withSessionEvents(driver))).toBe(true);
  });

  it('only mirrors the optional surface the inner driver actually has', () => {
    const driver = new FakeDriver();
    const wrapped = withSessionEvents(driver);
    // adoptRunningSessions gates on `driver.reapResidue?.` — a wrapper that
    // invents the method would shell a cleanup the driver cannot do.
    expect(wrapped.reapResidue).toBeUndefined();
    expect(wrapped.ensureReady).toBeUndefined();
    expect(wrapped.kind).toBe('fake');
  });
});
