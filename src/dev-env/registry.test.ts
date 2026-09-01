/**
 * Durable env registry + service — the T1 acceptance suite.
 *
 * Proves the four properties the seam exists for:
 * - the full claim/release/status lifecycle under all three lifetimes (D12)
 * - the async-pending claim path (D18)
 * - re-adoption across a host restart — a "restart" here is literal: new
 *   service objects over the same database and the same surviving runtime
 * - env identity ≠ instance identity (D21): an env outlives its instances
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';
import { log } from '../log.js';

import { DevEnvStore } from './db.js';
// Side-effect: registers the dev-env migration (and inert lifecycle hooks), so
// runMigrations' DEFAULT list below covers it — the house archetype, so a
// collision with an upstream migration fails THIS suite, not a future boot.
import { devEnvClaimantNamespace } from './index.js';
import { K8sDevEnvDriver } from './k8s-driver.js';
import { FakeKube } from './k8s-fake-kube.js';
import { MockDevEnvDriver, MockDevEnvRuntime, instanceName } from './mock-driver.js';
import { DevEnvService, type DevEnvEvent, type EnvSnapshot } from './service.js';
import { RegistryStampSource, StampRegistryStore } from './stamp-registry.js';
import { DEV_ENV_LABELS, HOST_OWNER_REF } from './types.js';

const INSTALL = 'registry-suite';
const STAMP = 'sample-app';

interface Fixture {
  db: DbDriver;
  runtime: MockDevEnvRuntime;
  clock: { now: () => number; advance: (ms: number) => void };
  /** A "host": one service + its driver. Call again to simulate a restart. */
  host(opts?: { manual?: boolean; claimGate?: () => Promise<void>; claimantNamespace?: string }): {
    service: DevEnvService;
    driver: MockDevEnvDriver;
    events: DevEnvEvent[];
  };
}

let fx: Fixture;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  const runtime = new MockDevEnvRuntime();
  let t = 1_000_000;
  fx = {
    db,
    runtime,
    clock: { now: () => t, advance: (ms) => (t += ms) },
    host(opts = {}) {
      const driver = new MockDevEnvDriver({
        installScope: INSTALL,
        runtime,
        knownStamps: [STAMP],
        manualCompletion: opts.manual ?? false,
        claimGate: opts.claimGate,
      });
      const service = new DevEnvService({
        db,
        driver,
        installScope: INSTALL,
        claimantNamespace: opts.claimantNamespace,
        now: fx.clock.now,
      });
      const events: DevEnvEvent[] = [];
      service.onEvent((e) => events.push(e));
      return { service, driver, events };
    },
  };
});
afterEach(async () => {
  await closeDb();
});

