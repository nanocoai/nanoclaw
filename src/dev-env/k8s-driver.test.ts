/**
 * K8s driver specifics — what the conformance floor cannot see: the warm pool
 * (driver-private, D5), the CAS claim flip, watch recovery, kubeconfig
 * minting, failure normalization, and the rendered-bundle substitution.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV_TREE_PVC, DEV_TREE_STORAGE_CLASS } from './dev-tree.js';
import { FakeKube } from './k8s-fake-kube.js';
import { DEV_TREE_OPTION, K8sDevEnvDriver, devTreePvName, syncedDevTreePvcName } from './k8s-driver.js';
import { normalizeK8sFailure } from './k8s-kube.js';
import {
  NANOCLAW_CHILD_HOST_DEV_IMAGE,
  NANOCLAW_CHILD_HOST_IMAGE,
  NANOCLAW_CHILD_MANIFESTS,
  NANOCLAW_DEV_MODE_MANIFEST,
  NANOCLAW_DEV_MODE_MANIFEST_DEV,
  NANOCLAW_HOST_DEPLOYMENT,
  NANOCLAW_NAMESPACE,
  renderDevChildManifests,
} from './nanoclaw-child-manifests.js';
import type { StampSource } from './stamp-registry.js';
import {
  BUILTIN_STAMPS,
  STAMP_IDENTITY_EXAMPLE,
  devConsumerGate,
  validateStampEntry,
  type K8sStampConfig,
} from './stamps.js';
import { VCLUSTER_IMAGES, VCLUSTER_MANIFESTS, VCLUSTER_NS_TOKEN } from './vcluster-manifests.js';
import { DEV_ENV_LABELS, devEnvLabels, type DriverClaimSpec, type EnvKey } from './types.js';

const INSTALL = 'k8s-suite';

let fake: FakeKube;
let materialsDir: string;

beforeEach(() => {
  fake = new FakeKube();
  materialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-k8s-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(materialsDir, { recursive: true, force: true });
});

function makeDriver(overrides: Partial<ConstructorParameters<typeof K8sDevEnvDriver>[0]> = {}): K8sDevEnvDriver {
  return new K8sDevEnvDriver({
    installScope: INSTALL,
    cli: fake,
    stamps: { 'sample-app': {} },
    materialsDir,
    ...overrides,
  });
}

/** The same driver, with the built-in app stamp instead of a bare vcluster. */
function appDriver(overrides: Partial<ConstructorParameters<typeof K8sDevEnvDriver>[0]> = {}): K8sDevEnvDriver {
  return makeDriver({ stamps: { 'sample-app': BUILTIN_STAMPS['sample-app'] }, ...overrides });
}

let n = 0;
function freshKey(): EnvKey {
  n += 1;
  return { envId: `env-k8s-${n}`, instanceId: `ins-k8s-${n}` };
}

function claimSpec(key: EnvKey, options: Record<string, string> = {}): DriverClaimSpec {
  return { key, stampId: 'sample-app', labels: devEnvLabels(INSTALL, key, 'sample-app'), options };
}