/**
 * A runtime transition (`boot`, `kill`) fires the seam's synchronous callback,
 * but the settle it triggers is registry I/O — so the registry row and the
 * event land a tick after the runtime moved. Same shape, same helper, as the
 * session driver's watch events (`settled` in drivers/conformance.test.ts).
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function boot(env: EnvSnapshot): void {
  fx.runtime.complete(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
}

/** The instance dies while nobody is listening — what "while the host was down" means. */
function dieSilently(env: EnvSnapshot): void {
  fx.runtime.instances.delete(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
}

describe('claim lifecycle', () => {
  it('a warm claim returns active with endpoints; release tears the runtime down', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    expect(env.state).toBe('active');
    expect(env.endpoints.app).toMatch(/^http:/);

    await service.release(env.envId);

    const after = await service.status(env.envId);
    expect(after.state).toBe('released');
    expect(after.releaseCause).toBe('requested');
    expect(fx.runtime.instances.size).toBe(0);
  });

  it('hands the driver the owner as an opaque materials scope', async () => {
    // A driver that mints access material lays it out under this, so one
    // owner's child credentials are not in a directory another owner's sandbox
    // could be handed. The mock mints nothing and only records it.
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    expect(instance?.materialsScope).toBe('g1');
  });

  it('passes the claimant on EVERY claim — GROUP-granular, so reachability survives a session respawn (D19)', async () => {
    const { service } = fx.host({ claimantNamespace: 'agents' });
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    expect(instance?.claimantNamespace).toBe('agents');
    // The session driver's stamped labels, at group granularity — install +
    // group + role, never the session label a respawned workload would shed.
    expect(instance?.claimantSelector).toEqual({
      'nanoclaw-install': INSTALL,
      'nanoclaw-group': 'g1',
      'nanoclaw-role': 'agent',
    });
  });

  it('passes the claimant with NO scope when sessions are not scope-realized — the flat-runtime shape', async () => {
    // WHO always crosses (an owner always exists and a docker-session host's
    // driver needs it to reach the claimant); WHERE crosses only when there
    // is a scope to name. A driver that requires one authors nothing.
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    expect(instance?.claimantNamespace).toBeUndefined();
    expect(instance?.claimantSelector).toEqual({
      'nanoclaw-install': INSTALL,
      'nanoclaw-group': 'g1',
      'nanoclaw-role': 'agent',
    });
  });

  it('a HOST claim selects nothing — the sentinel ownerRef is the fail-closed direction', async () => {
    // The selector rides every claim now, so the thing that keeps a host
    // claim from opening reachability is the SENTINEL: `operator` is a group
    // id the registry refuses to create, so no workload can wear the label.
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: HOST_OWNER_REF, stampId: STAMP, lifetime: { mode: 'pinned' } });

    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    expect(instance?.claimantSelector?.['nanoclaw-group']).toBe(HOST_OWNER_REF);
  });

  it('an async claim returns claiming and completes via the ready event (D18)', async () => {
    const { service, events } = fx.host({ manual: true });
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    expect(env.state).toBe('claiming');
    expect(env.endpoints).toEqual({});

    boot(env);
    await settled();

    expect(events.map((e) => e.kind)).toContain('env-ready');
    const after = await service.status(env.envId);
    expect(after.state).toBe('active');
    expect(after.endpoints.app).toBeDefined();
  });

  it('a refused claim marks the env failed and propagates the taxonomy error', async () => {
    const { service, driver } = fx.host();
    driver.failNextClaim({ kind: 'capacity-exhausted', retryable: true });

    await expect(service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } })).rejects.toMatchObject(
      { kind: 'capacity-exhausted', retryable: true },
    );

    const [failed] = await service.list({ ownerRef: 'g1' });
    expect(failed.state).toBe('failed');
  });

  it('a failure records WHY on the row — kind, detail, and a host-log line carrying the env id (#20)', async () => {
    // The whoami acceptance found a failed row with no reason anywhere: `envs
    // get` had nothing to render and the host log had no line for the id.
    const { service, driver } = fx.host();
    const warn = vi.spyOn(log, 'warn');
    driver.failNextClaim({ kind: 'denied-by-policy', retryable: false, detail: 'org policy refuses this stamp' });

    await expect(service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } })).rejects.toMatchObject(
      { kind: 'denied-by-policy' },
    );

    const [failed] = await service.list({ ownerRef: 'g1' });
    expect(failed.failureKind).toBe('denied-by-policy');
    expect(failed.failureDetail).toBe('org policy refuses this stamp');
    expect(
      warn.mock.calls.some(
        ([message, data]) => message === 'Dev-env: env failed' && (data as { envId?: string })?.envId === failed.envId,
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('a crash after readiness fails the env and emits', async () => {
    const { service, events } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    fx.runtime.kill(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    await settled();

    expect(events.at(-1)).toMatchObject({ kind: 'env-failed', failure: { kind: 'instance-died' } });
    const after = await service.status(env.envId);
    expect(after.state).toBe('failed');
    expect(after.failureKind).toBe('instance-died'); // detail-less kinds still record the kind (#20)
  });

  it('release is idempotent', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    await service.release(env.envId);
    await expect(service.release(env.envId)).resolves.toBeUndefined();
  });

  it('a release that lands while the driver claim is in flight still tears the instance down', async () => {
    // The window every real driver has: claim() is network I/O, and the owner
    // can die (releaseBoundTo) or a short TTL can reap while it's on the wire.
    // The late-arriving instance must be torn down, not installed for an env
    // the registry already closed.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let reachedDriver!: () => void;
    // The intent write is registry I/O now, so the claim yields BEFORE its row
    // lands. Waiting for the driver to be entered is what "in flight" means
    // here — releasing earlier than this races the INSERT, not the wire.
    const onWire = new Promise<void>((resolve) => (reachedDriver = resolve));
    const { service } = fx.host({
      claimGate: () => {
        reachedDriver();
        return gate;
      },
    });

    const pending = service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'bound' } });
    await onWire;
    await service.releaseBoundTo('g1');
    openGate();
    const env = await pending;

    expect(env.state).toBe('released');
    expect(fx.runtime.instances.size).toBe(0);
  });

  it('claim options ride the whole path: service claim, and the driver sees them verbatim', async () => {
    const { service } = fx.host();
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      options: { flavor: 'dev' },
    });
    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    expect(instance?.options).toEqual({ flavor: 'dev' });
  });
});

describe('lifetimes (D12)', () => {
  it('a ttl env is reaped at its deadline, not before', async () => {
    const { service, events } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'ttl', ttlMs: 10_000 } });

    fx.clock.advance(9_999);
    await service.reapExpired();
    expect((await service.status(env.envId)).state).toBe('active');

    fx.clock.advance(2);
    await service.reapExpired();

    const after = await service.status(env.envId);
    expect(after.state).toBe('released');
    expect(after.releaseCause).toBe('ttl-expired');
    expect(fx.runtime.instances.size).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'env-released', cause: 'ttl-expired' });
  });

  it('extend moves the deadline from now', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'ttl', ttlMs: 10_000 } });

    fx.clock.advance(9_000);
    await service.extend(env.envId, 5_000);

    fx.clock.advance(2_000); // past the original deadline, inside the extension
    await service.reapExpired();
    expect((await service.status(env.envId)).state).toBe('active');

    fx.clock.advance(3_001);
    await service.reapExpired();
    expect((await service.status(env.envId)).state).toBe('released');
  });

  it('only ttl envs extend', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    await expect(service.extend(env.envId, 5_000)).rejects.toThrow(/only ttl envs/);
  });

  it("releaseBoundTo releases the owner's bound envs and nothing else", async () => {
    const { service } = fx.host();
    const bound = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'bound' } });
    const ttl = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'ttl', ttlMs: 60_000 } });
    const pinned = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    const foreign = await service.claim({ ownerRef: 'g2', stampId: STAMP, lifetime: { mode: 'bound' } });

    await service.releaseBoundTo('g1');

    expect((await service.status(bound.envId)).state).toBe('released');
    expect((await service.status(bound.envId)).releaseCause).toBe('owner-released');
    expect((await service.status(ttl.envId)).state).toBe('active');
    expect((await service.status(pinned.envId)).state).toBe('active');
    expect((await service.status(foreign.envId)).state).toBe('active');
  });

  it('a pinned env outlasts any amount of time', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    fx.clock.advance(365 * 24 * 3600 * 1000);
    await service.reapExpired();
    expect((await service.status(env.envId)).state).toBe('active');
  });
});