/**
 * Let scheduled pool work run: the reconciler is deliberately deferred onto a
 * 0ms timer, so draining must go through the timers phase, not just immediates.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

function warmSlots(): string[] {
  return [...fake.namespaces.values()].filter((ns) => ns.labels['nanoclaw-dev-slot'] === 'warm').map((ns) => ns.name);
}

describe('warm pool', () => {
  it('reaps failed pool vclusters once a current warm replacement proves recovery', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    const warmName = warmSlots()[0]!;
    const warm = fake.namespaces.get(warmName)!;
    fake.namespaces.set('nanoclaw-dev-failed-old', {
      ...warm,
      name: 'nanoclaw-dev-failed-old',
      resourceVersion: warm.resourceVersion + 1,
      labels: Object.fromEntries(Object.entries(warm.labels).filter(([key]) => key !== 'nanoclaw-dev-slot')),
      annotations: {
        ...warm.annotations,
        'nanoclaw-dev/state': 'failed',
        'nanoclaw-dev/failure': 'instantiation-failed',
        'nanoclaw-dev/failed-at': '1000',
      },
    });

    await driver.reapResidue(INSTALL);
    driver.dispose();

    expect(fake.namespaces.has('nanoclaw-dev-failed-old')).toBe(false);
    expect(fake.namespaces.has(warmName)).toBe(true);
  });

  it('reconciles to the configured size, and slots are invisible to discovery', async () => {
    fake.manualCompletion = false; // fills boot instantly
    const driver = makeDriver({ pools: { 'sample-app': 2 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();

    expect(warmSlots()).toHaveLength(2);
    // Pool slots carry no env identity — adoption must never see them.
    expect(await driver.listInstances(INSTALL)).toHaveLength(0);
  });

  it('a claim consumes a warm slot via CAS flip and returns ready immediately', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    const [slot] = warmSlots();

    const key = freshKey();
    const handle = await driver.claim(claimSpec(key));
    await settle();
    driver.dispose();

    expect(handle.name).toBe(slot); // the slot IS the instance — no new namespace boot
    expect((await handle.status()).phase).toBe('ready');
    const ns = fake.namespaces.get(slot)!;
    expect(ns.labels[DEV_ENV_LABELS.env]).toBe(key.envId);
    expect(ns.labels[DEV_ENV_LABELS.instance]).toBe(key.instanceId);
    expect(ns.labels['nanoclaw-dev-slot']).toBeUndefined();
    // The flip was CAS-guarded — the argv carried the resource-version precondition.
    const flip = fake.calls.find(
      (c) => c.args[0] === 'label' && c.args.some((a) => a.startsWith(`${DEV_ENV_LABELS.env}=`)),
    );
    expect(flip!.args).toContain(slot);
    expect(flip!.args.some((a) => a.startsWith('--resource-version='))).toBe(true);
    // And the pool refilled behind the claim.
    expect(warmSlots()).toHaveLength(1);
  });

  it('reapplies a warm child once after relay-owned render values become available', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    let active = false;
    const marker = JSON.stringify({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'relay-render-active', namespace: 'default' },
    });
    const stamp: K8sStampConfig = {
      childManifests: JSON.stringify({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'relay-target', namespace: 'default' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'relay-target' } },
          template: {
            metadata: { labels: { app: 'relay-target' } },
            spec: { containers: [{ name: 'target', image: 'mirror.gcr.io/library/alpine:3.20' }] },
          },
        },
      }),
      readiness: { deployment: 'relay-target', namespace: 'default' },
    };
    const relay = {
      ensure: async (_context: unknown, cluster: { renderChild?(): boolean }) => {
        if (active) return;
        active = true;
        expect(cluster.renderChild?.()).toBe(true);
      },
      renderChild: (_namespace: string, manifests: string) =>
        active ? `${manifests}\n---\n${marker}` : manifests,
      release: async () => {},
    };
    const driver = makeDriver({ stamps: { 'sample-app': stamp }, pools: { 'sample-app': 1 }, instanceRelay: relay });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_500);
    const [slot] = warmSlots();
    const before = fake.childOf(slot!)!.applied.length;

    await driver.claim(claimSpec(freshKey()));
    const applied = fake.childOf(slot!)!.applied;
    driver.dispose();

    expect(applied.length).toBeGreaterThan(before);
    expect(applied.at(-1)).toContain('relay-render-active');
  });

  it('a claimed slot leaves the observation — the counts are capacity, and name no env', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    expect(driver.observePools()).toEqual({ 'sample-app': { warm: 1, filling: 0, draining: 0, failed: 0 } });

    const key = freshKey();
    await driver.claim(claimSpec(key));
    // The CAS flip took the slot label and left the pool label as provenance:
    // the namespace is somebody's env now, so it must stop counting the
    // instant it stops being claimable by anyone else.
    expect(driver.observePools()).toEqual({ 'sample-app': { warm: 0, filling: 0, draining: 0, failed: 0 } });

    await settle(); // the refill behind the claim
    const refilled = driver.observePools();
    driver.dispose();
    // One warm again — the claimed instance is not counted twice, and the
    // whole answer is numbers keyed by stamp: no env id can ride it out.
    expect(refilled).toEqual({ 'sample-app': { warm: 1, filling: 0, draining: 0, failed: 0 } });
    expect(JSON.stringify(refilled)).not.toContain(key.envId);
  });

  it('a claim carrying options cold-boots — a pooled slot never realized them (shape rule)', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    const [slot] = warmSlots();

    const key = freshKey();
    const handle = await driver.claim(claimSpec(key, { flavor: 'dev' }));

    expect(handle.name).not.toBe(slot);
    // Options travel on stdin (namespace create JSON), never through argv.
    const ns = fake.namespaces.get(handle.name)!;
    expect(ns.annotations['nanoclaw-dev/option.flavor']).toBe('dev');
    const annotateArgv = fake.calls.find(
      (c) => c.args[0] === 'annotate' && c.args.some((a) => a.startsWith('nanoclaw-dev/option.')),
    );
    expect(annotateArgv).toBeUndefined();
  });

  it('a terminating slot reads as draining, never as warm', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    const [slot] = warmSlots();

    // The label still says warm; the apiserver says the namespace is going
    // away. A read that trusted the label would promise a claim a slot that
    // is mid-delete — the same lie `liveNamespaces` keeps out of the fill.
    fake.namespaces.get(slot)!.terminating = true;
    const observed = driver.observePools();
    driver.dispose();
    expect(observed).toEqual({ 'sample-app': { warm: 0, filling: 0, draining: 1, failed: 0 } });
  });

  it('a failed fill stops counting as capacity and the pool boots a replacement', async () => {
    let clock = 1_000_000;
    fake.manualCompletion = true; // fills stall — boot never completes
    const driver = makeDriver({ pools: { 'sample-app': 1 }, bootTimeoutMs: 0, now: () => clock++ });
    await driver.ensureReady();
    await settle();

    // The instant timeout marked the fill failed and dropped its slot label —
    // the corpse must not count as capacity (a later reconcile fills anew).
    driver.dispose();
    const corpses = [...fake.namespaces.values()].filter((ns) => ns.annotations['nanoclaw-dev/state'] === 'failed');
    expect(corpses.length).toBeGreaterThan(0);
    for (const corpse of corpses) {
      expect(corpse.labels['nanoclaw-dev-slot']).toBeUndefined();
    }
    expect(warmSlots()).toHaveLength(0);
  });

  it('a dead fill is COUNTED, not dropped — a broken pool must not read like a slow one (#21)', async () => {
    let clock = 1_000_000;
    fake.manualCompletion = true; // fills stall — boot never completes
    const driver = makeDriver({ pools: { 'sample-app': 1 }, bootTimeoutMs: 0, now: () => clock++ });
    await driver.ensureReady();
    await settle();
    const observed = driver.observePools();
    driver.dispose();

    // `warm 0` is exactly what a pool that has simply not filled YET reads as.
    // The corpse count is the only thing on the row that says which wait is
    // pointless — and it is the state a set-pool author most needs.
    expect(observed['sample-app']!.warm).toBe(0);
    expect(observed['sample-app']!.failed).toBeGreaterThan(0);
    // …and it is DATED. Nothing reaps a pool corpse, so the count never
    // clears: without an age a pool that recovered an hour ago would keep
    // reading exactly like one dying right now, and permanent bad news is
    // read as no news at all.
    expect(observed['sample-app']!.lastFailureAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('a corpse is ANNOTATED before it loses its slot label — the other order can leave it invisible', async () => {
    let clock = 1_000_000;
    fake.manualCompletion = true;
    const driver = makeDriver({ pools: { 'sample-app': 1 }, bootTimeoutMs: 0, now: () => clock++ });
    await driver.ensureReady();
    await settle();
    driver.dispose();

    // If the label drop lands and the annotate throws, the namespace wears
    // neither a slot label nor a failure: residue to the observation, residue
    // to every reaper, and a vcluster nobody will look for again. Annotating
    // first makes the half-written state a visible corpse instead.
    const marked = fake.calls.findIndex(
      (c) => c.args[0] === 'annotate' && c.args.includes('nanoclaw-dev/state=failed'),
    );
    const unlabeled = fake.calls.findIndex((c) => c.args[0] === 'label' && c.args.includes('nanoclaw-dev-slot-'));
    expect(marked).toBeGreaterThanOrEqual(0);
    expect(unlabeled).toBeGreaterThan(marked);
    const corpse = [...fake.namespaces.values()].find((ns) => ns.annotations['nanoclaw-dev/state'] === 'failed')!;
    expect(Number(corpse.annotations['nanoclaw-dev/failed-at'])).toBeGreaterThan(0);
  });

  it('the observation is ONE bounded call — a wedged apiserver costs a read, never the host', async () => {
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    driver.observePools();
    driver.dispose();

    // This runs synchronously inside the host on every `stamps get/list`, so
    // it carries its own deadline rather than kubectl's 30s default: an
    // apiserver that stopped answering must cost the read, not the process.
    const lists = fake.calls.filter((c) => c.args[0] === 'get' && c.args[1] === 'namespaces');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.args).toContain('--request-timeout=5000ms');
  });

  it('a pool cut to a SMALLER size converges down — the surplus is reaped, not held forever', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 2 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    expect(warmSlots()).toHaveLength(2);

    // 2 -> 1. The reconciler only ever FILLED, so a shrink to a NONZERO size
    // never converged: two warm slots stood forever under a row that said
    // pool=1, and the observed half would have rendered that disagreement as
    // permanent truth.
    const smaller = makeDriver({ pools: { 'sample-app': 1 } });
    fake.severWatches();
    await smaller.ensureReady();
    await settle();
    const observed = smaller.observePools();
    smaller.dispose();

    expect(warmSlots()).toHaveLength(1);
    expect(observed).toEqual({ 'sample-app': { warm: 1, filling: 0, draining: 0, failed: 0 } });
  });

  it('the surplus of a cut reads as DRAINING from the moment the size lands, not as warm', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 2 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    expect(warmSlots()).toHaveLength(2);

    // The cut to 1, read BEFORE the reconciler gets to it: one of these two
    // slots is doomed, and the reaper already knows which. Counting both as
    // warm would promise a claim exactly the capacity the next cycle takes
    // away — and would leave a shrink converging with nothing to watch, which
    // is what `draining` is documented to cover.
    const smaller = makeDriver({ pools: { 'sample-app': 1 } });
    const observed = smaller.observePools();
    smaller.dispose();

    expect(observed).toEqual({ 'sample-app': { warm: 1, filling: 0, draining: 1, failed: 0 } });
    expect(warmSlots()).toHaveLength(2); // a READ reaps nothing
  });

  it('warm slots of a pool removed from config are reaped by the reconciler', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    expect(warmSlots()).toHaveLength(1);

    const driver2 = makeDriver({ pools: {} }); // pool removed across restart
    fake.severWatches();
    await driver2.ensureReady();
    await settle();
    driver2.dispose();

    expect(warmSlots()).toHaveLength(0);
  });

  it('created namespaces carry the PodSecurity baseline guard', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    expect(fake.namespaces.get(handle.name)!.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
  });

  it('mints per-namespace host access when a subject is configured — and not otherwise', async () => {
    const subject = { kind: 'ServiceAccount' as const, name: 'a-host', namespace: 'system' };
    const driver = makeDriver({ hostAccessSubject: subject });
    const handle = await driver.claim(claimSpec(freshKey()));

    const role = fake.rbacDocs.get(`${handle.name}/Role/dev-env-host-access`);
    const binding = fake.rbacDocs.get(`${handle.name}/RoleBinding/dev-env-host-access`) as {
      subjects?: object[];
    };
    expect(role).toBeDefined();
    expect(binding?.subjects).toEqual([subject]);
    // Minted BEFORE the bundle: everything else flows through the grant.
    const applies = fake.calls.filter((c) => c.args[0] === 'apply').map((c) => c.input ?? '');
    expect(applies.findIndex((i) => i.includes('"Role"'))).toBeLessThan(
      applies.findIndex((i) => !i.trimStart().startsWith('{')),
    );

    const bare = makeDriver();
    const handle2 = await bare.claim(claimSpec(freshKey()));
    expect(fake.rbacDocs.has(`${handle2.name}/Role/dev-env-host-access`)).toBe(false);
  });

  it('a bundle apply losing the RBAC-propagation race retries once and succeeds', async () => {
    let denied = 1;
    const racy: typeof fake = new Proxy(fake, {
      get(target, prop) {
        if (prop === 'run') {
          return (args: string[], opts?: { input?: string }) => {
            const isBundleApply = args[0] === 'apply' && !(opts?.input ?? '').trimStart().startsWith('{');
            if (isBundleApply && denied > 0) {
              denied--;
              throw new Error('deployments.apps "vc" is forbidden: User cannot create resource');
            }
            return target.run(args, opts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const driver = new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: racy,
      stamps: { 'sample-app': {} },
      materialsDir,
      hostAccessSubject: { kind: 'ServiceAccount', name: 'a-host', namespace: 'system' },
    });
    const handle = await driver.claim(claimSpec(freshKey()));
    expect(fake.pods.has(handle.name)).toBe(true); // the retried apply landed
  });

  it('a lost CAS race falls through to the cold path, never a double-claim', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    const [slot] = warmSlots();

    fake.conflictNextCasLabel();
    const handle = await driver.claim(claimSpec(freshKey()));
    await settle();

    expect(handle.name).not.toBe(slot);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('a half-warm slot (no kubeconfig secret yet) is skipped, not handed out', async () => {
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    const [slot] = warmSlots();
    fake.secrets.delete(`${slot}/vc-vc`); // the warm label is now a lie

    const handle = await driver.claim(claimSpec(freshKey()));
    expect(handle.name).not.toBe(slot);
  });

  it('reapResidue removes stale filling slots but spares fresh ones', async () => {
    let clock = 1_000_000;
    const driver = makeDriver({ pools: {}, bootTimeoutMs: 1_000, now: () => clock });
    // Two abandoned fills from a dead host: one ancient, one in progress.
    for (const [name, started] of [
      ['stale-fill', 1_000],
      ['fresh-fill', clock - 100],
    ] as const) {
      fake.namespaces.set(name, {
        name,
        labels: {
          [DEV_ENV_LABELS.install]: INSTALL,
          'nanoclaw-dev-pool': 'sample-app',
          'nanoclaw-dev-slot': 'filling',
        },
        annotations: { 'nanoclaw-dev/fill-started': String(started) },
        resourceVersion: 1,
        creationTimestamp: new Date().toISOString(),
        terminating: false,
      });
    }

    await driver.reapResidue(INSTALL);

    expect(fake.namespaces.has('stale-fill')).toBe(false);
    expect(fake.namespaces.has('fresh-fill')).toBe(true);
  });
});

describe('supervision', () => {
  it('re-arms a dropped watch and reports the death it missed while down', async () => {
    vi.useFakeTimers();
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimSpec(key));
    fake.completeBoot(handle.name);
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    // The apiserver closes the watch; while it is down, the instance dies.
    const [watch] = fake.watchProcs(handle.name);
    watch.emitExit(0);
    fake.severWatches();
    fake.crash(handle.name);

    await vi.advanceTimersByTimeAsync(1_500); // past the first backoff
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instance-died' });
  });

  it('a boot that never completes times out into a persisted failure', async () => {
    vi.useFakeTimers();
    const driver = makeDriver({ bootTimeoutMs: 5_000 });
    const key = freshKey();
    const handle = await driver.claim(claimSpec(key));
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    await vi.advanceTimersByTimeAsync(5_100);

    expect(terminal).toHaveBeenCalledOnce();
    expect((await handle.status()).phase).toBe('failed');
    // Persisted on the runtime: a restarted driver's residue sweep sees it.
    expect(fake.namespaces.get(handle.name)!.annotations['nanoclaw-dev/state']).toBe('failed');
  });

  it('a probe blip inside a watch event degrades to a missed event — never a throw, never a false terminal', async () => {
    let blip = false;
    const flaky: typeof fake = new Proxy(fake, {
      get(target, prop) {
        if (prop === 'run') {
          return (args: string[], opts?: { input?: string }) => {
            if (blip && args[0] === 'get') throw new Error('The connection to the server was refused');
            return target.run(args, opts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const driver = new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: flaky,
      stamps: { 'sample-app': {} },
      materialsDir,
    });
    const handle = await driver.claim(claimSpec(freshKey()));
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    blip = true;
    // DELETED event whose follow-up namespace probe fails: must neither crash
    // the process nor decide anything from the failed probe.
    for (const proc of fake.watchProcs(handle.name)) {
      proc.emitStdout(JSON.stringify({ type: 'DELETED', object: { metadata: { namespace: handle.name } } }));
    }
    blip = false;

    expect(terminal).not.toHaveBeenCalled();
    expect((await handle.status()).phase).toBe('provisioning');
  });

  it('a failed drop-reconcile retries — supervision never dies quietly', async () => {
    vi.useFakeTimers();
    let failGets = false;
    const flaky: typeof fake = new Proxy(fake, {
      get(target, prop) {
        if (prop === 'run') {
          return (args: string[], opts?: { input?: string }) => {
            if (failGets && args[0] === 'get') throw new Error('The connection to the server was refused');
            return target.run(args, opts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const driver = new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: flaky,
      stamps: { 'sample-app': {} },
      materialsDir,
    });
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    // Watch drops; the first reconcile fails outright; the instance dies
    // while probes are down. The retry loop must still find the death.
    const [watch] = fake.watchProcs(handle.name);
    watch.emitExit(0);
    fake.severWatches();
    failGets = true;
    await vi.advanceTimersByTimeAsync(1_500); // reconcile #1 — rejects
    expect(terminal).not.toHaveBeenCalled();
    fake.crash(handle.name);
    failGets = false;
    await vi.advanceTimersByTimeAsync(5_000); // retry finds the corpse

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instance-died' });
  });

  it('a replacement pod after ready is instance death — frozen instances never resurrect', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('ready');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    // The Deployment replaced the pod: same name, new uid, empty state.
    const pod = fake.pods.get(handle.name)!;
    pod.uid = 'uid-replacement';
    for (const proc of fake.watchProcs(handle.name)) {
      proc.emitStdout(
        JSON.stringify({
          type: 'MODIFIED',
          object: {
            metadata: { name: 'vc-0', namespace: handle.name, uid: 'uid-replacement', labels: { app: 'vcluster' } },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          },
        }),
      );
    }

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instance-died' });
  });

  it('a namespace name collision refuses the claim instead of hijacking a foreign namespace', async () => {
    let collide = true;
    const colliding: typeof fake = new Proxy(fake, {
      get(target, prop) {
        if (prop === 'run') {
          return (args: string[], opts?: { input?: string }) => {
            if (collide && args[0] === 'create') {
              collide = false;
              throw new Error('namespaces "unlucky" already exists');
            }
            return target.run(args, opts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const driver = new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: colliding,
      stamps: { 'sample-app': {} },
      materialsDir,
    });
    await expect(driver.claim(claimSpec(freshKey()))).rejects.toMatchObject({ kind: 'instantiation-failed' });
  });

  it('a pod deleted mid-provisioning is not terminal while the namespace lives', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    // The scheduler rescheduled the pod; the Deployment will replace it.
    fake.pods.delete(handle.name);
    for (const proc of fake.watchProcs(handle.name)) {
      proc.emitStdout(JSON.stringify({ type: 'DELETED', object: { metadata: { namespace: handle.name } } }));
    }

    expect(terminal).not.toHaveBeenCalled();
    expect((await handle.status()).phase).toBe('provisioning');
  });
});

describe('boot deadlines', () => {
  it('gives an app the whole boot budget, and calls that expiry retryable', async () => {
    // The kubeconfig-sized window (90s) is not the app's window: a pool fill
    // gets bootTimeoutMs for the same stamp, and a cold claim that got less
    // would fail claims the pool quietly retries.
    vi.useFakeTimers();
    const driver = appDriver({ bootTimeoutMs: 200_000 });
    const handle = await driver.claim(claimSpec(freshKey()));
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    fake.completeBoot(handle.name); // access exported; the app never rolls out

    await vi.advanceTimersByTimeAsync(120_000); // past the old secret-sized cap
    expect(terminal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(90_000); // past the instance's own budget
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instantiation-failed', retryable: true });
    // And it says WHICH gate was still red. Without this the verdict names only
    // the stamp, so every non-convergence — a missing image, a seed script that
    // cannot run, a crashlooping migration — arrives as the same sentence ten
    // minutes late and sends the reader to the whole child instead of to one
    // Deployment. The gate names are computed on every probe anyway.
    expect(terminal.mock.calls[0][0].detail).toContain('not Available:');
  });

  it('still fails a kubeconfig that never appears early, and non-retryably', async () => {
    // The other half keeps its own short deadline: the syncer exports within
    // seconds of the pod passing probes, so minutes of absence is a break.
    vi.useFakeTimers();
    const driver = appDriver({ bootTimeoutMs: 600_000 });
    const handle = await driver.claim(claimSpec(freshKey()));
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    const pod = fake.pods.get(handle.name)!;
    pod.phase = 'Running';
    pod.ready = true;
    for (const proc of fake.watchProcs(handle.name)) {
      proc.emitStdout(
        JSON.stringify({
          type: 'MODIFIED',
          object: {
            metadata: { name: 'vc-0', namespace: handle.name, uid: pod.uid, labels: { app: 'vcluster' } },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          },
        }),
      );
    }

    await vi.advanceTimersByTimeAsync(95_000);
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('kubeconfig secret'),
    });
  });
});

describe('re-adoption of in-flight claims (host restart)', () => {
  it('resume finishes what the dying host left half-done — bundle and route heal, the adopted handle completes', async () => {
    fake.seedForeignNamespace('agents');
    const key = freshKey();
    const spec: DriverClaimSpec = {
      ...claimSpec(key),
      claimantNamespace: 'agents',
      claimantSelector: { 'nanoclaw-group': 'g1' },
    };
    const driver = makeDriver();
    await driver.claim(spec);
    const name = fake.namespaceByLabel(DEV_ENV_LABELS.instance, key.instanceId)!.name;
    // The SIGTERM window: the namespace (and its labels — the claim) landed;
    // the bundle and the route did not.
    fake.pods.delete(name);
    fake.netpols.clear();
    fake.severWatches();

    // The restarted host: discovery first, then the converge — service order.
    const restarted = makeDriver();
    const [adopted] = await restarted.listInstances(INSTALL);
    const ready = vi.fn();
    adopted.onReady(ready);
    await restarted.resumeClaim(spec);

    expect(fake.pods.has(name)).toBe(true); // the bundle converged
    expect(fake.netpols.size).toBe(1); // the route came back
    fake.completeBoot(name);
    expect(ready).toHaveBeenCalledOnce(); // readiness arrived on the ADOPTED handle
  });

  it('resume never allocates: a vanished instance stays vanished, a Terminating one is left to die', async () => {
    const driver = makeDriver();
    const gone = await driver.claim(claimSpec(freshKey()));
    const dying = await driver.claim(claimSpec(freshKey()));
    fake.severWatches();
    fake.crash(gone.name);
    fake.namespaces.get(dying.name)!.terminating = true;
    fake.pods.delete(dying.name); // half-done AND on its way out

    const restarted = makeDriver();
    await restarted.resumeClaim(claimSpec(gone.key));
    await restarted.resumeClaim(claimSpec(dying.key));

    expect(fake.namespaces.has(gone.name)).toBe(false); // nothing re-minted
    expect(fake.pods.has(dying.name)).toBe(false); // nothing converged into a Terminating namespace
  });

  it('a re-adopted claim fails at the ORIGINAL boot deadline — restarts never refill the budget', async () => {
    // The other half of ISSUES #13: re-adopting must not turn `claiming` into
    // a state a wedged instance can hold forever, one budget per restart.
    vi.useFakeTimers();
    const driver = makeDriver({ bootTimeoutMs: 200_000 });
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.severWatches(); // the host dies two minutes into the boot...
    fake.namespaces.get(handle.name)!.creationTimestamp = new Date(Date.now() - 120_000).toISOString(); // ...which the runtime remembers

    const [adopted] = await makeDriver({ bootTimeoutMs: 200_000 }).listInstances(INSTALL);
    const terminal = vi.fn();
    adopted.onTerminal(terminal);

    await vi.advanceTimersByTimeAsync(79_000); // 199s of the claim's own budget spent
    expect(terminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); // past the deadline the claim was BORN with
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instantiation-failed' });
  });
});

describe('kubeconfig materials', () => {
  it('mints the exported kubeconfig by path, re-mints when the file vanishes, removes on release', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimSpec(key));
    fake.completeBoot(handle.name);

    const status = await handle.status();
    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    const file = status.access.kubeconfig;
    expect(fs.readFileSync(file, 'utf8')).toContain(`server: https://vc.${handle.name}.svc:443`);

    // A deploy rsyncs the tree away; the next status heals it from the secret.
    fs.rmSync(file);
    const again = await handle.status();
    if (again.phase !== 'ready') throw new Error('expected ready after re-mint');
    expect(fs.existsSync(file)).toBe(true);

    await handle.release('done');
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it('mints under the claiming owner, and one release takes only its own instance', async () => {
    // The layout IS the isolation: a child kubeconfig is cluster-admin of that
    // child, and the host can only mount one owner's material into one owner's
    // sandbox if no other owner's lives in the same directory.
    const driver = makeDriver();
    const mine = freshKey();
    const alsoMine = freshKey();
    const theirs = freshKey();
    const claims = await Promise.all([
      driver.claim({ ...claimSpec(mine), materialsScope: 'ag-one' }),
      driver.claim({ ...claimSpec(alsoMine), materialsScope: 'ag-one' }),
      driver.claim({ ...claimSpec(theirs), materialsScope: 'ag-two' }),
    ]);
    for (const handle of claims) fake.completeBoot(handle.name);
    const paths = await Promise.all(
      claims.map(async (handle) => {
        const status = await handle.status();
        if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
        return status.access.kubeconfig;
      }),
    );

    expect(paths[0]).toBe(path.join(materialsDir, 'ag-one', mine.instanceId, 'kubeconfig'));
    expect(paths[2]).toBe(path.join(materialsDir, 'ag-two', theirs.instanceId, 'kubeconfig'));

    await claims[0].release('done');
    expect(fs.existsSync(paths[0])).toBe(false);
    // The owner's other env is untouched, and so is the other owner's.
    expect(fs.existsSync(paths[1])).toBe(true);
    expect(fs.existsSync(paths[2])).toBe(true);
    expect(fs.existsSync(path.join(materialsDir, 'ag-one'))).toBe(true);
  });

  it('an owner ref that is not a path segment cannot escape the materials root', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim({ ...claimSpec(key), materialsScope: '../../etc' });
    fake.completeBoot(handle.name);

    const status = await handle.status();
    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    expect(status.access.kubeconfig.startsWith(`${materialsDir}${path.sep}`)).toBe(true);
    expect(status.access.kubeconfig).not.toContain('..');
  });

  it('a replayed claim heals an instance realized before the per-owner layout', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const spec = { ...claimSpec(key), materialsScope: 'ag-one' };
    const first = await driver.claim(spec);
    // What a pre-change instance looks like: no scope anywhere on the runtime.
    delete fake.namespaces.get(first.name)!.labels['nanoclaw-dev-scope'];

    const replayed = await driver.claim(spec);
    fake.completeBoot(replayed.name);
    const status = await replayed.status();

    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    expect(status.access.kubeconfig).toBe(path.join(materialsDir, 'ag-one', key.instanceId, 'kubeconfig'));
    expect(fake.namespaces.get(first.name)!.labels['nanoclaw-dev-scope']).toBe('ag-one');
  });

  it('an adopted legacy instance mints into its owner slice once the host names the owner', async () => {
    // Discovery cannot know the owner; the registry never forgot it. Without
    // this the re-mint lands in a directory no sandbox mounts — a path
    // `envs get` prints and the agent cannot open.
    const driver = makeDriver();
    const key = freshKey();
    const claimed = await driver.claim(claimSpec(key));
    fake.completeBoot(claimed.name);
    delete fake.namespaces.get(claimed.name)!.labels['nanoclaw-dev-scope'];
    fake.severWatches();

    const [adopted] = await makeDriver().listInstances(INSTALL);
    adopted.setMaterialsScope!('ag-one');
    const status = await adopted.status();

    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    expect(status.access.kubeconfig).toBe(path.join(materialsDir, 'ag-one', key.instanceId, 'kubeconfig'));
    // Healed on the runtime too: the next adoption needs no telling.
    expect(fake.namespaces.get(claimed.name)!.labels['nanoclaw-dev-scope']).toBe('ag-one');
  });

  it('an adopted instance finds the material its claim minted', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const claimed = await driver.claim({ ...claimSpec(key), materialsScope: 'ag-one' });
    fake.completeBoot(claimed.name);
    const first = await claimed.status();

    // A restart: handles are rebuilt from runtime labels alone, and the scope
    // has to survive that or the re-mint lands where nobody is looking.
    fake.severWatches();
    const [adopted] = await makeDriver().listInstances(INSTALL);
    const after = await adopted.status();

    if (first.phase !== 'ready' || after.phase !== 'ready') throw new Error('expected both ready');
    expect(after.access.kubeconfig).toBe(first.access.kubeconfig);
  });
});

describe('the generic app stamp (T5)', () => {
  it('runs an image the instance bundle already guarantees on the node', () => {
    // The POC node cannot pull from public registries. If the bundle's alpine
    // ref moves, the sample app stops booting THERE — so it fails here first.
    expect(VCLUSTER_IMAGES).toContain(BUILTIN_STAMPS['sample-app'].app!.image);
  });

  it('stamps a Deployment and Service into the child, and reaches it at the service clusterIP', async () => {
    const driver = appDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    await handle.status(); // any readiness path converges the stamp

    const child = fake.childOf(handle.name)!;
    const [deployment, service] = child.applied[0].split('\n---\n').map((d) => JSON.parse(d));
    expect(deployment.kind).toBe('Deployment');
    expect(deployment.metadata).toMatchObject({ name: 'sample-app', namespace: 'default' });
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe(BUILTIN_STAMPS['sample-app'].app!.image);
    expect(container.imagePullPolicy).toBe('IfNotPresent'); // never reach for a registry the node cannot see
    expect(container.readinessProbe.tcpSocket.port).toBe(8080);
    expect(service.kind).toBe('Service');
    expect(service.spec.ports[0]).toMatchObject({ port: 8080, targetPort: 8080 });

    // The child is reached with the minted kubeconfig, redirected off the
    // in-cluster service DNS the syncer exported (unresolvable from here) onto
    // the clusterIP, with the SAN the cert actually carries.
    const childCall = fake.calls.find((c) => c.args.some((a) => a.startsWith('--kubeconfig=')))!;
    expect(childCall.args).toContain(`--server=https://${fake.serviceIPs.get(handle.name)}:443`);
    expect(childCall.args).toContain(`--tls-server-name=vc.${handle.name}.svc`);
    const kubeconfig = childCall.args.find((a) => a.startsWith('--kubeconfig='))!.slice('--kubeconfig='.length);
    // The driver's own way in — never inside an owner's slice of the materials tree.
    expect(kubeconfig.startsWith(path.join(materialsDir, '.child-access'))).toBe(true);
    expect(fs.readFileSync(kubeconfig, 'utf8')).toContain('kind: Config');
  });

  it('a pool slot flips warm only once its app is up — the warm gate IS app readiness', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false; // the vcluster half boots instantly
    const driver = appDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);

    // vcluster up, kubeconfig exported — and still not warm, because the app
    // that makes this stamp what it is has not rolled out.
    expect(warmSlots()).toHaveLength(0);
    const [slot] = [...fake.namespaces.keys()];
    expect(fake.childOf(slot)!.deployments.has('default/sample-app')).toBe(true); // the same poll stamped it

    fake.completeChildRollout(slot);
    await vi.advanceTimersByTimeAsync(2_500);
    driver.dispose();

    expect(warmSlots()).toEqual([slot]);
  });

  it('a cold claim stays provisioning until the app is up, then fires ready exactly once', async () => {
    vi.useFakeTimers();
    const driver = appDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    const ready = vi.fn();
    handle.onReady(ready);

    fake.completeBoot(handle.name); // vcluster ready, app not
    expect((await handle.status()).phase).toBe('provisioning');
    expect(ready).not.toHaveBeenCalled();

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(2_500); // the handle's own poll catches up
    expect(ready).toHaveBeenCalledOnce();
  });

  it('heals a vanished app while the instance has never been ready — by a probe and by a replayed claim', async () => {
    const driver = appDriver();
    const key = freshKey();
    const handle = await driver.claim(claimSpec(key));
    fake.completeBoot(handle.name); // vcluster up, app applied, not rolled out
    expect(fake.childOf(handle.name)!.deployments.has('default/sample-app')).toBe(true);

    fake.childOf(handle.name)!.deployments.clear(); // lost before it ever came up
    expect((await handle.status()).phase).toBe('provisioning');
    expect(fake.childOf(handle.name)!.deployments.has('default/sample-app')).toBe(true); // healed by the probe

    fake.childOf(handle.name)!.deployments.clear();
    const replayed = await driver.claim(claimSpec(key)); // idempotent-on-key replay
    expect(replayed.name).toBe(handle.name);
    expect(fake.childOf(handle.name)!.deployments.has('default/sample-app')).toBe(true);
  });

  it('once ready, the child is the agent’s: a deleted app is neither re-applied nor reported broken', async () => {
    // The frozen-instance rule (D21). After hand-over the driver has no
    // business asserting a stamp over an agent's own cluster — and an env that
    // went active must not fall back to provisioning because they changed it.
    const driver = appDriver();
    const key = freshKey();
    const handle = await driver.claim(claimSpec(key));
    fake.completeBoot(handle.name);
    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
    const callsAfterReady = fake.calls.length;

    fake.childOf(handle.name)!.deployments.clear(); // the agent deleted the sample app

    expect((await handle.status()).phase).toBe('ready');
    expect(fake.childOf(handle.name)!.deployments.size).toBe(0); // not put back
    // And no child connection was opened at all on the post-ready path.
    const childCalls = fake.calls
      .slice(callsAfterReady)
      .filter((c) => c.args.some((a) => a.startsWith('--kubeconfig=')));
    expect(childCalls).toEqual([]);
  });

  it('an adopted ready instance never re-arms first-boot semantics', async () => {
    // The same rule across a restart: readiness is remembered on the runtime,
    // so a rediscovered handle neither gates on the app nor arms a boot timer
    // that would eventually call a live env failed.
    vi.useFakeTimers();
    const driver = appDriver({ bootTimeoutMs: 5_000 });
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');

    fake.severWatches();
    fake.childOf(handle.name)!.deployments.clear(); // the agent's own change survives the restart
    const [adopted] = await appDriver({ bootTimeoutMs: 5_000 }).listInstances(INSTALL);
    const terminal = vi.fn();
    adopted.onTerminal(terminal);

    expect((await adopted.status()).phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(10_000); // twice the boot budget
    expect(terminal).not.toHaveBeenCalled();
    expect((await adopted.status()).phase).toBe('ready');
  });

  it('an instance whose pod was replaced while the host was down is dead, not resurrected', async () => {
    // The other half of remembering readiness: the frozen-instance rule has to
    // survive the restart too. A fresh empty vcluster wearing the same name is
    // not the world the agent was handed.
    const driver = appDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');

    fake.severWatches();
    fake.pods.get(handle.name)!.uid = 'uid-replacement'; // the Deployment booted a new one

    const [adopted] = await appDriver().listInstances(INSTALL);
    const status = await adopted.status();

    expect(status.phase).toBe('failed');
    if (status.phase !== 'failed') throw new Error('expected failed');
    expect(status.failure).toMatchObject({ kind: 'instance-died' });
  });

  it('a bare stamp is ready with its vcluster and never opens a child connection', async () => {
    const driver = makeDriver(); // stamps: { 'sample-app': {} } — a bare vcluster stays legal
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);

    expect((await handle.status()).phase).toBe('ready');
    expect(fake.calls.some((c) => c.args.some((a) => a.startsWith('--kubeconfig=')))).toBe(false);
  });

  it('serves from an applet the pinned image actually has', () => {
    // Verified against the image, not assumed: alpine's busybox has NO httpd
    // applet (that is busybox-extras) — `busybox httpd` exits "applet not
    // found" and the pod would crash-loop on the node. `nc -lk -e` is the
    // documented persistent-server mode, which is also what lets a readiness
    // probe reconnect every two seconds without racing a dying listener.
    const command = BUILTIN_STAMPS['sample-app'].app!.command!;
    expect(command).not.toContain('httpd');
    expect(command.slice(0, 5)).toEqual(['/bin/busybox', 'nc', '-lk', '-p', '8080']);
    // The response must reach the container as literal backslash escapes for
    // busybox printf to turn into CRLF — real control bytes in argv would be a
    // different (and fragile) thing entirely.
    const response = command[command.length - 1];
    expect(response).toContain('\\r\\n');
    expect(response).not.toMatch(/[\r\n]/);
    // And it drains the request before answering: closing a socket with unread
    // bytes RSTs the connection, which truncates the reply the client already
    // has (measured — the body never arrives without this).
    expect(response).toContain('while read -r');
  });

  it('bounds every probe-path call, so an unreachable apiserver cannot stall a watch callback', async () => {
    const driver = appDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    await handle.status();

    const svcGet = fake.calls.find((c) => c.args[0] === 'get' && c.args[1] === 'svc')!;
    const secretGet = fake.calls.find((c) => c.args[0] === 'get' && c.args[1] === 'secret')!;
    const childGet = fake.calls.find(
      (c) => c.args.some((a) => a.startsWith('--kubeconfig=')) && c.args.includes('deployment'),
    )!;
    for (const call of [svcGet, secretGet, childGet]) {
      expect(call.args).toContain('--request-timeout=5000ms');
    }
  });

  it('drops a stale child credential when a probe fails, and recovers on the next one', async () => {
    const driver = appDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.completeBoot(handle.name);
    await handle.status(); // mints the driver's way into the child
    const kubeconfig = path.join(materialsDir, '.child-access', handle.name, 'kubeconfig');
    expect(fs.existsSync(kubeconfig)).toBe(true);

    // The child's control plane restarted: new address, regenerated PKI. A
    // cache that outlives its own cluster would poison every later probe.
    fake.serviceIPs.set(handle.name, '10.43.0.250');
    expect((await handle.status()).phase).toBe('provisioning');
    expect(fs.existsSync(kubeconfig)).toBe(false);

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready'); // re-minted against current truth
    expect(fs.existsSync(kubeconfig)).toBe(true);
  });

  it('refuses an app stamp whose id cannot name a child object', () => {
    // It passes the label grammar and would fail on the node, every time.
    expect(() => appDriver({ stamps: { Sample_App: BUILTIN_STAMPS['sample-app'] } })).toThrow(/legal k8s object name/);
  });
});

describe('the nanoclaw builtin stamp (childManifests)', () => {
  /** The DEFAULT stamp table — where builtin `nanoclaw` lives. */
  function nanoclawDriver(overrides: Partial<ConstructorParameters<typeof K8sDevEnvDriver>[0]> = {}): K8sDevEnvDriver {
    return makeDriver({ stamps: undefined, ...overrides });
  }

  function nanoclawSpec(key: EnvKey): DriverClaimSpec {
    return { key, stampId: 'nanoclaw', labels: devEnvLabels(INSTALL, key, 'nanoclaw'), options: {} };
  }

  it('applies the full child bundle and gates readiness on the DECLARED deployment', async () => {
    const driver = nanoclawDriver();
    const handle = await driver.claim(nanoclawSpec(freshKey()));
    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('provisioning'); // vcluster up ≠ nanoclaw up

    const kinds = fake
      .childOf(handle.name)!
      .applied[0].split('\n---\n')
      .map((d) => JSON.parse(d).kind);
    expect(kinds).toEqual([
      'Namespace',
      'ServiceAccount',
      'Role',
      'RoleBinding',
      'PersistentVolumeClaim',
      'Deployment',
    ]);
    // The probe asked for the deployment the stamp DECLARED, in its declared
    // namespace — not a stampId-named one in `default`.
    const probe = fake.calls.find(
      (c) => c.args.some((a) => a.startsWith('--kubeconfig=')) && c.args.includes('deployment'),
    )!;
    expect(probe.args).toContain(NANOCLAW_HOST_DEPLOYMENT);
    expect(probe.args[probe.args.indexOf('-n') + 1]).toBe(NANOCLAW_NAMESPACE);

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('a pool slot flips warm only once nanoclaw-host is Available — never on the bare vcluster', async () => {
    // The failure mode the readiness declaration exists to prevent: a warm
    // gate that quietly measures only the vcluster and hands out a child in
    // which nanoclaw never booted.
    vi.useFakeTimers();
    fake.manualCompletion = false;
    const driver = nanoclawDriver({ pools: { nanoclaw: 1 } });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);

    expect(warmSlots()).toHaveLength(0);
    const [slot] = [...fake.namespaces.keys()];
    expect(fake.childOf(slot)!.deployments.has(`${NANOCLAW_NAMESPACE}/${NANOCLAW_HOST_DEPLOYMENT}`)).toBe(true); // the same poll applied the bundle

    fake.completeChildRollout(slot);
    await vi.advanceTimersByTimeAsync(2_500);
    driver.dispose();

    expect(warmSlots()).toEqual([slot]);
  });

  it('the childManifests apply path heals a vanished bundle pre-first-ready', async () => {
    const driver = nanoclawDriver();
    const handle = await driver.claim(nanoclawSpec(freshKey()));
    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('provisioning'); // first probe applied the bundle

    fake.childOf(handle.name)!.deployments.clear(); // lost before it ever came up
    expect((await handle.status()).phase).toBe('provisioning');
    expect(fake.childOf(handle.name)!.deployments.has(`${NANOCLAW_NAMESPACE}/${NANOCLAW_HOST_DEPLOYMENT}`)).toBe(true); // healed by the probe
  });

  it('once ready the child is the agent’s — the bundle is never re-asserted', async () => {
    const driver = nanoclawDriver();
    const handle = await driver.claim(nanoclawSpec(freshKey()));
    fake.completeBoot(handle.name);
    await handle.status(); // applies the bundle
    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
    const callsAfterReady = fake.calls.length;

    fake.childOf(handle.name)!.deployments.clear(); // the agent tore nanoclaw down in their own world

    expect((await handle.status()).phase).toBe('ready');
    const childCalls = fake.calls
      .slice(callsAfterReady)
      .filter((c) => c.args.some((a) => a.startsWith('--kubeconfig=')));
    expect(childCalls).toEqual([]);
  });

  it('refuses a childManifests stamp without a readiness declaration at construction', () => {
    expect(() => makeDriver({ stamps: { child: { childManifests: '{}' } } })).toThrow(/readiness/);
  });

  it('refuses a readiness declaration nothing in the stamp can ever meet', () => {
    expect(() => makeDriver({ stamps: { child: { readiness: { deployment: 'd', namespace: 'n' } } } })).toThrow(
      /childManifests/,
    );
  });

  it('refuses readiness names that cannot name k8s objects', () => {
    expect(() =>
      makeDriver({
        stamps: { child: { childManifests: '{}', readiness: { deployment: 'Bad_Name', namespace: 'n' } } },
      }),
    ).toThrow(/legal k8s object name/);
    // Namespaces answer to the stricter label grammar — dots are illegal there.
    expect(() =>
      makeDriver({
        stamps: { child: { childManifests: '{}', readiness: { deployment: 'd', namespace: 'ns.dot' } } },
      }),
    ).toThrow(/legal k8s object name/);
  });

  it('accepts a readiness deployment named as a subdomain — the apiserver grammar, not the label one', () => {
    // Deployment names are RFC-1123 subdomains; a third-party bundle naming
    // its gate `ingress.controller` is legal on the cluster and must be here.
    expect(() =>
      makeDriver({
        stamps: { child: { childManifests: '{}', readiness: { deployment: 'ingress.controller', namespace: 'n' } } },
      }),
    ).not.toThrow();
  });

  it('converges on absence only: a Deployment mid-rollout is probed, never re-applied', async () => {
    const driver = nanoclawDriver();
    const handle = await driver.claim(nanoclawSpec(freshKey()));
    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('provisioning'); // first probe applied the bundle
    const child = fake.childOf(handle.name)!;
    expect(child.applied).toHaveLength(1);

    // Present-but-not-Available is a rollout in progress; re-applying cannot
    // hasten it, and nanoclaw's boot makes this window minutes long — a
    // whole-bundle apply per poll would ride it the entire way.
    expect((await handle.status()).phase).toBe('provisioning');
    expect((await handle.status()).phase).toBe('provisioning');
    expect(child.applied).toHaveLength(1);

    // And the apply that did run was bounded like the probes beside it.
    const childApply = fake.calls.find(
      (c) => c.args.some((a) => a.startsWith('--kubeconfig=')) && c.args.includes('apply'),
    )!;
    expect(childApply.args).toContain('--request-timeout=5000ms');
  });

  it('a deterministic apply rejection fails the instance now — never polled out as retryable', async () => {
    // childManifests is operator-suppliable raw text: a schema typo would
    // otherwise warn every 2s to the deadline, time out as retryable, and
    // burn a boot budget per attempt forever.
    vi.useFakeTimers();
    fake.failChildApplyWith(
      'error: error validating "STDIN": error validating data: ValidationError(Deployment.spec): unknown field "replica"',
    );
    const driver = nanoclawDriver();
    const handle = await driver.claim(nanoclawSpec(freshKey()));
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    fake.completeBoot(handle.name);
    await handle.status(); // the probe hits the rejection
    await vi.advanceTimersByTimeAsync(2_500); // one poll tick — not the boot budget

    expect(terminal).toHaveBeenCalledOnce();
    const failure = terminal.mock.calls[0][0];
    expect(failure).toMatchObject({ kind: 'instantiation-failed', retryable: false });
    expect(failure.detail).toContain('nanoclaw');
    // Persisted: a restarted host's discovery sees residue, not a boot in progress.
    expect(fake.namespaces.get(handle.name)!.annotations['nanoclaw-dev/state']).toBe('failed');
  });

  it('a pool fill hitting a rejected stamp leaves failed residue instead of burning the boot budget', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.failChildApplyWith('The Deployment "nanoclaw-host" is invalid: spec.replicas: Invalid value: "x"');
    const driver = nanoclawDriver({ pools: { nanoclaw: 1 } });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(2_500);
    driver.dispose();

    expect(warmSlots()).toHaveLength(0);
    const corpse = [...fake.namespaces.values()].find((ns) => ns.annotations['nanoclaw-dev/state'] === 'failed')!;
    expect(corpse.labels['nanoclaw-dev-slot']).toBeUndefined(); // not capacity

    // Stopping the pool is also the source-owned cleanup operation. The
    // failed namespace stays visible while the target is active, then a new
    // driver snapshot with no target reaps it without touching claimed envs.
    const drainer = nanoclawDriver({ pools: {} });
    await drainer.reapResidue(INSTALL);
    drainer.dispose();
    expect(fake.namespaces.has(corpse.name)).toBe(false);
  });
});