describe('re-adoption across a host restart', () => {
  it('an active env survives: same identity, live endpoints, releasable', async () => {
    const first = fx.host();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    const second = fx.host();
    await second.service.adopt();

    const adopted = await second.service.status(env.envId);
    expect(adopted.state).toBe('active');
    expect(adopted.instanceId).toBe(env.instanceId);
    expect(adopted.endpoints.app).toBeDefined();

    await second.service.release(env.envId);
    expect(fx.runtime.instances.size).toBe(0);
  });

  it('re-names the owner to an adopted instance, for the material it holds', async () => {
    // Discovery rebuilds handles from runtime labels, which cannot carry an
    // owner; an instance realized before its driver laid material out per
    // owner has none recorded. The registry never forgot, so adoption says it
    // — before anything is minted.
    const first = fx.host();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }))!;
    instance.materialsScope = undefined; // what a pre-layout instance looks like

    const second = fx.host();
    await second.service.adopt();

    expect(instance.materialsScope).toBe('g1');
  });

  it('a claim in flight when the host died completes on the new host (D18)', async () => {
    const first = fx.host({ manual: true });
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    expect(env.state).toBe('claiming');

    fx.runtime.severListeners(); // the first host is dead — its handles stop observing
    const second = fx.host({ manual: true });
    await second.service.adopt();
    boot(env);
    await settled();

    expect(second.events.map((e) => e.kind)).toContain('env-ready');
    expect((await second.service.status(env.envId)).state).toBe('active');
  });

  it("adoption's resume re-presents the ORIGINAL claim to the driver", async () => {
    const first = fx.host({ manual: true });
    const env = await first.service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      options: { flavor: 'dev' },
    });

    fx.runtime.severListeners();
    const second = fx.host({ manual: true });
    await second.service.adopt();

    // The claim_options column earning its keep on the resume path: the
    // driver converges toward the claim as RECORDED, never a reconstruction.
    const instance = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    expect(instance?.resumedOptions).toEqual({ flavor: 'dev' });
  });

  it('an env whose instance died while the host was down is failed, with the event', async () => {
    const first = fx.host();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    dieSilently(env);

    const second = fx.host();
    await second.service.adopt();

    expect((await second.service.status(env.envId)).state).toBe('failed');
    expect(second.events.at(-1)).toMatchObject({ kind: 'env-failed', failure: { kind: 'instance-died' } });
  });

  it('a claim whose instance did not survive the restart is failed loudly — never re-minted', async () => {
    // The registry recorded intent; the runtime holds nothing — the driver
    // was never asked, or the instance died with the host. Minting a fresh
    // instance now would hand a boot nobody is waiting on to an owner who
    // may have moved on; the row fails instead, and reclaimInstance is the
    // sanctioned way back under the same env identity.
    const store = new DevEnvStore(fx.db);
    await store.insertEnv({
      envId: 'env-interrupted',
      ownerRef: 'g1',
      stampId: STAMP,
      driverKind: 'mock',
      lifetime: { mode: 'pinned' },
      instanceId: 'ins-interrupted',
      claimOptions: { flavor: 'dev' },
    });

    const { service, events } = fx.host();
    await service.adopt();

    const env = await service.status('env-interrupted');
    expect(env.state).toBe('failed');
    expect(env.failureDetail).toContain('host restarted mid-claim'); // the row says why (#20)
    expect(fx.runtime.instances.size).toBe(0);
    expect(events.at(-1)).toMatchObject({
      kind: 'env-failed',
      failure: { kind: 'instantiation-failed', retryable: true },
    });
  });

  it('a ttl that expired while the host was down is reaped on adoption', async () => {
    const first = fx.host();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'ttl', ttlMs: 10_000 } });

    fx.clock.advance(60_000);
    const second = fx.host();
    await second.service.adopt();

    expect((await second.service.status(env.envId)).state).toBe('released');
    expect((await second.service.status(env.envId)).releaseCause).toBe('ttl-expired');
    expect(fx.runtime.instances.size).toBe(0);
  });

  it('runtime residue no live env accounts for is torn down', async () => {
    const first = fx.host();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    await first.service.release(env.envId);
    // The release finished in the registry but its teardown "never reached" the
    // runtime — resurrect the runtime object to fake exactly that half-death.
    fx.runtime.instances.set(instanceName({ envId: env.envId, instanceId: env.instanceId! }), {
      name: instanceName({ envId: env.envId, instanceId: env.instanceId! }),
      labels: {
        'nanoclaw-dev-install': INSTALL,
        'nanoclaw-dev-env': env.envId,
        'nanoclaw-dev-instance': env.instanceId!,
        'nanoclaw-dev-stamp': STAMP,
      },
      options: {},
      phase: 'ready',
      endpoints: {},
      access: {},
    });

    const second = fx.host();
    await second.service.adopt();

    expect(fx.runtime.instances.size).toBe(0);
  });
});

describe('re-adoption of in-flight claims, composed over the k8s driver', () => {
  // The 13:15 lane-tick incident (ISSUES #13) lived in the COMPOSITION: the
  // service's adopt() and the k8s driver's discovery are each proven in their
  // own suites, but a mid-claim SIGTERM only reproduces with both real halves
  // over one surviving fake cluster — which is where a healthy converging
  // instance used to get swept to failed.
  let fakeKube: FakeKube;
  let materialsDir: string;

  beforeEach(() => {
    fakeKube = new FakeKube();
    materialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-registry-k8s-'));
  });
  afterEach(() => {
    fs.rmSync(materialsDir, { recursive: true, force: true });
  });

  function k8sHost(): { service: DevEnvService; events: DevEnvEvent[] } {
    const driver = new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: fakeKube,
      stamps: { [STAMP]: {} },
      materialsDir,
    });
    const service = new DevEnvService({ db: fx.db, driver, installScope: INSTALL, now: fx.clock.now });
    const events: DevEnvEvent[] = [];
    service.onEvent((e) => events.push(e));
    return { service, events };
  }

  it('a surviving instance is re-adopted: claiming resumes, then active — never swept to failed', async () => {
    const first = k8sHost();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    expect(env.state).toBe('claiming'); // the vcluster is still converging...
    fakeKube.severWatches(); // ...when the lane tick SIGTERMs the host

    const second = k8sHost();
    await second.service.adopt();

    // Not swept: still claiming, now supervised by the new host's handle.
    expect((await second.service.status(env.envId)).state).toBe('claiming');

    const ns = fakeKube.namespaceByLabel(DEV_ENV_LABELS.instance, env.instanceId!)!;
    fakeKube.completeBoot(ns.name);
    await settled();

    expect(second.events.map((e) => e.kind)).toContain('env-ready');
    expect((await second.service.status(env.envId)).state).toBe('active');
  });

  it('a claim whose namespace did NOT survive is failed — and nothing is minted in its place', async () => {
    const first = k8sHost();
    const env = await first.service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    fakeKube.severWatches();
    fakeKube.crash(fakeKube.namespaceByLabel(DEV_ENV_LABELS.instance, env.instanceId!)!.name);

    const second = k8sHost();
    await second.service.adopt();

    expect((await second.service.status(env.envId)).state).toBe('failed');
    expect(second.events.at(-1)).toMatchObject({
      kind: 'env-failed',
      failure: { kind: 'instantiation-failed', retryable: true },
    });
    expect(fakeKube.namespaces.size).toBe(0); // no second instance, no ghost boot
  });
});