describe('the nanoclaw child bundle (rendered)', () => {
  const docs = NANOCLAW_CHILD_MANIFESTS.split('\n---\n').map((d) => JSON.parse(d));
  const deployment = docs.find((d) => d.kind === 'Deployment')!;
  const podSpec = deployment.spec.template.spec;

  it('is registered builtin, readiness pointing at the deployment it renders', () => {
    expect(BUILTIN_STAMPS.nanoclaw.childManifests).toBe(NANOCLAW_CHILD_MANIFESTS);
    expect(BUILTIN_STAMPS.nanoclaw.readiness).toEqual({
      deployment: NANOCLAW_HOST_DEPLOYMENT,
      namespace: NANOCLAW_NAMESPACE,
    });
  });

  it('every rendered pod is PSA-baseline-legal: no hostPath, no privileged, no hostNetwork', () => {
    // The instance namespace enforces baseline on synced pods; a bundle that
    // reached for any of these would fail on the node, every time.
    expect(NANOCLAW_CHILD_MANIFESTS).not.toContain('hostPath');
    expect(NANOCLAW_CHILD_MANIFESTS).not.toContain('privileged');
    expect(NANOCLAW_CHILD_MANIFESTS).not.toContain('hostNetwork');
    // The tree rides the PVC instead — which is what fsGroup can actually own.
    expect(podSpec.volumes).toContainEqual({ name: 'tree', persistentVolumeClaim: { claimName: 'nanoclaw-tree' } });
  });

  it('one namespace holds host, sessions and PVC — cross-namespace mounts do not exist', () => {
    for (const doc of docs) {
      if (doc.kind === 'Namespace') expect(doc.metadata.name).toBe('nanoclaw');
      else expect(doc.metadata.namespace).toBe('nanoclaw');
    }
  });

  it('the host deployment carries the exact contract: env, probe, resources, securityContext', () => {
    expect(deployment.metadata.name).toBe('nanoclaw-host');
    expect(deployment.spec).toMatchObject({ replicas: 1, strategy: { type: 'Recreate' } });
    expect(podSpec.serviceAccountName).toBe('nanoclaw-host');
    expect(podSpec.automountServiceAccountToken).toBe(true);
    expect(podSpec.securityContext).toEqual({ runAsUser: 501, runAsGroup: 1000, fsGroup: 1000 });

    const container = podSpec.containers[0];
    expect(container.image).toBe('nanoclaw-child-host:v05'); // versioned, never :latest
    expect(container.imagePullPolicy).toBe('IfNotPresent');
    expect(container.env).toEqual([
      { name: 'HOME', value: '/tmp' },
      { name: 'NANOCLAW_RUNTIME_DRIVER', value: 'pod' },
      { name: 'NANOCLAW_POD_NAMESPACE', value: 'nanoclaw' },
      { name: 'NANOCLAW_SESSION_EGRESS', value: 'none' },
      { name: 'NANOCLAW_POD_VOLUME_PVC', value: 'nanoclaw-tree' },
      { name: 'NANOCLAW_POD_VOLUME_ROOT', value: '/nanoclaw/host' },
      { name: 'CONTAINER_IMAGE', value: 'nanoclaw-agent:spike-p0' },
      { name: 'DEFAULT_AGENT_PROVIDER', value: 'mock' },
    ]);
    // socket-exists == fully booted (the ncl socket server is the last boot
    // step) — honest only because the child-host image's entrypoint unlinks
    // the PVC-persisted socket before starting the host; see the manifest.
    expect(container.readinessProbe.exec.command).toEqual(['test', '-S', '/nanoclaw/host/data/ncl.sock']);
    expect(container.resources).toEqual({
      requests: { cpu: '200m', memory: '256Mi' },
      limits: { cpu: '1', memory: '1536Mi' },
    });
  });

  it('the in-child grant is five verbs on pods, nothing else', () => {
    const role = docs.find((d) => d.kind === 'Role')!;
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch', 'create', 'delete'] },
    ]);
    const binding = docs.find((d) => d.kind === 'RoleBinding')!;
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'nanoclaw-host', namespace: 'nanoclaw' }]);
  });

  it('the PVC asks 10Gi RWO of the child default StorageClass — no class named', () => {
    const pvc = docs.find((d) => d.kind === 'PersistentVolumeClaim')!;
    expect(pvc.metadata.name).toBe('nanoclaw-tree');
    expect(pvc.spec).toEqual({ accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } });
  });

  it('the D10 dev-mode manifest pins the child-sync contract', () => {
    expect(NANOCLAW_DEV_MODE_MANIFEST.host).toEqual({
      artifact: 'tree',
      prepare: 'build',
      dest: '/nanoclaw/host',
      exclude: ['node_modules', '.git', 'data', 'groups', 'dist', '.env'],
      reload: { kind: 'rollout', namespace: 'nanoclaw', deployment: 'nanoclaw-host' },
    });
  });
});

describe('per-claim routes (D19)', () => {
  const CLAIMANT_NS = 'agents';

  function routedSpec(key: EnvKey): DriverClaimSpec {
    return {
      ...claimSpec(key),
      claimantNamespace: CLAIMANT_NS,
      claimantSelector: { 'nanoclaw-install': INSTALL, 'nanoclaw-group': 'g1', 'nanoclaw-role': 'agent' },
    };
  }

  function routeOf(
    key: EnvKey,
  ): { name: string; namespace: string; labels: Record<string, string>; doc: object } | undefined {
    return fake.netpols.get(`${CLAIMANT_NS}/dev-env-route-${key.instanceId}`);
  }

  it('a cold claim opens the route in the CLAIMANT namespace and records the pointer back to it', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(routedSpec(key));

    const route = routeOf(key);
    expect(route).toBeDefined();
    const doc = route!.doc as { spec: { podSelector: object; egress: Array<{ to: object[]; ports: object[] }> } };
    expect(doc.spec.podSelector).toEqual({
      matchLabels: { 'nanoclaw-install': INSTALL, 'nanoclaw-group': 'g1', 'nanoclaw-role': 'agent' },
    });
    expect(doc.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 8443 }]);
    expect(JSON.stringify(doc)).toContain(`"kubernetes.io/metadata.name":"${handle.name}"`);
    // The pointer every close path needs, persisted on the runtime: the route
    // does not live in (or die with) the instance's own namespace.
    expect(fake.namespaces.get(handle.name)!.annotations['nanoclaw-dev/claimant-ns']).toBe(CLAIMANT_NS);
  });

  it('a warm claim opens the same route the cold path would — parity at the CAS flip', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    const [slot] = warmSlots();

    const key = freshKey();
    const handle = await driver.claim(routedSpec(key));

    expect(handle.name).toBe(slot); // it WAS the warm path
    const route = routeOf(key);
    expect(route).toBeDefined();
    expect(JSON.stringify(route!.doc)).toContain(`"kubernetes.io/metadata.name":"${slot}"`);
    expect(fake.namespaces.get(slot)!.annotations['nanoclaw-dev/claimant-ns']).toBe(CLAIMANT_NS);
  });

  it('a claim without claimant placement authors no route — fail closed, not fail open', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    await driver.claim(claimSpec(freshKey()));
    expect(fake.netpols.size).toBe(0);
  });

  it('release closes the route explicitly — the namespace delete cannot take it along', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(routedSpec(key));
    fake.completeBoot(handle.name);
    expect(routeOf(key)).toBeDefined();

    await handle.release('done');

    expect(routeOf(key)).toBeUndefined();
    expect(fake.netpolLog).toContain(`delete ${CLAIMANT_NS}/dev-env-route-${key.instanceId}`);
  });

  it('terminal death closes the route', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(routedSpec(key));
    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('ready');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    // The frozen-instance death: a replacement pod after ready.
    const pod = fake.pods.get(handle.name)!;
    pod.uid = 'uid-replacement';
    for (const proc of fake.watchProcs(handle.name)) {
      proc.emitStdout(
        JSON.stringify({
          type: 'MODIFIED',
          object: {
            metadata: { name: 'vc-0', namespace: handle.name, uid: 'uid-replacement', labels: { app: 'vcluster' } },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          },
        }),
      );
    }

    expect(terminal).toHaveBeenCalledOnce();
    expect(routeOf(key)).toBeUndefined();
  });

  it('reapResidue closes the routes of the residue it collects', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    // A dead claimed instance a crashed host left behind, route still open.
    fake.namespaces.set('dead-ns', {
      name: 'dead-ns',
      labels: {
        [DEV_ENV_LABELS.install]: INSTALL,
        [DEV_ENV_LABELS.env]: 'env-dead',
        [DEV_ENV_LABELS.instance]: 'ins-dead',
        [DEV_ENV_LABELS.stamp]: 'sample-app',
      },
      annotations: { 'nanoclaw-dev/state': 'failed', 'nanoclaw-dev/claimant-ns': CLAIMANT_NS },
      resourceVersion: 1,
      creationTimestamp: new Date().toISOString(),
      terminating: false,
    });
    fake.netpols.set(`${CLAIMANT_NS}/dev-env-route-ins-dead`, {
      name: 'dev-env-route-ins-dead',
      namespace: CLAIMANT_NS,
      labels: { [DEV_ENV_LABELS.install]: INSTALL, [DEV_ENV_LABELS.instance]: 'ins-dead' },
      doc: {},
    });

    await driver.reapResidue(INSTALL);

    expect(fake.namespaces.has('dead-ns')).toBe(false);
    expect(fake.netpols.has(`${CLAIMANT_NS}/dev-env-route-ins-dead`)).toBe(false);
  });

  it('the residue sweep also collects a route whose instance vanished entirely — and spares live ones', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(routedSpec(key)); // live claim: teaches the sweep the claimant namespace
    // A route whose instance namespace is GONE (external teardown, blipped
    // close): once its instance is unaccounted for, it must not sit where a
    // future namespace reusing the name would give it meaning again.
    fake.netpols.set(`${CLAIMANT_NS}/dev-env-route-ins-vanished`, {
      name: 'dev-env-route-ins-vanished',
      namespace: CLAIMANT_NS,
      labels: { [DEV_ENV_LABELS.install]: INSTALL, [DEV_ENV_LABELS.instance]: 'ins-vanished' },
      doc: {},
    });

    await driver.reapResidue(INSTALL);

    expect(fake.netpols.has(`${CLAIMANT_NS}/dev-env-route-ins-vanished`)).toBe(false);
    expect(routeOf(key)).toBeDefined(); // the live claim keeps its route
  });

  it('a replayed claim heals a missing route — and an intact one is a no-op, not a conflict', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    const key = freshKey();
    const spec = routedSpec(key);
    const first = await driver.claim(spec);

    // Intact: create is AlreadyExists-tolerant, so the replay passes through.
    const replayed = await driver.claim(spec);
    expect(replayed.name).toBe(first.name);

    // Missing (died between open and here, or deleted by hand): comes back.
    fake.netpols.delete(`${CLAIMANT_NS}/dev-env-route-${key.instanceId}`);
    await driver.claim(spec);
    expect(routeOf(key)).toBeDefined();
  });

  it('a claim whose route cannot open allocates NOTHING — atomicity covers the route', async () => {
    // The claimant namespace does not exist: the route create fails, and the
    // claim must not hand out an env its owner cannot reach.
    const driver = makeDriver();
    await expect(driver.claim(routedSpec(freshKey()))).rejects.toBeDefined();
    expect(fake.namespaces.size).toBe(0);
    expect(fake.netpols.size).toBe(0);
  });

  it('a WARM claim whose route cannot open becomes marked residue the reap collects — never a reachable-by-nobody env', async () => {
    // The cold path unwinds; the warm path CANNOT — the CAS flip already made
    // the slot this owner's instance. The decided semantics: throw, mark the
    // slot failed, let reapResidue collect it.
    fake.manualCompletion = false;
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await settle();
    driver.dispose();
    const [slot] = warmSlots();

    const key = freshKey();
    // No claimant namespace seeded: the netpol create fails AFTER the flip.
    await expect(driver.claim(routedSpec(key))).rejects.toBeDefined();

    expect(routeOf(key)).toBeUndefined();
    const ns = fake.namespaces.get(slot)!;
    expect(ns.annotations['nanoclaw-dev/state']).toBe('failed');
    expect(ns.annotations['nanoclaw-dev/failure']).toBe('instantiation-failed');
    // Marked residue is COLLECTED residue: the slot must not linger as an
    // unreachable env, nor count as pool capacity.
    await driver.reapResidue(INSTALL);
    expect(fake.namespaces.has(slot)).toBe(false);
  });

  it('a handle rebuilt after a host restart still closes the route on release — the pointer rides the runtime', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const first = makeDriver();
    const key = freshKey();
    const handle = await first.claim(routedSpec(key));
    fake.completeBoot(handle.name);
    expect(routeOf(key)).toBeDefined();

    // "Restart": a NEW driver object over the surviving runtime, its handle
    // reconstructed from discovery alone — labels plus the claimant-ns
    // annotation are all it has.
    const restarted = makeDriver();
    const [adopted] = await restarted.listInstances(INSTALL);
    expect(adopted.key).toEqual(key);

    await adopted.release('done');

    expect(routeOf(key)).toBeUndefined();
    expect(fake.netpolLog).toContain(`delete ${CLAIMANT_NS}/dev-env-route-${key.instanceId}`);
  });

  it('the sweep collects a leaked route even when NO live instance remains to name the claimant namespace', async () => {
    fake.seedForeignNamespace(CLAIMANT_NS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(routedSpec(key));
    // External teardown of the ONLY instance while nothing observed it (the
    // watch was down — the blipped-close shape): the annotation died with the
    // namespace, so annotations alone can no longer name the claimant
    // namespace, and an idle install would leak the route until the next
    // claim re-taught it.
    fake.severWatches();
    fake.crash(handle.name);
    expect(routeOf(key)).toBeDefined();

    await driver.reapResidue(INSTALL);

    expect(routeOf(key)).toBeUndefined();
  });
});

describe('exposure targets (C14)', () => {
  it('finds the one synced Service on a port, freezes its CHILD-side name, and answers the address of the moment', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.syncService({ namespace: handle.name, name: 'backlot', port: 8080, clusterIP: '10.43.0.9' });

    // Resolution reads what the syncer materialized — the control plane's own
    // `vc` services carry no managed-by stamp and are therefore never candidates.
    expect(await handle.resolveExposureTarget!({ port: 8080 })).toEqual({
      service: 'default/backlot',
      address: '10.43.0.9',
      port: 8080,
    });
    // The frozen form and the bare child name both dial; nothing is cached, so
    // a re-minted Service answers with its NEW address on the very next call.
    fake.syncService({ namespace: handle.name, name: 'backlot', port: 8080, clusterIP: '10.43.0.77' });
    expect(await handle.resolveExposureTarget!({ service: 'default/backlot', port: 8080 })).toMatchObject({
      address: '10.43.0.77',
    });
    expect(await handle.resolveExposureTarget!({ service: 'backlot', port: 8080 })).toMatchObject({
      address: '10.43.0.77',
    });
    driver.dispose();
  });

  it('a miss is null and ambiguity throws — one is "not right now", the other is "say which"', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));

    // Nothing serving: fail closed rather than dial a memory.
    expect(await handle.resolveExposureTarget!({ port: 8080 })).toBeNull();

    fake.syncService({ namespace: handle.name, name: 'backlot', port: 8080, clusterIP: '10.43.0.9' });
    fake.syncService({ namespace: handle.name, name: 'twin', port: 8080, clusterIP: '10.43.0.10' });
    await expect(handle.resolveExposureTarget!({ port: 8080 })).rejects.toThrow(/2 services serve port 8080/);
    // Named, it resolves — ambiguity is a grant-time question, never a dial-time one.
    expect(await handle.resolveExposureTarget!({ service: 'twin', port: 8080 })).toMatchObject({
      service: 'default/twin',
    });

    // A service that stops serving the port, and one deleted outright: both MISS.
    fake.dropSyncedService(handle.name, 'twin-x-default-x-vc');
    fake.dropSyncedService(handle.name, 'backlot-x-default-x-vc');
    expect(await handle.resolveExposureTarget!({ service: 'default/backlot', port: 8080 })).toBeNull();
    driver.dispose();
  });

  it('a headless Service is not a target — there is no address to dial', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));
    fake.syncService({ namespace: handle.name, name: 'headless', port: 8080, clusterIP: 'None' });

    expect(await handle.resolveExposureTarget!({ port: 8080 })).toBeNull();
    driver.dispose();
  });
});

describe('failure normalization', () => {
  it('maps kubectl phrasings onto the seam taxonomy', () => {
    expect(
      normalizeK8sFailure(new Error(`ValidatingAdmissionPolicy 'guard' with binding 'guard-b' denied request: no`)),
    ).toMatchObject({ kind: 'denied-by-policy', retryable: false });
    // Real quota rejections phrase as `is forbidden: exceeded quota` — the
    // capacity signal must win over the policy-denial match, or genuine
    // capacity exhaustion becomes a permanent denial.
    expect(normalizeK8sFailure(new Error('pods "vc-0" is forbidden: exceeded quota: dev-env'))).toMatchObject({
      kind: 'capacity-exhausted',
      retryable: true,
    });
    expect(
      normalizeK8sFailure(
        new Error('The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?'),
      ),
    ).toMatchObject({ kind: 'driver-unavailable', retryable: true });
    expect(normalizeK8sFailure(new Error('0/1 nodes are available: Insufficient memory'))).toMatchObject({
      kind: 'capacity-exhausted',
      retryable: true,
    });
    expect(
      normalizeK8sFailure(new Error('The connection to the server was refused - connection refused')),
    ).toMatchObject({ kind: 'driver-unavailable', retryable: true });
    const unknown = normalizeK8sFailure(new Error('something novel'));
    expect(unknown.kind).toBe('unknown');
    expect((unknown as { opaqueRef?: string }).opaqueRef).toMatch(/^kubectl:/);
  });
});

describe('rendered bundle', () => {
  it('substitutes the namespace everywhere and applies the regenerated config secret', async () => {
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));

    const applied = fake.calls.filter((c) => c.args[0] === 'apply').map((c) => c.input ?? '');
    const manifests = applied.find((i) => !i.trimStart().startsWith('{'))!;
    expect(manifests).not.toContain(VCLUSTER_NS_TOKEN);
    expect(manifests).toContain(`namespace: ${handle.name}`);
    // The D19 seal ships with every instance.
    expect(manifests).toContain('kind: NetworkPolicy');
    expect(manifests).toContain('dev-env-default-deny');
    expect(manifests).toContain('key: nanoco.dev/trust-boundary');
    expect(manifests).toContain('operator: DoesNotExist');

    const configSecret = fake.secrets.get(`${handle.name}/vc-config-vc`);
    expect(configSecret).toBeDefined();
    const config = Buffer.from(configSecret!['config.yaml'], 'base64').toString('utf8');
    expect(config).not.toContain(VCLUSTER_NS_TOKEN);
    expect(config).toContain(`server: https://vc.${handle.name}.svc:443`);
    expect(config).toContain(`- vc.${handle.name}.svc`);
  });

  it('lets the Host reach the workspace controller in the companion namespace', async () => {
    // The controller's own ingress policy names `app: nanoclaw-host` in the
    // instance namespace, but the Host is under `governed-host`, which sets
    // policyTypes [Ingress, Egress] — so without a matching egress rule only
    // one half of the pair allows the call. Observed as every ensure() failing
    // `fetch failed` at workspace-plane request(), while the controller's log
    // stayed empty because the request never arrived.
    const driver = makeDriver();
    const handle = await driver.claim(claimSpec(freshKey()));

    const applied = fake.calls.filter((c) => c.args[0] === 'apply').map((c) => c.input ?? '');
    const manifests = applied.find((i) => !i.trimStart().startsWith('{'))!;
    const governedHost = manifests
      .split('---')
      .find((doc) => doc.includes('name: governed-host'))!;
    expect(governedHost).toBeDefined();
    // The companion namespace is the one destination the Host reaches outside
    // its own namespace, so the rule must be namespace-scoped, not a bare
    // podSelector that would only ever match locally.
    expect(governedHost).toContain(`kubernetes.io/metadata.name: ${handle.name}-workspace`);
    expect(governedHost).toContain('app.kubernetes.io/name: nanoclaw-workspace-controller');
    expect(governedHost).toContain('port: 8787');
  });

  it('the checked-in manifests carry no rendering leftovers', () => {
    expect(VCLUSTER_MANIFESTS).not.toContain('vcns-000');
    expect(VCLUSTER_MANIFESTS).toContain(VCLUSTER_NS_TOKEN);
  });
});