describe('a stamp retired mid-lifecycle, composed over the k8s driver + the real registry (ISSUES #21)', () => {
  // The whoami acceptance's third row (env-98157dcb): claim active → set-pool
  // 1 → slot filled → second env claimed + released → retire → pool drained —
  // and a THIRD row sat failed, owner = the agent group, stamp whoami@v1, no
  // reason anywhere. Diagnosis, proven here by replaying the sequence: the
  // third row is a CLAIM that entered after retire. Intent persists before the
  // driver answers (the crash-safety ordering), so the driver's refusal lands
  // as a failed row — correct and by design; the missing half was the WHY.
  // The other suspects are innocent by construction and pinned elsewhere:
  // pool slots carry no env label (invisible to adoption — 'slots are
  // invisible to discovery' in the k8s suite), and reapRemovedPools only ever
  // touches slot-labeled namespaces, which no claimed env wears.
  let fakeKube: FakeKube;
  let materialsDir: string;

  beforeEach(() => {
    fakeKube = new FakeKube();
    fakeKube.manualCompletion = false; // boots complete instantly — warm-pool time
    materialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-registry-retire-'));
  });
  afterEach(() => {
    fs.rmSync(materialsDir, { recursive: true, force: true });
  });

  /** Pool work rides 0ms timers, not microtasks — settle through the timers phase. */
  async function poolSettled(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  it('the claim that raced retirement fails WITH a recorded reason naming it; the live env and the ledger stay honest', async () => {
    const store = new StampRegistryStore(fx.db);
    const source = new RegistryStampSource(store);
    await store.create({ stampId: 'whoami', config: {}, authorRef: 'g1' });
    await source.refresh();
    const driver = new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: fakeKube,
      stamps: {},
      stampSource: source,
      materialsDir,
    });
    const service = new DevEnvService({
      db: fx.db,
      driver,
      installScope: INSTALL,
      now: fx.clock.now,
      // index.ts's wiring: provenance from the registry row, retired or not.
      resolveStampVersion: async (stampId) => (await store.get(stampId))?.version ?? null,
    });

    // The acceptance sequence. 1: claim → active, provenance whoami@v1.
    const live = await service.claim({ ownerRef: 'g1', stampId: 'whoami', lifetime: { mode: 'pinned' } });
    expect(live.state).toBe('active');
    expect(live.stampVersion).toBe(1);

    // 2: set-pool 1 → the reconciler fills a warm slot.
    await store.setPool('whoami', 1);
    await driver.ensureReady();
    await poolSettled();

    // 3: a second claim + release.
    const second = await service.claim({ ownerRef: 'g1', stampId: 'whoami', lifetime: { mode: 'pinned' } });
    expect(second.state).toBe('active');
    await service.release(second.envId);

    // 4: retire — the stamps CLI refreshes the snapshot at the mutation.
    await store.retire('whoami');
    await source.refresh();

    // 5: the claim that raced retirement — refused, and the ROW says why.
    await expect(
      service.claim({ ownerRef: 'g1', stampId: 'whoami', lifetime: { mode: 'pinned' } }),
    ).rejects.toMatchObject({ kind: 'stamp-unknown' });

    // 6: the drain (production's interval tick; ensureReady schedules the same
    // reconcile) takes the slot without inventing an env row.
    await driver.ensureReady();
    await poolSettled();
    driver.dispose();
    expect([...fakeKube.namespaces.values()].filter((ns) => ns.labels['nanoclaw-dev-slot'])).toHaveLength(0);

    const rows = await service.list({});
    const failed = rows.find((row) => row.state === 'failed')!;
    expect(failed.failureKind).toBe('stamp-unknown');
    expect(failed.failureDetail).toContain('retired'); // never a bare 'no such stamp' for a raced retire
    expect(failed.stampVersion).toBe(1); // provenance survives the refusal — whoami@v1, as observed live

    // The live env rode through retirement untouched, and the ledger holds
    // exactly the three claims — the drained pool minted no rows of its own.
    expect((await service.status(live.envId)).state).toBe('active');
    expect(rows).toHaveLength(3);
  });
});