describe('claim validation', () => {
  it('refuses labels that cannot round-trip the k8s grammar', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const spec = {
      ...claimSpec(key),
      labels: { ...devEnvLabels(INSTALL, key, 'sample-app'), extra: 'no spaces allowed' },
    };
    await expect(driver.claim(spec)).rejects.toMatchObject({ kind: 'instantiation-failed' });
    expect(fake.namespaces.size).toBe(0);
  });

  it('refuses option keys that cannot become annotations', async () => {
    const driver = makeDriver();
    await expect(driver.claim(claimSpec(freshKey(), { 'bad key!': 'v' }))).rejects.toMatchObject({
      kind: 'instantiation-failed',
    });
  });

  it('ensureReady maps an unreachable apiserver to driver-unavailable', async () => {
    const cli = {
      bin: 'kubectl',
      run: () => {
        throw new Error('The connection to the server was refused');
      },
      start: () => {
        throw new Error('not under test');
      },
    };
    const driver = new K8sDevEnvDriver({ installScope: INSTALL, cli, materialsDir });
    await expect(driver.ensureReady()).rejects.toMatchObject({ kind: 'driver-unavailable', retryable: true });
  });
});

describe('the nanoclaw dev-flavor bundle (rendered)', () => {
  const rendered = renderDevChildManifests({ runAsUser: 1000, runAsGroup: 20 });
  const docs = rendered.split('\n---\n').map((d) => JSON.parse(d));
  const deployment = docs.find((d) => d.kind === 'Deployment')!;
  const podSpec = deployment.spec.template.spec;

  it('differs from the baked bundle in exactly the tree dimension: claim, image, identity, flag — and authors NO PVC', () => {
    // Platform authorship (C16): the tree claim is the driver's to create —
    // the dev stream only MOUNTS the platform's `dev-tree`, so a PVC document
    // here would be the create-time collision the registry refuses.
    expect(docs.find((d) => d.kind === 'PersistentVolumeClaim')).toBeUndefined();

    const container = podSpec.containers[0];
    expect(container.image).toBe(NANOCLAW_CHILD_HOST_DEV_IMAGE);
    expect(container.env).toContainEqual({ name: 'NANOCLAW_DEV_TREE', value: '1' });
    // Session pods keep the one-claim PVC-subPath mode against the DEV claim.
    expect(container.env).toContainEqual({ name: 'NANOCLAW_POD_VOLUME_PVC', value: DEV_TREE_PVC });
    expect(podSpec.volumes).toContainEqual({
      name: 'tree',
      persistentVolumeClaim: { claimName: DEV_TREE_PVC },
    });

    // The host runs as the TREE OWNER, and fsGroup is absent — the kubelet
    // must never recursively chgrp a developer's working tree at mount time.
    // The render is the generic token substitution over the DECLARED stream
    // (one implementation), so resolved integers landing here proves it.
    expect(podSpec.securityContext).toEqual({ runAsUser: 1000, runAsGroup: 20 });
  });

  it('keeps everything else the baked contract pins: gate, grant, singleton, PSA legality', () => {
    expect(deployment.metadata.name).toBe(NANOCLAW_HOST_DEPLOYMENT);
    expect(deployment.spec).toMatchObject({ replicas: 1, strategy: { type: 'Recreate' } });
    expect(podSpec.containers[0].readinessProbe.exec.command).toEqual(['test', '-S', '/nanoclaw/host/data/ncl.sock']);
    const role = docs.find((d) => d.kind === 'Role')!;
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch', 'create', 'delete'] },
    ]);
    expect(rendered).not.toContain('hostPath');
    expect(rendered).not.toContain('privileged');
    expect(rendered).not.toContain('hostNetwork');
  });

  it('the dev D10 manifest: same reload, prepare moves sandbox-side, transport is the mount (nothing excluded)', () => {
    expect(NANOCLAW_DEV_MODE_MANIFEST_DEV.host).toEqual({
      artifact: 'tree',
      prepare: 'build',
      dest: '/nanoclaw/host',
      exclude: [],
      reload: { kind: 'rollout', namespace: 'nanoclaw', deployment: 'nanoclaw-host' },
    });
  });
});

describe('the dev-tree flavor (hot loop)', () => {
  let treeDir: string;

  beforeEach(() => {
    treeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tree-'));
  });

  afterEach(() => {
    fs.rmSync(treeDir, { recursive: true, force: true });
  });

  /** The DEFAULT stamp table — dev claims exist for the builtin nanoclaw bundle. */
  function devDriver(overrides: Partial<ConstructorParameters<typeof K8sDevEnvDriver>[0]> = {}): K8sDevEnvDriver {
    return makeDriver({ stamps: undefined, ...overrides });
  }

  function devSpec(key: EnvKey, tree: string = treeDir): DriverClaimSpec {
    return {
      key,
      stampId: 'nanoclaw',
      labels: devEnvLabels(INSTALL, key, 'nanoclaw'),
      options: { [DEV_TREE_OPTION]: tree },
    };
  }

  it('a dev claim authors the pre-bound PV, then stamps the DEV bundle and gates on the same deployment', async () => {
    const driver = devDriver();
    const handle = await driver.claim(devSpec(freshKey()));

    // The PV landed IN the atomic claim, before any child claim can exist —
    // pre-binding beats the provisioner race only when the PV is first.
    const pv = fake.pvs.get(devTreePvName(handle.name))!;
    expect(pv).toBeDefined();
    expect(pv.labels[DEV_ENV_LABELS.instance]).toBe(handle.key.instanceId);
    expect(pv.spec).toMatchObject({
      storageClassName: DEV_TREE_STORAGE_CLASS,
      // Retain, never Delete: no reclaimer may act on somebody's working tree.
      persistentVolumeReclaimPolicy: 'Retain',
      claimRef: { namespace: handle.name, name: syncedDevTreePvcName(NANOCLAW_NAMESPACE) },
      local: { path: treeDir },
    });
    expect(JSON.stringify(pv.spec.nodeAffinity)).toContain('fake-node');
    expect(syncedDevTreePvcName(NANOCLAW_NAMESPACE)).toBe('dev-tree-x-nanoclaw-x-vc');

    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('provisioning'); // vcluster up ≠ nanoclaw up, dev included

    const docs = fake
      .childOf(handle.name)!
      .applied[0].split('\n---\n')
      .map((d) => JSON.parse(d));
    const pvc = docs.find((d) => d.kind === 'PersistentVolumeClaim')!;
    expect(pvc.metadata.name).toBe(DEV_TREE_PVC);
    const podSpec = docs.find((d) => d.kind === 'Deployment')!.spec.template.spec;
    const stat = fs.statSync(treeDir);
    // The host runs as the tree owner, stat'd off the resolved path.
    expect(podSpec.securityContext).toEqual({ runAsUser: stat.uid, runAsGroup: stat.gid });
    expect(podSpec.containers[0].image).toBe(NANOCLAW_CHILD_HOST_DEV_IMAGE);

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('release deletes the PV explicitly — the namespace delete cannot take a cluster-scoped object along', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = devDriver();
    const handle = await driver.claim(devSpec(freshKey()));
    await handle.status();
    expect(fake.pvs.has(devTreePvName(handle.name))).toBe(true);

    await handle.release('test');

    expect(fake.namespaces.has(handle.name)).toBe(false);
    expect(fake.pvs.has(devTreePvName(handle.name))).toBe(false);
    expect(fake.pvLog).toContain(`delete ${devTreePvName(handle.name)}`);
  });

  it('terminal death deletes the PV', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = devDriver();
    const handle = await driver.claim(devSpec(freshKey()));
    await handle.status();

    const died = new Promise<void>((resolve) => handle.onTerminal(() => resolve()));
    fake.crash(handle.name);
    await died;

    expect(fake.pvs.has(devTreePvName(handle.name))).toBe(false);
  });

  it('the residue reap collects a failed dev instance and its PV; the orphan sweep collects a PV with no instance — sparing live ones', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = devDriver();
    const dead = await driver.claim(devSpec(freshKey()));
    // A second tree: one RW tree carries at most one live child (the shared-tree guard).
    const secondTree = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tree-second-'));
    try {
      const live = await driver.claim(devSpec(freshKey(), secondTree));
      await live.status();

      fake.namespaces.get(dead.name)!.annotations['nanoclaw-dev/state'] = 'failed';
      // A PV whose namespace was torn down externally — nothing live accounts
      // for it, and its name would regain meaning under a reused namespace.
      fake.pvs.set('nanoclaw-dev-tree-nanoclaw-dev-feedface', {
        name: 'nanoclaw-dev-tree-nanoclaw-dev-feedface',
        labels: { [DEV_ENV_LABELS.install]: INSTALL, [DEV_ENV_LABELS.instance]: 'ins-gone' },
        spec: {},
      });

      await driver.reapResidue(INSTALL);

      expect(fake.pvs.has(devTreePvName(dead.name))).toBe(false);
      expect(fake.pvs.has('nanoclaw-dev-tree-nanoclaw-dev-feedface')).toBe(false);
      expect(fake.pvs.has(devTreePvName(live.name))).toBe(true);
    } finally {
      fs.rmSync(secondTree, { recursive: true, force: true });
    }
  });

  it('a dev claim whose route cannot open leaves no PV behind — atomicity covers the PV', async () => {
    const driver = devDriver();
    const key = freshKey();
    // The claimant namespace does not exist: the route create fails after the
    // namespace and PV landed, and the unwind must take both.
    const spec: DriverClaimSpec = {
      ...devSpec(key),
      claimantNamespace: 'agents',
      claimantSelector: { 'nanoclaw-group': 'g1' },
    };
    await expect(driver.claim(spec)).rejects.toBeDefined();
    expect(fake.namespaces.size).toBe(0);
    expect(fake.pvs.size).toBe(0);
  });

  it('refuses a relative path, a missing tree, and a stamp with no dev flavor — at claim, never as a boot timeout', async () => {
    const driver = devDriver();
    await expect(driver.claim(devSpec(freshKey(), 'relative/tree'))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
    });
    await expect(driver.claim(devSpec(freshKey(), path.join(treeDir, 'gone')))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
    });
    // sample-app carries no childManifests: there is nothing a dev tree could substitute.
    const plain = makeDriver();
    await expect(plain.claim(claimSpec(freshKey(), { [DEV_TREE_OPTION]: treeDir }))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
    });
    expect(fake.namespaces.size).toBe(0);
    expect(fake.pvs.size).toBe(0);
  });

  it('a tree that vanishes mid-boot is a deterministic rejection, not a polled-out budget', async () => {
    const driver = devDriver({ bootTimeoutMs: 60_000 });
    const doomed = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tree-doomed-'));
    const handle = await driver.claim(devSpec(freshKey(), doomed));
    fs.rmSync(doomed, { recursive: true, force: true });

    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await expect(failure).resolves.toMatchObject({ kind: 'instantiation-failed' });
  });

  it('one RW tree, one child: a second live claim over the same tree is refused, naming the holder', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = devDriver();
    const holder = await driver.claim(devSpec(freshKey()));
    await holder.status();

    // A DIFFERENT instance naming the same tree: refused at claim — two
    // children would both write data/ (SQLite) and groups/ into one path.
    await expect(driver.claim(devSpec(freshKey()))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining(holder.key.instanceId),
    });
    // The refusal left nothing behind and touched nothing of the holder's.
    expect(fake.namespaces.size).toBe(1);
    expect(fake.pvs.has(devTreePvName(holder.name))).toBe(true);

    // The HOLDER's own replay is never a conflict — that is how claims heal.
    const replayed = await driver.claim(devSpec(holder.key));
    expect(replayed.name).toBe(holder.name);

    // Released tree = claimable tree.
    await holder.release('test');
    await expect(driver.claim(devSpec(freshKey()))).resolves.toBeDefined();
  });

  it('a leaked PV whose holder is gone does not block the tree — the guard attributes liveness like the sweep', async () => {
    // A delete path that blipped: the PV names our tree but no live namespace
    // accounts for its instance. The claim proceeds (the orphan sweep owns
    // the corpse); refusing here would wedge the tree until a reap ran.
    fake.pvs.set('nanoclaw-dev-tree-nanoclaw-dev-0ddba11', {
      name: 'nanoclaw-dev-tree-nanoclaw-dev-0ddba11',
      labels: { [DEV_ENV_LABELS.install]: INSTALL, [DEV_ENV_LABELS.instance]: 'ins-gone' },
      spec: { local: { path: treeDir } },
    });
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = devDriver();
    await expect(driver.claim(devSpec(freshKey()))).resolves.toBeDefined();
  });

  it('an adopted dev instance re-learns its tree from the runtime and still probes the DEV bundle', async () => {
    const driver = devDriver();
    const key = freshKey();
    const original = await driver.claim(devSpec(key));
    fake.completeBoot(original.name);
    fake.severWatches();

    // Host restart: a fresh driver over the same runtime rediscovers the
    // instance from labels + annotations alone.
    const restarted = devDriver();
    const [adopted] = await restarted.listInstances(INSTALL);
    expect(adopted.key.instanceId).toBe(key.instanceId);
    expect((await adopted.status()).phase).toBe('provisioning');
    // The stamp probe under the ADOPTED handle applied the dev bundle, not the baked one.
    const applied = fake.childOf(adopted.name)!.applied.join('\n');
    expect(applied).toContain(DEV_TREE_PVC);
    expect(applied).toContain(NANOCLAW_CHILD_HOST_DEV_IMAGE);

    fake.completeChildRollout(adopted.name);
    expect((await adopted.status()).phase).toBe('ready');
  });

  it('a re-adopted dev claim is still fidelity-gated: wrong flavor after the restart is a loud failure, not an active lie', async () => {
    vi.useFakeTimers();
    // The wrong-flavor shape, hit AFTER a mid-claim restart: the fresh
    // driver's caches are empty, so the gate must re-learn the flavor from
    // the runtime annotation (the PR #209 posture) — a re-adopted dev claim
    // may never skip devFlavorRealized on its way to ready.
    fake.syncerDropsPvcs = true;
    const driver = devDriver();
    const key = freshKey();
    await driver.claim(devSpec(key));
    fake.severWatches();

    const restarted = devDriver();
    await restarted.resumeClaim(devSpec(key));
    const [adopted] = await restarted.listInstances(INSTALL);
    const failure = new Promise<unknown>((resolve) => adopted.onTerminal((f) => resolve(f)));
    fake.completeBoot(adopted.name);
    await vi.advanceTimersByTimeAsync(2_500); // the poll applies the dev stamp
    fake.completeChildRollout(adopted.name);
    await vi.advanceTimersByTimeAsync(2_500); // gate green → the fidelity gate trips
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('not the dev flavor'),
    });
    expect((await adopted.status()).phase).toBe('failed');
  });

  it('child-API weather during boot costs the credential, never the flavor (the 08-22 silent bake)', async () => {
    const driver = devDriver();
    const handle = await driver.claim(devSpec(freshKey()));
    // The live shape (13:52:26, nanoclaw-dev-09df6c19): the just-born child
    // apiserver refuses its first connection. One blip; the weather clears.
    fake.failNextChildCallWith(
      'The connection to the server 10.43.140.136:443 was refused - did you specify the right host or port?',
    );
    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('provisioning');
    // The next probe re-mints access and applies the stamp — which must still
    // be the DEV bundle: the blip must not have evicted the tree memory.
    expect((await handle.status()).phase).toBe('provisioning');
    const applied = fake.childOf(handle.name)!.applied.join('\n');
    expect(applied).toContain(DEV_TREE_PVC);
    expect(applied).toContain(NANOCLAW_CHILD_HOST_DEV_IMAGE);
    // JSON-quoted: "nanoclaw-tree" must be absent as a NAME (it is a prefix of
    // nothing in the dev render), and so must the baked image.
    expect(applied).not.toContain('"nanoclaw-tree"');
    expect(applied).not.toContain(NANOCLAW_CHILD_HOST_IMAGE);

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('a provisioned volume winning the pre-bind is a deterministic boot failure — never an empty tree reported active', async () => {
    vi.useFakeTimers();
    // The §3.8 STOP condition: admission/provisioner interference binds the
    // synced claim to a fresh empty volume instead of the pre-bound PV.
    fake.provisionerWinsBinds = true;
    const driver = devDriver();
    const handle = await driver.claim(devSpec(freshKey()));
    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(2_500); // the poll applies the dev stamp
    fake.completeChildRollout(handle.name);
    await vi.advanceTimersByTimeAsync(2_500); // gate green → the fidelity gate trips
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('pre-bound PV'),
    });
    expect((await handle.status()).phase).toBe('failed');
  });

  it('a readiness gate green without the dev-tree PVC is a named refusal — the realized child is not the claimed flavor', async () => {
    vi.useFakeTimers();
    // A green gate proves A child is up, not WHICH: whatever applied a bundle
    // with no dev PVC behind it must never be reported as the dev flavor.
    fake.syncerDropsPvcs = true;
    const driver = devDriver();
    const handle = await driver.claim(devSpec(freshKey()));
    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(2_500);
    fake.completeChildRollout(handle.name);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('not the dev flavor'),
    });
    expect((await handle.status()).phase).toBe('failed');
  });
});

describe('the hot loop for any stamp (C16)', () => {
  let treeDir: string;

  beforeEach(() => {
    treeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'any-stamp-tree-'));
  });

  afterEach(() => {
    fs.rmSync(treeDir, { recursive: true, force: true });
  });

  /** An app-shape stamp that opted in: mount + overrides declared, identity driver-rendered. */
  const APP_DEV: K8sStampConfig = {
    app: { image: 'backlot:base', presence: 'node-local', port: 4100, env: { MODE: 'baked' } },
    dev: {
      mountPath: '/backlot/app',
      image: 'backlot:dev',
      command: ['bun', '--watch', 'serve.ts'],
      env: { MODE: 'dev' },
      reload: { kind: 'none' },
    },
  };

  /** A registered-shape dev stream's workload: tokens + mount where `mounts`, baked shape otherwise. */
  function devDeploymentDoc(name: string, namespace: string, mounts: boolean): string {
    return JSON.stringify(
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, namespace },
        spec: {
          template: {
            spec: {
              ...(mounts
                ? {
                    securityContext: { runAsUser: '${DEV_TREE_UID}', runAsGroup: '${DEV_TREE_GID}' },
                    volumes: [{ name: 'dev-tree', persistentVolumeClaim: { claimName: 'dev-tree' } }],
                  }
                : {}),
              containers: [{ name: 'app', image: 'svc:dev' }],
            },
          },
        },
      },
      null,
      2,
    );
  }

  /** A childManifests stamp that opted in — consumer `svc/svc-api`, dev stream author-supplied. */
  const CHILD_DEV: K8sStampConfig = {
    childManifests: devDeploymentDoc('svc-api', 'svc', false),
    readiness: { deployment: 'svc-api', namespace: 'svc' },
    dev: { manifests: devDeploymentDoc('svc-api', 'svc', true) },
  };

  /** The C12 snapshot semantics, minimal: reads answer from the last refresh. */
  class DevStubSource implements StampSource {
    entries: Record<string, K8sStampConfig> = {};
    #snapshot: Record<string, K8sStampConfig> = {};
    async refresh(): Promise<void> {
      this.#snapshot = { ...this.entries };
    }
    getStamp(id: string): K8sStampConfig | undefined {
      return this.#snapshot[id];
    }
    stampVersion(id: string): number | undefined {
      return this.#snapshot[id] ? 1 : undefined;
    }
    poolSizes(): Record<string, number> {
      return {};
    }
  }

  function devSpecFor(key: EnvKey, stampId: string, tree: string = treeDir): DriverClaimSpec {
    return { key, stampId, labels: devEnvLabels(INSTALL, key, stampId), options: { [DEV_TREE_OPTION]: tree } };
  }

  it('an app-shape dev claim realizes the driver-rendered variant: mount, overrides, identity clamp, platform claim', async () => {
    const driver = makeDriver({ stamps: { backlot: APP_DEV } });
    const handle = await driver.claim(devSpecFor(freshKey(), 'backlot'));

    // The pre-bind is the pure formula over the app shape's consumer namespace.
    const pv = fake.pvs.get(devTreePvName(handle.name))!;
    expect(pv.spec).toMatchObject({
      storageClassName: DEV_TREE_STORAGE_CLASS,
      claimRef: { namespace: handle.name, name: 'dev-tree-x-default-x-vc' },
      local: { path: treeDir },
    });

    fake.completeBoot(handle.name);
    expect((await handle.status()).phase).toBe('provisioning'); // vcluster up ≠ the app up, dev included
    const docs = fake
      .childOf(handle.name)!
      .applied[0].split('\n---\n')
      .map((d) => JSON.parse(d));
    const deployment = docs.find((d) => d.kind === 'Deployment')!;
    expect(deployment.metadata.name).toBe('backlot'); // readiness stays the stamp's own gate
    const podSpec = deployment.spec.template.spec;
    const stat = fs.statSync(treeDir);
    // The identity clamp, app-shape half: DRIVER-rendered off the stat'd tree
    // owner, fsGroup absent — never the author's to write.
    expect(podSpec.securityContext).toEqual({ runAsUser: stat.uid, runAsGroup: stat.gid });
    expect(podSpec.volumes).toContainEqual({ name: DEV_TREE_PVC, persistentVolumeClaim: { claimName: DEV_TREE_PVC } });
    const container = podSpec.containers[0];
    expect(container.image).toBe('backlot:dev');
    expect(container.command).toEqual(['bun', '--watch', 'serve.ts']);
    expect(container.env).toContainEqual({ name: 'MODE', value: 'dev' });
    expect(container.volumeMounts).toContainEqual({ name: DEV_TREE_PVC, mountPath: '/backlot/app' });
    // The platform authored the tree claim into the consumer namespace,
    // wearing the reserved class — never the author's stream.
    const pvc = docs.find((d) => d.kind === 'PersistentVolumeClaim')!;
    expect(pvc.metadata).toEqual({ name: DEV_TREE_PVC, namespace: 'default' });
    expect(pvc.spec.storageClassName).toBe(DEV_TREE_STORAGE_CLASS);

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('a childManifests dev stream substitutes the identity tokens and rides the consumer-namespace formula', async () => {
    const driver = makeDriver({ stamps: { svc: CHILD_DEV } });
    const handle = await driver.claim(devSpecFor(freshKey(), 'svc'));
    expect(fake.pvs.get(devTreePvName(handle.name))!.spec).toMatchObject({
      claimRef: { namespace: handle.name, name: 'dev-tree-x-svc-x-vc' },
    });

    fake.completeBoot(handle.name);
    await handle.status();
    const applied = fake.childOf(handle.name)!.applied.join('\n');
    const stat = fs.statSync(treeDir);
    // Stat-derived integers, nothing else — and nothing unsubstituted.
    expect(applied).toContain(`"runAsUser": ${stat.uid}`);
    expect(applied).toContain(`"runAsGroup": ${stat.gid}`);
    expect(applied).not.toContain('DEV_TREE_UID');
    // The platform claim landed beside the author's documents.
    expect(applied).toContain(`"${DEV_TREE_STORAGE_CLASS}"`);

    fake.completeChildRollout(handle.name);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('a dev claim against a stamp with no dev block refuses at claim, naming the missing declaration', async () => {
    const driver = makeDriver(); // bare sample-app — no dev block
    await expect(driver.claim(claimSpec(freshKey(), { [DEV_TREE_OPTION]: treeDir }))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('declares no dev block'),
    });
    expect(fake.namespaces.size).toBe(0);
    expect(fake.pvs.size).toBe(0);
  });

  it('a dev claim of a MULTI-GATE stamp waits for every leg, not just the one it hot-reloads', async () => {
    vi.useFakeTimers();
    // The hazard `dev.consumer` opened, closed. The dev variant REPLACES
    // childManifests, and it would have been natural to gate the realized
    // config on the consumer alone — which would mean a whole-deployment stamp
    // goes READY in its dev flavor with its governance and its gateway down.
    // A dev variant realizes the same deployment; it waits for the same legs.
    const gates = [
      { deployment: 'svc-api', namespace: 'svc' },
      { deployment: 'svc-gateway', namespace: 'svc' },
    ];
    const stream = [devDeploymentDoc('svc-api', 'svc', false), devDeploymentDoc('svc-gateway', 'svc', false)].join(
      '\n---\n',
    );
    const config: K8sStampConfig = {
      childManifests: stream,
      readiness: gates,
      dev: {
        manifests: [devDeploymentDoc('svc-api', 'svc', true), devDeploymentDoc('svc-gateway', 'svc', false)].join(
          '\n---\n',
        ),
        consumer: gates[0],
      },
    };
    const driver = makeDriver({ stamps: { multi: config } });
    const handle = await driver.claim(devSpecFor(freshKey(), 'multi'));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(10);

    const child = fake.childOf(handle.name)!;
    child.deployments.get('svc/svc-api')!.ready = true;
    expect((await handle.status()).phase).toBe('provisioning'); // the consumer alone is not the deployment

    child.deployments.get('svc/svc-gateway')!.ready = true;
    expect((await handle.status()).phase).toBe('ready');
    driver.dispose();
  });

  it('refuses a dev stream that drops a gated leg — the dev flavor would wait out its boot budget on it', () => {
    // The other half of the same hazard: keeping every gate is only safe if a
    // dev stream is REQUIRED to create every gated Deployment. Otherwise the
    // fix trades silent under-gating for a generic boot timeout whose real
    // cause is visible only by diffing two manifest streams.
    const gates = [
      { deployment: 'svc-api', namespace: 'svc' },
      { deployment: 'svc-gateway', namespace: 'svc' },
    ];
    expect(() =>
      validateStampEntry('dropped', {
        childManifests: [devDeploymentDoc('svc-api', 'svc', false), devDeploymentDoc('svc-gateway', 'svc', false)].join(
          '\n---\n',
        ),
        readiness: gates,
        // The dev stream forgets svc-gateway entirely.
        dev: { manifests: devDeploymentDoc('svc-api', 'svc', true), consumer: gates[0] },
      }),
    ).toThrow(/never creates svc\/svc-gateway/);
  });

  it('a dev stream whose CONSUMER never mounts the tree dies at the gate, named — variant evidence reads the consumer', async () => {
    vi.useFakeTimers();
    // The authorable mistake registration cannot catch: SOME template mounts
    // the tree (the create-time refusal passes), but not the consuming one —
    // the gate is the runtime backstop, and it must name the consumer.
    const config: K8sStampConfig = {
      childManifests: devDeploymentDoc('svc-api', 'svc', false),
      readiness: { deployment: 'svc-api', namespace: 'svc' },
      dev: {
        manifests: [devDeploymentDoc('svc-api', 'svc', false), devDeploymentDoc('svc-watcher', 'svc', true)].join(
          '\n---\n',
        ),
      },
    };
    const driver = makeDriver({ stamps: { svc: config } });
    const handle = await driver.claim(devSpecFor(freshKey(), 'svc'));
    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(2_500); // the poll applies the dev stream
    fake.completeChildRollout(handle.name);
    await vi.advanceTimersByTimeAsync(2_500); // gate green → variant evidence trips
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('does not mount'),
    });
    expect((await handle.status()).phase).toBe('failed');
  });

  it('the #209 violations hold for any opted-in stamp: a forced provisioner bind is a loud deterministic failure', async () => {
    vi.useFakeTimers();
    fake.provisionerWinsBinds = true;
    const driver = makeDriver({ stamps: { backlot: APP_DEV } });
    const handle = await driver.claim(devSpecFor(freshKey(), 'backlot'));
    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(2_500);
    fake.completeChildRollout(handle.name);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('pre-bound PV'),
    });
  });

  it('a mid-boot dev-block drop is a recorded mismatch — never bare-ready, never a baked child under a dev env id', async () => {
    vi.useFakeTimers();
    const src = new DevStubSource();
    src.entries.svc = CHILD_DEV;
    await src.refresh();
    const driver = makeDriver({ stampSource: src });
    const handle = await driver.claim(devSpecFor(freshKey(), 'svc'));

    // The update drops the block; a reconcile edge refreshes the snapshot.
    src.entries.svc = { childManifests: CHILD_DEV.childManifests, readiness: CHILD_DEV.readiness };
    await src.refresh();

    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('no longer declares a dev block'),
    });
    expect((await handle.status()).phase).toBe('failed');
  });

  it('a retirement mid-boot under a dev claim is the same loud mismatch — a missing config must not read bare-ready', async () => {
    vi.useFakeTimers();
    const src = new DevStubSource();
    src.entries.svc = CHILD_DEV;
    await src.refresh();
    const driver = makeDriver({ stampSource: src });
    const handle = await driver.claim(devSpecFor(freshKey(), 'svc'));

    delete src.entries.svc;
    await src.refresh();

    const failure = new Promise<unknown>((resolve) => handle.onTerminal((f) => resolve(f)));
    fake.completeBoot(handle.name);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('no longer declares a dev block'),
    });
  });

  it('re-adoption of a generalized dev claim (post-#215): resume heals, the adopted handle realizes the DEV variant', async () => {
    const src = new DevStubSource();
    src.entries.svc = CHILD_DEV;
    await src.refresh();
    const driver = makeDriver({ stampSource: src });
    const key = freshKey();
    const original = await driver.claim(devSpecFor(key, 'svc'));
    fake.completeBoot(original.name);
    fake.severWatches();

    // Host restart: a fresh driver over the same runtime, resume then adopt.
    const src2 = new DevStubSource();
    src2.entries.svc = CHILD_DEV;
    await src2.refresh();
    const restarted = makeDriver({ stampSource: src2 });
    await restarted.resumeClaim(devSpecFor(key, 'svc'));
    const [adopted] = await restarted.listInstances(INSTALL);
    expect(adopted.key.instanceId).toBe(key.instanceId);
    expect((await adopted.status()).phase).toBe('provisioning');
    // The stamp probe under the ADOPTED handle applied the DEV variant,
    // re-learned from the runtime annotation — never the baked stream.
    const applied = fake.childOf(adopted.name)!.applied.join('\n');
    const stat = fs.statSync(treeDir);
    expect(applied).toContain(`"runAsUser": ${stat.uid}`);
    expect(applied).not.toContain('DEV_TREE_UID');

    fake.completeChildRollout(adopted.name);
    expect((await adopted.status()).phase).toBe('ready');
  });

  it('a re-adopted generalized dev claim is still fidelity-gated — the #209 posture holds for any stamp', async () => {
    vi.useFakeTimers();
    fake.syncerDropsPvcs = true;
    const src = new DevStubSource();
    src.entries.svc = CHILD_DEV;
    await src.refresh();
    const driver = makeDriver({ stampSource: src });
    const key = freshKey();
    await driver.claim(devSpecFor(key, 'svc'));
    fake.severWatches();

    const src2 = new DevStubSource();
    src2.entries.svc = CHILD_DEV;
    await src2.refresh();
    const restarted = makeDriver({ stampSource: src2 });
    await restarted.resumeClaim(devSpecFor(key, 'svc'));
    const [adopted] = await restarted.listInstances(INSTALL);
    const failure = new Promise<unknown>((resolve) => adopted.onTerminal((f) => resolve(f)));
    fake.completeBoot(adopted.name);
    await vi.advanceTimersByTimeAsync(2_500);
    fake.completeChildRollout(adopted.name);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(failure).resolves.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('not the dev flavor'),
    });
    expect((await adopted.status()).phase).toBe('failed');
  });

  it('one RW tree, one child — ACROSS stamps: a live dev claim blocks any other stamp over the same tree', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = makeDriver({ stamps: { ...BUILTIN_STAMPS, backlot: APP_DEV } });
    const nanoKey = freshKey();
    const holder = await driver.claim({
      key: nanoKey,
      stampId: 'nanoclaw',
      labels: devEnvLabels(INSTALL, nanoKey, 'nanoclaw'),
      options: { [DEV_TREE_OPTION]: treeDir },
    });
    await holder.status();

    // Two children of ANY parentage over one tree would both write into it —
    // the guard was already stamp-blind (PV path equality); this pins it.
    await expect(driver.claim(devSpecFor(freshKey(), 'backlot'))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining(holder.key.instanceId),
    });
  });

  describe('the dev declaration refusals — earned at the write, in front of the approver', () => {
    const consumerDoc = devDeploymentDoc('svc-api', 'svc', false);
    const mountingDoc = devDeploymentDoc('svc-api', 'svc', true);
    const childShape = { childManifests: consumerDoc, readiness: { deployment: 'svc-api', namespace: 'svc' } };

    it('refuses a dev block with no consumer, and one with two', () => {
      expect(() => validateStampEntry('bare', { dev: { mountPath: '/x' } })).toThrow(/no consumer/);
      expect(() =>
        validateStampEntry('both', {
          ...childShape,
          app: { image: 'x:1', presence: 'node-local', port: 1 },
          dev: { mountPath: '/x' },
        }),
      ).toThrow(/names two/);
    });

    it('refuses shape mismatches and a non-absolute mountPath', () => {
      expect(() =>
        validateStampEntry('app-manifests', {
          app: { image: 'x:1', presence: 'node-local', port: 1 },
          dev: { manifests: mountingDoc },
        }),
      ).toThrow(/dev\.manifests belongs to childManifests/);
      expect(() =>
        validateStampEntry('app-rel', {
          app: { image: 'x:1', presence: 'node-local', port: 1 },
          dev: { mountPath: 'relative/path' },
        }),
      ).toThrow(/absolute path/);
      expect(() => validateStampEntry('child-mount', { ...childShape, dev: { mountPath: '/x' } })).toThrow(
        /dev variant stream/,
      );
    });

    it('refuses an unknown reload kind, and exec without a command', () => {
      expect(() =>
        validateStampEntry('reload', {
          ...childShape,
          dev: { manifests: mountingDoc, reload: { kind: 'bogus' } as never },
        }),
      ).toThrow(/rollout \| exec \| none/);
      expect(() =>
        validateStampEntry('exec', {
          ...childShape,
          dev: { manifests: mountingDoc, reload: { kind: 'exec', command: [] } },
        }),
      ).toThrow(/non-empty command array/);
    });

    it('the identity clamp: tokens verbatim, no fsGroup, no container-level override — and a checkable stream', () => {
      // Not JSON-parseable: the clamp cannot be waved through on faith.
      expect(() =>
        validateStampEntry('yaml', { ...childShape, dev: { manifests: 'kind: Deployment\nmetadata: {}' } }),
      ).toThrow(/mechanically checkable/);
      // Mounts without the tokens.
      const noTokens = JSON.parse(mountingDoc);
      delete noTokens.spec.template.spec.securityContext;
      expect(() =>
        validateStampEntry('tokens', { ...childShape, dev: { manifests: JSON.stringify(noTokens) } }),
      ).toThrow(/identity tokens/);
      // fsGroup would recursively chgrp the developer's tree at mount.
      const withFsGroup = JSON.parse(mountingDoc);
      withFsGroup.spec.template.spec.securityContext.fsGroup = 1000;
      expect(() =>
        validateStampEntry('fsgroup', { ...childShape, dev: { manifests: JSON.stringify(withFsGroup) } }),
      ).toThrow(/fsGroup/);
      // A container-level runAsUser out-votes the pod's tokens.
      const override = JSON.parse(mountingDoc);
      override.spec.template.spec.containers[0].securityContext = { runAsUser: 0 };
      expect(() =>
        validateStampEntry('override', { ...childShape, dev: { manifests: JSON.stringify(override) } }),
      ).toThrow(/out-votes/);
    });

    it('refuses a dev stream with no template mounting the tree — a tree that could never be live', () => {
      expect(() => validateStampEntry('no-mount', { ...childShape, dev: { manifests: consumerDoc } })).toThrow(
        /could never be live/,
      );
    });

    it('platform authorship is a create-time refusal: no stream may declare the dev-tree PVC or the reserved class', () => {
      const ownPvc = JSON.stringify({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: 'dev-tree', namespace: 'svc' },
        spec: { accessModes: ['ReadWriteOnce'] },
      });
      expect(() =>
        validateStampEntry('own-pvc', {
          ...childShape,
          dev: { manifests: [mountingDoc, ownPvc].join('\n---\n') },
        }),
      ).toThrow(/platform authors that claim/);
      // The baked stream earns the same refusals — precise on JSON…
      expect(() =>
        validateStampEntry('baked-class', {
          childManifests: JSON.stringify({ kind: 'ConfigMap', data: { class: DEV_TREE_STORAGE_CLASS } }),
          readiness: { deployment: 'svc-api', namespace: 'svc' },
        }),
      ).toThrow(/reserved storage class/);
      // …and conservatively textual on a YAML stream it cannot parse.
      expect(() =>
        validateStampEntry('yaml-class', {
          childManifests: `kind: PersistentVolumeClaim\nspec:\n  storageClassName: ${DEV_TREE_STORAGE_CLASS}`,
          readiness: { deployment: 'svc-api', namespace: 'svc' },
        }),
      ).toThrow(/reserved storage class/);
    });

    it('the builtin nanoclaw declaration passes its own clamp — first consumer of the seam it proved', () => {
      expect(() => validateStampEntry('nanoclaw', BUILTIN_STAMPS.nanoclaw, { codeProvided: true })).not.toThrow();
      expect(BUILTIN_STAMPS.nanoclaw.dev).toMatchObject({ reload: { kind: 'rollout' } });
    });
  });
});