describe('env identity over instance succession (D21)', () => {
  it('reclaim gives the same env a fresh instance; the old one is superseded, never mutated', async () => {
    const { service } = fx.host();
    const env = await service.claim({
      ownerRef: 'g1',
      stampId: STAMP,
      lifetime: { mode: 'pinned' },
      options: { flavor: 'dev' },
    });
    const firstInstance = env.instanceId!;

    const next = await service.reclaimInstance(env.envId);

    expect(next.envId).toBe(env.envId);
    expect(next.ownerRef).toBe('g1');
    expect(next.lifetime).toEqual({ mode: 'pinned' });
    expect(next.instanceId).not.toBe(firstInstance);
    expect(next.state).toBe('active');
    expect(next.endpoints.app).toContain(next.instanceId!);
    // Succession re-presents the env's original claim options to the driver.
    const successor = fx.runtime.instances.get(instanceName({ envId: env.envId, instanceId: next.instanceId! }));
    expect(successor?.options).toEqual({ flavor: 'dev' });

    const store = new DevEnvStore(fx.db);
    expect(await store.listInstances(env.envId)).toEqual([
      { instanceId: firstInstance, state: 'superseded' },
      { instanceId: next.instanceId!, state: 'ready' },
    ]);
    expect(fx.runtime.instances.size).toBe(1);
  });

  it('an env survives its instance dying: fail, reclaim, live again — same identity', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });

    fx.runtime.kill(instanceName({ envId: env.envId, instanceId: env.instanceId! }));
    await settled();
    expect((await service.status(env.envId)).state).toBe('failed');

    const revived = await service.reclaimInstance(env.envId);

    expect(revived.envId).toBe(env.envId);
    expect(revived.state).toBe('active');
    // Succession clears the dead instance's verdict from the env row — the
    // instance ledger keeps it; the env speaks for its current instance.
    expect(revived.failureKind).toBeNull();
  });

  it('a released env does not reclaim — a new claim is a new env', async () => {
    const { service } = fx.host();
    const env = await service.claim({ ownerRef: 'g1', stampId: STAMP, lifetime: { mode: 'pinned' } });
    await service.release(env.envId);
    await expect(service.reclaimInstance(env.envId)).rejects.toThrow(/released/);
  });
});

describe('devEnvClaimantNamespace — where the D19 claimant fields come from', () => {
  // The function's `.env` fallback reads process.cwd() (the same precedence
  // driver-selection.test.ts isolates for the same reason): unisolated, these
  // cases go red on any checkout whose .env sets NANOCLAW_RUNTIME_DRIVER or
  // NANOCLAW_POD_NAMESPACE — i.e. exactly the wire-host layout the function
  // exists for.
  let previousCwd: string;
  beforeEach(() => {
    previousCwd = process.cwd();
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-claimant-ns-')));
  });
  afterEach(() => {
    process.chdir(previousCwd);
  });

  it('names the session pod namespace only when sessions are pod-realized', () => {
    expect(devEnvClaimantNamespace({ NANOCLAW_RUNTIME_DRIVER: 'pod', NANOCLAW_POD_NAMESPACE: 'tenant-a' })).toBe(
      'tenant-a',
    );
    // The default mirrors the pod driver's own (`podNamespace()` in the
    // overlay's pod-driver.ts) — the two must not drift, or the route is
    // authored in a namespace no session pod runs in.
    expect(devEnvClaimantNamespace({ NANOCLAW_RUNTIME_DRIVER: 'pod' })).toBe('agents');
  });

  it('answers undefined for docker-realized sessions — no placement, no routes, fail closed', () => {
    expect(
      devEnvClaimantNamespace({ NANOCLAW_RUNTIME_DRIVER: 'docker', NANOCLAW_POD_NAMESPACE: 'agents' }),
    ).toBeUndefined();
    expect(devEnvClaimantNamespace({})).toBeUndefined();
  });
});