describe('the stamps registry source (C12)', () => {
  /** A snapshot-faithful stub: `entries` is the store; reads answer from the last refresh. */
  class StubStampSource implements StampSource {
    entries: Record<string, { config: K8sStampConfig; version?: number; pool?: number }> = {};
    retired = new Set<string>();
    /** C15: what placedImage answers — the placement ledger's snapshot leg. */
    placed: Record<string, { digest: string; version: number }> = {};
    refreshes = 0;
    #snapshot: StubStampSource['entries'] = {};
    #retiredSnapshot = new Set<string>();
    async refresh(): Promise<void> {
      this.refreshes += 1;
      this.#snapshot = { ...this.entries };
      this.#retiredSnapshot = new Set(this.retired);
    }
    getStamp(id: string): K8sStampConfig | undefined {
      return this.#snapshot[id]?.config;
    }
    stampVersion(id: string): number | undefined {
      return this.#snapshot[id] ? (this.#snapshot[id].version ?? 1) : undefined;
    }
    poolSizes(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [id, e] of Object.entries(this.#snapshot)) if (e.pool) out[id] = e.pool;
      return out;
    }
    retiredStamp(id: string): boolean {
      return this.#retiredSnapshot.has(id);
    }
    placedImage(id: string): { digest: string; version: number } | null {
      return this.placed[id] ?? null;
    }
  }

  const regSpec = (key: EnvKey, stampId: string): DriverClaimSpec => ({
    key,
    stampId,
    labels: devEnvLabels(INSTALL, key, stampId),
    options: {},
  });

  it('a registered stamp is claimable — the cold snapshot refreshes on the claim edge', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const src = new StubStampSource();
    src.entries['reg-app'] = { config: { app: { image: 'example.invalid/reg:1', presence: 'node-local', port: 9000 } } };
    const driver = makeDriver({ stampSource: src });

    // Never refreshed: the snapshot is cold, and the claim edge must warm it
    // rather than refuse a stamp the store already holds.
    const handle = await driver.claim(regSpec(freshKey(), 'reg-app'));
    expect(src.refreshes).toBeGreaterThan(0);
    expect((await handle.status()).phase).toBe('ready');
    const applied = fake.childOf(handle.name)!.applied.join('\n');
    expect(applied).toContain('"reg-app"');
    expect(applied).toContain('example.invalid/reg:1');
  });

  it('a PLACED pull-origin stamp renders the derived non-resolvable ref pinned to the placed digest (C15)', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const digest = `sha256:${'d'.repeat(64)}`;
    const src = new StubStampSource();
    src.entries['pulled-app'] = {
      config: { app: { image: `registry.example.invalid/org/app:1@${digest}`, port: 9000 } },
    };
    src.placed['pulled-app'] = { digest, version: 1 };
    const driver = makeDriver({ stampSource: src });

    const handle = await driver.claim({ ...regSpec(freshKey(), 'pulled-app') });
    expect((await handle.status()).phase).toBe('ready');
    const applied = fake.childOf(handle.name)!.applied.join('\n');
    // The exact bits placement recorded, under a name no resolver answers
    // for — a claim never pulls, mechanically.
    expect(applied).toContain(`place.nanoclaw.invalid/stamp/pulled-app:v1@${digest}`);
    expect(applied).not.toContain('registry.example.invalid');
  });

  it('an UNPLACED pull-origin stamp records a deterministic rejection — never a silent boot toward a timeout', async () => {
    fake.manualCompletion = false;
    const digest = `sha256:${'d'.repeat(64)}`;
    const src = new StubStampSource();
    src.entries['pulled-app'] = {
      config: { app: { image: `registry.example.invalid/org/app:1@${digest}`, port: 9000 } },
    };
    const driver = makeDriver({ stampSource: src });

    const handle = await driver.claim({ ...regSpec(freshKey(), 'pulled-app') });
    // The gate above the seam refuses these before a claim exists; a driver
    // reached anyway must record WHY the boot can never converge, so the
    // boot paths fail it now instead of polling out the budget.
    expect(driver.stampRejection(handle.name)).toContain('not placed');
    expect((await handle.status()).phase).toBe('provisioning');
    // Nothing of the source registry was ever applied into the child.
    expect(fake.childOf(handle.name)?.applied.join('\n') ?? '').not.toContain('registry.example.invalid');
  });

  it('an unknown stamp still refuses, after giving the registry one refresh', async () => {
    const src = new StubStampSource();
    const driver = makeDriver({ stampSource: src });
    await expect(driver.claim(regSpec(freshKey(), 'nope'))).rejects.toMatchObject({ kind: 'stamp-unknown' });
    expect(src.refreshes).toBeGreaterThan(0);
  });

  it("a RETIRED stamp's refusal says so — a claim that raced a retirement is not a typo (ISSUES #21)", async () => {
    const src = new StubStampSource();
    src.retired.add('was-here');
    const driver = makeDriver({ stampSource: src });
    await expect(driver.claim(regSpec(freshKey(), 'was-here'))).rejects.toMatchObject({
      kind: 'stamp-unknown',
      detail: expect.stringContaining('retired'),
    });
  });

  it('the static table wins an id collision — code-provided definitions never drift behind a row', async () => {
    fake.manualCompletion = false;
    const src = new StubStampSource();
    // A row wearing a static id, with an app the static definition does not have.
    src.entries['sample-app'] = { config: { app: { image: 'example.invalid/impostor:1', presence: 'node-local', port: 1 } } };
    await src.refresh();
    const driver = makeDriver({ stampSource: src }); // static 'sample-app' is a bare vcluster
    const handle = await driver.claim(regSpec(freshKey(), 'sample-app'));
    expect((await handle.status()).phase).toBe('ready');
    // The bare-vcluster semantics held: nothing ever spoke to a child cluster.
    expect(fake.calls.some((c) => c.args.some((a) => a.startsWith('--kubeconfig=')))).toBe(false);
  });

  it('the pool observation follows the fill and the drain — what set-pool had no read surface for (#21)', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const src = new StubStampSource();
    src.entries['reg-app'] = { config: { app: { image: 'example.invalid/reg:1', presence: 'node-local', port: 9000 } }, pool: 1 };
    await src.refresh(); // the CLI mutation's own refresh — set-pool has landed
    const driver = makeDriver({ stampSource: src });
    await driver.ensureReady();

    // Asked for one, holding none YET: zeros, because the target is known.
    // The blind minute this answers is where the probe-claim was invented.
    expect(driver.observePools()).toEqual({ 'reg-app': { warm: 0, filling: 0, draining: 0, failed: 0 } });
    await vi.advanceTimersByTimeAsync(10); // the fill boots and stamps the app
    expect(driver.observePools()).toEqual({ 'reg-app': { warm: 0, filling: 1, draining: 0, failed: 0 } });
    await vi.advanceTimersByTimeAsync(2_500); // the next poll sees it Available and flips warm
    expect(driver.observePools()).toEqual({ 'reg-app': { warm: 1, filling: 0, draining: 0, failed: 0 } });

    // The retire half: the row's size is gone from the snapshot the moment the
    // mutation refreshes, and the slot it leaves behind is on its way out —
    // a drain an author can watch, not a silent flip.
    src.entries['reg-app']!.pool = 0;
    await src.refresh();
    expect(driver.observePools()).toEqual({ 'reg-app': { warm: 0, filling: 0, draining: 1, failed: 0 } });

    await vi.advanceTimersByTimeAsync(60_000); // the interval reconcile reaps it
    driver.dispose();
    expect(warmSlots()).toHaveLength(0);
    expect(driver.observePools()).toEqual({});
  });

  it('a retire MID-FILL drains the slot instead of recording it failed (#21)', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = true; // the fill stalls: this IS the mid-boot window
    const src = new StubStampSource();
    src.entries['reg-app'] = {
      config: { app: { image: 'example.invalid/reg:1', presence: 'node-local', port: 9000 } },
      pool: 1,
    };
    await src.refresh();
    const driver = makeDriver({ stampSource: src });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    expect(driver.observePools()).toEqual({ 'reg-app': { warm: 0, filling: 1, draining: 0, failed: 0 } });

    // The retire lands while the slot is still booting. The fill then times
    // out (or errors) against a stamp the registry has already dropped, and
    // used to annotate the namespace `failed` — the reason-less row the
    // whoami acceptance hit, blaming the stamp for a mutation its author made
    // on purpose. A fill the pool stopped wanting was CUT SHORT, not broken.
    src.entries['reg-app']!.pool = 0;
    await src.refresh();
    await vi.advanceTimersByTimeAsync(2_500); // the fill's next poll
    driver.dispose();

    expect([...fake.namespaces.values()].filter((ns) => ns.annotations['nanoclaw-dev/state'] === 'failed')).toEqual([]);
    expect(driver.observePools()).toEqual({});
  });

  it('registry pool sizes fill through the reconciler, and a dropped size drains the slot', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const src = new StubStampSource();
    src.entries['reg-app'] = { config: { app: { image: 'example.invalid/reg:1', presence: 'node-local', port: 9000 } }, pool: 1 };
    const driver = makeDriver({ stampSource: src });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10); // the fill boots and stamps the app
    await vi.advanceTimersByTimeAsync(2_500); // the next poll sees it Available and flips warm
    driver.dispose();
    expect(warmSlots()).toHaveLength(1);

    // set-pool 0 lands in the store; the next reconcile (here: a restarted
    // driver's first) refreshes and reaps — no restart REQUIRED in production,
    // where the interval reconciler does the same.
    src.entries['reg-app']!.pool = 0;
    fake.severWatches();
    const driver2 = makeDriver({ stampSource: src });
    await driver2.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    driver2.dispose();
    expect(warmSlots()).toHaveLength(0);
  });

  it('a row at size 0 turns a STATIC pool off — an omitted size cannot shadow a boot-time number', async () => {
    fake.manualCompletion = false;
    const configured = makeDriver({ pools: { 'sample-app': 1 } }); // boot-time config, one warm slot
    await configured.ensureReady();
    await settle();
    configured.dispose();
    expect(warmSlots()).toHaveLength(1);

    // The registry knows this id and wants no slots. `poolSizes()` says that
    // by OMITTING the id, so a plain merge over the static table left the
    // boot-time 1 standing: the approved `set-pool 0` kept a warm slot alive
    // and refilled it forever, and no read could have explained why.
    const src = new StubStampSource();
    src.entries['sample-app'] = {
      config: { app: { image: 'example.invalid/reg:1', presence: 'node-local', port: 9000 } },
      pool: 0,
    };
    await src.refresh();
    const off = makeDriver({ pools: { 'sample-app': 1 }, stampSource: src });
    fake.severWatches();
    await off.ensureReady();
    await settle();
    const observed = off.observePools();
    off.dispose();

    expect(warmSlots()).toHaveLength(0);
    expect(observed).toEqual({});
  });

  it('an invalid registered config reads as unknown at claim — a bad row never crashes a probe path', async () => {
    const src = new StubStampSource();
    // childManifests with no readiness: refused by validation — a row that
    // predates a rule must degrade to "no such stamp", loudly.
    src.entries['bad'] = { config: { childManifests: '{}' } };
    await src.refresh();
    const driver = makeDriver({ stampSource: src });
    await expect(driver.claim(regSpec(freshKey(), 'bad'))).rejects.toMatchObject({ kind: 'stamp-unknown' });
  });

  /**
   * The hot-update loop: `stamps update` is how a fix reaches the next claim,
   * and before the version label a warm slot had no way to say which
   * definition built it — so the first claims after every fix ran the previous
   * artifact and were RECORDED as the new one. These four pin the fix from the
   * outside: what a slot carries, what drains, what is handed out, and what a
   * running child is spared.
   */
  const versionOf = (namespace: string): string | undefined =>
    fake.namespaces.get(namespace)!.labels['nanoclaw-dev-stamp-version'];

  const appAt = (tag: string): K8sStampConfig => ({
    app: { image: `example.invalid/reg:${tag}`, presence: 'node-local', port: 9000 },
  });

  it('a warm slot carries the version it was filled from, and a hot update drains it and refills', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const src = new StubStampSource();
    src.entries['reg-app'] = { config: appAt('v4'), pool: 1, version: 4 };
    const driver = makeDriver({ stampSource: src });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_500);
    driver.dispose();
    const [stale] = warmSlots();
    expect(versionOf(stale)).toBe('4');

    // The fix lands: a new approved definition under the same id.
    src.entries['reg-app'] = { config: appAt('v5'), pool: 1, version: 5 };
    fake.severWatches();
    const driver2 = makeDriver({ stampSource: src });
    await driver2.ensureReady();
    await vi.advanceTimersByTimeAsync(10); // reap the stale slot, start the replacement
    await vi.advanceTimersByTimeAsync(2_500); // it goes warm
    driver2.dispose();

    expect(fake.namespaces.has(stale)).toBe(false); // drained, not left counting as capacity
    const [fresh] = warmSlots();
    expect(fresh).not.toBe(stale);
    expect(versionOf(fresh)).toBe('5');
    expect(fake.childOf(fresh)!.applied.join('\n')).toContain('example.invalid/reg:v5');
  });

  it('a claim after an update never lands on the stale slot — the recorded version is true by construction', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const src = new StubStampSource();
    src.entries['reg-app'] = { config: appAt('v1'), pool: 1, version: 1 };
    const driver = makeDriver({ stampSource: src });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_500);
    const [stale] = warmSlots();

    // The update lands and the snapshot refreshes, but no reconcile has run
    // yet — the window in which the old selector handed the previous artifact
    // out while `service.claim` recorded the new version.
    src.entries['reg-app'] = { config: appAt('v2'), pool: 1, version: 2 };
    await src.refresh();
    const handle = await driver.claim(regSpec(freshKey(), 'reg-app'));
    await handle.status(); // the probe that converges the stamp into the fresh child
    driver.dispose();

    expect(handle.name).not.toBe(stale); // cold-booted at v2 instead
    expect(versionOf(handle.name)).toBeUndefined(); // a claimed instance is not a slot
    expect(fake.childOf(handle.name)!.applied.join('\n')).toContain('example.invalid/reg:v2');
  });

  it('a LIVE claim is untouched by an update — the frozen-instance rule holds through a hot update', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const src = new StubStampSource();
    src.entries['reg-app'] = { config: appAt('v1'), pool: 1, version: 1 };
    const driver = makeDriver({ stampSource: src });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_500);
    const [slot] = warmSlots();
    const handle = await driver.claim(regSpec(freshKey(), 'reg-app'));
    expect(handle.name).toBe(slot); // the warm hit
    const appliedWhenClaimed = fake.childOf(handle.name)!.applied.length;

    src.entries['reg-app'] = { config: appAt('v2'), pool: 1, version: 2 };
    await vi.advanceTimersByTimeAsync(70_000); // a full reconcile interval at the new version
    driver.dispose();

    // The instance lives, keeps its provenance labels, and nothing re-applied
    // into it: a hot update drains slots, never children.
    expect(fake.namespaces.has(handle.name)).toBe(true);
    expect(fake.namespaces.get(handle.name)!.labels['nanoclaw-dev-pool']).toBe('reg-app');
    expect(versionOf(handle.name)).toBe('1');
    expect(fake.childOf(handle.name)!.applied.length).toBe(appliedWhenClaimed);
    expect(fake.childOf(handle.name)!.applied.join('\n')).not.toContain('example.invalid/reg:v2');
  });

  it('a code-provided stamp has no version, so its slots carry no label and no reconcile drains them', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    // The static table wins an id collision, so a row's version could not
    // describe what such a slot runs: absence is the honest label, and the
    // claim selector asks for the absence.
    const driver = makeDriver({ pools: { 'sample-app': 1 } });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    const [slot] = warmSlots();
    expect(versionOf(slot)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(70_000);
    const handle = await driver.claim(claimSpec(freshKey()));
    driver.dispose();
    expect(handle.name).toBe(slot); // survived the reconciles and was handed out
  });
});

/**
 * A whole deployment as ONE stamp (C3): the child is not "up" because a pod is
 * Running — it is up when its governance answers AND its gateway enforces AND
 * its host runs. Plural readiness is that sentence mechanized: the warm gate
 * WAITS for every declared Deployment, so nothing is handed out on one
 * component's opinion.
 */
describe('whole-deployment readiness (plural gates)', () => {
  const GATES = [
    { deployment: 'gateway', namespace: 'system' },
    { deployment: 'governance', namespace: 'system' },
    { deployment: 'nanoclaw-host', namespace: 'nanoclaw' },
  ];

  function deploymentDoc(name: string, namespace: string): string {
    return JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace },
      spec: { replicas: 1, template: { spec: { containers: [{ name: 'c', image: 'child.invalid/c:1' }] } } },
    });
  }

  const STREAM = GATES.map((gate) => deploymentDoc(gate.deployment, gate.namespace)).join('\n---\n');
  const GOVERNED: K8sStampConfig = { childManifests: STREAM, readiness: GATES };

  const governedSpec = (key: EnvKey): DriverClaimSpec => ({
    key,
    stampId: 'governed',
    labels: devEnvLabels(INSTALL, key, 'governed'),
    options: {},
  });

  it('stays provisioning until EVERY declared gate is Available — two of three is not ready', async () => {
    const driver = makeDriver({ stamps: { governed: GOVERNED } });
    const handle = await driver.claim(governedSpec(freshKey()));
    fake.completeBoot(handle.name); // the vcluster half; the components have not rolled out
    expect((await handle.status()).phase).toBe('provisioning');

    const child = fake.childOf(handle.name)!;
    child.deployments.get('nanoclaw/nanoclaw-host')!.ready = true;
    child.deployments.get('system/governance')!.ready = true;
    // Governance answers and the host runs — and the gateway does not enforce
    // yet, which is exactly the state a "a pod responded" gate would call ready
    // while handing an agent an ungoverned child.
    expect((await handle.status()).phase).toBe('provisioning');

    child.deployments.get('system/gateway')!.ready = true;
    expect((await handle.status()).phase).toBe('ready');
    driver.dispose();
  });

  it('a pool slot flips warm only once all three are up — each gate probed in its own namespace', async () => {
    vi.useFakeTimers();
    const driver = makeDriver({ stamps: { governed: GOVERNED }, pools: { governed: 1 } });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    const filling = [...fake.namespaces.values()].find((ns) => ns.labels['nanoclaw-dev-slot'] === 'filling')!;
    fake.completeBoot(filling.name);
    await vi.advanceTimersByTimeAsync(2_500); // the probe that applies the stream
    expect(warmSlots()).toHaveLength(0); // applied, nothing Available

    const child = fake.childOf(filling.name)!;
    child.deployments.get('system/gateway')!.ready = true;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(warmSlots()).toHaveLength(0); // one leg green is not a governed child

    child.deployments.get('system/governance')!.ready = true;
    child.deployments.get('nanoclaw/nanoclaw-host')!.ready = true;
    await vi.advanceTimersByTimeAsync(2_500);
    driver.dispose();
    expect(warmSlots()).toEqual([filling.name]);
    const probes = fake.calls.map((c) => c.args.join(' '));
    expect(probes.some((p) => p.includes('deployment gateway -n system'))).toBe(true);
    expect(probes.some((p) => p.includes('deployment nanoclaw-host -n nanoclaw'))).toBe(true);
  });

  it('refuses the readiness declarations that cannot mean what they say', () => {
    // An empty list reads as "gated" to a human and as "bare vcluster" to the
    // driver — the silent-warm shape wearing a declaration.
    expect(() => validateStampEntry('g', { childManifests: STREAM, readiness: [] })).toThrow(/empty list/);
    expect(() =>
      validateStampEntry('g', { childManifests: STREAM, readiness: [GATES[0]!, GATES[1]!, GATES[0]!] }),
    ).toThrow(/twice/);
    expect(() =>
      validateStampEntry('g', {
        childManifests: STREAM,
        readiness: [GATES[0]!, { deployment: 'Bad Name', namespace: 'system' }],
      }),
    ).toThrow(/legal k8s object names/);
    // A gate list without a stream can never be met, same as the singular form.
    expect(() => validateStampEntry('g', { readiness: GATES })).toThrow(/without childManifests/);
  });

  describe('a dev block on a multi-gate stamp — one tree, one consumer, NAMED', () => {
    // A dev variant realizes the SAME deployment, so it declares every gated
    // Deployment — only the CONSUMER mounts the tree. A stream naming one of
    // three is refused (see the ungated-leg test in the C16 block); this
    // fixture is the shape that passes.
    const devDoc = (name: string, namespace: string, mountsTree: boolean): unknown => ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace },
      spec: {
        template: {
          spec: {
            ...(mountsTree
              ? {
                  securityContext: { runAsUser: '${DEV_TREE_UID}', runAsGroup: '${DEV_TREE_GID}' },
                  volumes: [{ name: DEV_TREE_PVC, persistentVolumeClaim: { claimName: DEV_TREE_PVC } }],
                }
              : {}),
            containers: [{ name: 'c', image: 'child.invalid/c:1' }],
          },
        },
      },
    });
    const devStream = GATES.map((gate) =>
      JSON.stringify(devDoc(gate.deployment, gate.namespace, gate.deployment === 'nanoclaw-host')),
    ).join('\n---\n');

    it('refuses one that names no consumer — falling back to the first gate would be an ORDER-dependent guess', () => {
      expect(() => validateStampEntry('g', { ...GOVERNED, dev: { manifests: devStream } })).toThrow(
        /declares no dev\.consumer/,
      );
    });

    it('refuses a consumer the readiness list does not gate on — nothing would wait for it', () => {
      expect(() =>
        validateStampEntry('g', {
          ...GOVERNED,
          dev: { manifests: devStream, consumer: { deployment: 'gateway', namespace: 'nanoclaw' } },
        }),
      ).toThrow(/which this stamp's readiness does not gate on/);
      expect(() =>
        validateStampEntry('g', {
          ...GOVERNED,
          dev: { manifests: devStream, consumer: 'gateway' as unknown as { deployment: string; namespace: string } },
        }),
      ).toThrow(/dev\.consumer must be \{deployment, namespace\}/);
    });

    it('accepts a declared consumer, and devConsumerGate returns THAT gate — not the first', () => {
      const config: K8sStampConfig = {
        ...GOVERNED,
        dev: { manifests: devStream, consumer: { deployment: 'nanoclaw-host', namespace: 'nanoclaw' } },
      };
      expect(() => validateStampEntry('g', config)).not.toThrow();
      // GATES[0] is gateway/system. The whole point of the declaration is that
      // the consumer is what the author said, never the list's head.
      expect(devConsumerGate('g', config)).toEqual({ deployment: 'nanoclaw-host', namespace: 'nanoclaw' });
    });

    it('leaves the single-gate stamp exactly as it was — the one gate IS the consumer, undeclared', () => {
      const config: K8sStampConfig = { childManifests: STREAM, readiness: GATES[0], dev: { manifests: devStream } };
      expect(() => validateStampEntry('g', config)).not.toThrow();
      expect(devConsumerGate('g', config)).toEqual(GATES[0]);
    });
  });
});

/**
 * Per-instance identity (C3): a claimed child must be its OWN installation.
 * Two things sharing ORG_ID/INSTALL_ID are one installation to governance and
 * the gateway, so a child that inherits them WORKS, wrongly — a second front
 * door onto the parent's org. The token is how a stream mints instead; the
 * refusals are what stop an author writing a literal.
 */
describe('per-instance identity (the ${INSTANCE} token)', () => {
  function identityStream(orgValue: string): string {
    return JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'gateway', namespace: 'system' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'gateway',
                image: 'child.invalid/gw:1',
                env: [
                  { name: 'VENDOR_GW_ORG_ID', value: orgValue },
                  { name: 'INSTALL_ID', value: '${INSTANCE}' },
                ],
              },
            ],
          },
        },
      },
    });
  }

  const READY = { deployment: 'gateway', namespace: 'system' };
  const TOKEN_STAMP: K8sStampConfig = { childManifests: identityStream('org-${INSTANCE}'), readiness: READY };

  const identitySpec = (key: EnvKey): DriverClaimSpec => ({
    key,
    stampId: 'governed',
    labels: devEnvLabels(INSTALL, key, 'governed'),
    options: {},
  });

  it('resolves to the instance’s own namespace at apply — never a literal token, never the parent’s org', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = makeDriver({ stamps: { governed: TOKEN_STAMP } });
    const handle = await driver.claim(identitySpec(freshKey()));
    await handle.status();
    driver.dispose();

    const applied = fake.childOf(handle.name)!.applied.join('\n');
    expect(applied).toContain(`"value":"org-${handle.name}"`);
    expect(applied).toContain(`"value":"${handle.name}"`);
    expect(applied).not.toContain('${INSTANCE}');
  });

  it('is minted at POOL FILL: the slot’s identity is the slot’s, allocated before any claimant exists', async () => {
    vi.useFakeTimers();
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const driver = makeDriver({ stamps: { governed: TOKEN_STAMP }, pools: { governed: 1 } });
    await driver.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_500);
    const [slot] = warmSlots();

    // Written while the slot belonged to nobody — the only arrangement in
    // which a warm pool and a per-instance identity are both true.
    expect(fake.childOf(slot)!.applied.join('\n')).toContain(`org-${slot}`);

    const handle = await driver.claim(identitySpec(freshKey()));
    driver.dispose();
    expect(handle.name).toBe(slot); // the claimant inherits the instance's identity, never the reverse
  });

  it('refuses a literal installation identity at registration — the theatre refusal', () => {
    expect(() =>
      validateStampEntry('governed', { childManifests: identityStream('org-parent-b2'), readiness: READY }),
    ).toThrow(/second front door/);
    expect(() => validateStampEntry('governed', TOKEN_STAMP)).not.toThrow();
  });

  it('refuses identity the approver cannot read: a valueFrom, and a base64 Secret entry', () => {
    const fromSecret = JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'gateway', namespace: 'system' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'gateway',
                image: 'child.invalid/gw:1',
                env: [{ name: 'ORG_ID', valueFrom: { secretKeyRef: { name: 'identity', key: 'org' } } }],
              },
            ],
          },
        },
      },
    });
    expect(() => validateStampEntry('governed', { childManifests: fromSecret, readiness: READY })).toThrow(
      /readable in the stream/,
    );

    const secretDoc = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'identity', namespace: 'system' },
      data: { INSTALL_ID: 'bmFub2NvLWs4cy1iMg==' },
    });
    expect(() =>
      validateStampEntry('governed', {
        childManifests: `${secretDoc}\n---\n${identityStream('org-${INSTANCE}')}`,
        readiness: READY,
      }),
    ).toThrow(/readable in the stream/);
  });

  it('covers governance’s own spelling of the same value, and refuses a YAML stream it cannot read', () => {
    const governanceDoc = JSON.stringify({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'gov', namespace: 'system' },
      data: { GOVERNANCE_ORG_ID: 'org-parent-b2' },
    });
    // A stream setting only GOVERNANCE_ORG_ID would carry the parent's org into
    // the child's governance past a check that only knew ORG_ID.
    expect(() =>
      validateStampEntry('governed', {
        childManifests: `${governanceDoc}\n---\n${identityStream('org-${INSTANCE}')}`,
        readiness: READY,
      }),
    ).toThrow(/second front door/);

    expect(() =>
      validateStampEntry('governed', {
        childManifests: 'kind: Deployment\nenv:\n  - name: INSTALL_ID\n    value: parent-b2\n',
        readiness: READY,
      }),
    ).toThrow(/mechanically checkable/);
  });

  it('says nothing about a stamp that names no identity at all', () => {
    expect(() => validateStampEntry('nanoclaw', BUILTIN_STAMPS['nanoclaw']!, { codeProvided: true })).not.toThrow();
  });

  /**
   * The DOCUMENTED example, through the refusal it documents. SKILL.md used to
   * show the YAML mapping form (`ORG_ID: org-${INSTANCE}`) on the flagship
   * path while the validator refuses any identity-naming stream that is not
   * JSON documents — an operator copying the doc got a refusal, which is the
   * worst kind of doc bug because the reader trusts the doc over the error.
   * `ci/tests/dev-env-stamp-docs.test.ts` holds the docs to this same constant.
   */
  it('the example the operator docs tell an author to copy REGISTERS — doc and validator cannot drift', async () => {
    fake.manualCompletion = false;
    fake.autoChildRollout = true;
    const documented = JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'gateway', namespace: 'system' },
      spec: {
        template: {
          spec: {
            containers: [
              // Pasted exactly as the docs print it, into the place the docs
              // say to paste it.
              { name: 'gateway', image: 'child.invalid/gw:1', env: JSON.parse(`[${STAMP_IDENTITY_EXAMPLE}]`) },
            ],
          },
        },
      },
    });
    const config: K8sStampConfig = { childManifests: documented, readiness: READY };
    expect(() => validateStampEntry('governed', config)).not.toThrow();

    // And it means what it says at apply: the documented keys resolve to this
    // instance, never to a literal token and never to a shared org.
    const driver = makeDriver({ stamps: { governed: config } });
    const handle = await driver.claim(identitySpec(freshKey()));
    await handle.status();
    driver.dispose();
    const applied = fake.childOf(handle.name)!.applied.join('\n');
    expect(applied).toContain(`"value":"org-${handle.name}"`);
    expect(applied).not.toContain('${INSTANCE}');

    // The spelling the docs used to show, refused — named, so an author who
    // finds an old copy of the example learns why in one line.
    expect(() =>
      validateStampEntry('governed', {
        childManifests: 'kind: Deployment\nenv:\n  ORG_ID: org-${INSTANCE}\n',
        readiness: READY,
      }),
    ).toThrow(/mechanically checkable/);
  });
});

/**
 * The node-presence assertion (C15's node-local half): a childManifests stamp
 * takes no registry origin, so its images arrive by operator hand and nothing
 * ever checked that they did. A missing one is ImagePullBackOff, which the
 * stamp gate can only read as "not Available yet" — a whole boot budget spent
 * to report a generic timeout.
 */
describe('declared node images', () => {
  it('answers a whole set in one node read, and inherits the truncation clamp', async () => {
    const driver = makeDriver();
    fake.nodeImages.set('fake-node', ['child.invalid/gw:1', 'child.invalid/gov:1']);
    const before = fake.calls.length;
    expect(
      await driver.missingNodeImages(['child.invalid/gw:1', 'child.invalid/host:1', 'child.invalid/gov:1']),
    ).toEqual(['child.invalid/host:1']);
    expect(fake.calls.slice(before).filter((c) => c.args[0] === 'get')).toHaveLength(1);

    // A report at kubelet's cap may be truncated, and a guessed absence would
    // refuse a claim over an image that is right there.
    fake.nodeImages.set('fake-node', Array.from({ length: 50 }, (_, i) => `child.invalid/filler:${i}`));
    expect(await driver.missingNodeImages(['child.invalid/gw:1'])).toEqual([]);
    driver.dispose();
  });

  /**
   * The clamp's OTHER open ends. Absence here is not an opinion — it closes the
   * claim gate, drops the stamp out of `poolSizes`, and the reap then drains
   * the warm slots it had. A node list that answered nothing, or a node that
   * has not published `status.images`, must never buy that: it is no report,
   * not an empty store.
   */
  it('never reads a missing or empty node report as absence — that would retire warm capacity', async () => {
    const driver = makeDriver();
    const refs = ['child.invalid/gw:1'];

    // A node that has not published its image report yet (fresh join, a
    // kubelet mid-restart): unreadable, so absence is unprovable.
    fake.nodeImages.set('fake-node', []);
    expect(await driver.missingNodeImages(refs)).toEqual([]);

    // A node list that came back with no nodes at all.
    fake.nodeNames = [];
    expect(await driver.missingNodeImages(refs)).toEqual([]);

    // One unreadable node in a multi-node report is enough: the ref could be
    // on exactly that node.
    fake.nodeNames = ['a', 'b'];
    fake.nodeImages.set('a', ['child.invalid/other:1']);
    fake.nodeImages.set('b', []);
    expect(await driver.missingNodeImages(refs)).toEqual([]);

    // With every node's report readable, a real absence still reads as one —
    // the clamp is honesty, not a blanket amnesty.
    fake.nodeImages.set('b', ['child.invalid/another:1']);
    expect(await driver.missingNodeImages(refs)).toEqual(refs);
    driver.dispose();
  });

  it('refuses the declarations that could not be checked', () => {
    const base: K8sStampConfig = {
      childManifests: '{"kind":"Namespace"}',
      readiness: { deployment: 'd', namespace: 'n' },
    };
    expect(() => validateStampEntry('s', { ...base, nodeImages: [] })).toThrow(/non-empty list/);
    expect(() => validateStampEntry('s', { ...base, nodeImages: ['gw:1', 'gw:1'] })).toThrow(/twice/);
    expect(() => validateStampEntry('s', { ...base, nodeImages: ['NOT AN IMAGE'] })).toThrow(/does not parse/);
    // A node-imported image has no registry host, and that is the whole point.
    expect(() => validateStampEntry('s', { ...base, nodeImages: ['nanoclaw-child-host:v05'] })).not.toThrow();
  });
});
