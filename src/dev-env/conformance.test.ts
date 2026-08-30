/**
 * Dev-env driver conformance — the floor every driver clears, forever.
 *
 * Same construction as the session seam's suite: each case drives the same
 * claim through a harness and asserts the same observable outcome; where
 * drivers must differ, the difference is a declared capability, never a branch
 * on `kind`. The mock harness ships here; the k8s driver (T3) adds its own
 * harness and must pass every case unchanged.
 *
 * "Restart" in these cases means what it means in production: driver objects
 * die with the host, the runtime survives, and adoption rebuilds handles from
 * runtime-visible labels alone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerDevEnvDriver } from './docker-driver.js';
import { FakeDocker } from './docker-fake.js';
import { FakeKube } from './k8s-fake-kube.js';
import { K8sDevEnvDriver } from './k8s-driver.js';
import { MockDevEnvDriver, MockDevEnvRuntime, instanceName } from './mock-driver.js';
import { BUILTIN_STAMPS } from './stamps.js';
import {
  DEV_ENV_LABELS,
  devEnvLabels,
  type DevEnvDriver,
  type DevEnvInstanceHandle,
  type DriverClaimSpec,
  type EnvKey,
} from './types.js';

const INSTALL = 'conformance';

interface Harness {
  name: string;
  driver: DevEnvDriver;
  /** A fresh driver over the SAME surviving runtime — the host restarted. */
  restart(): DevEnvDriver;
  /** Drive the runtime-side boot of a provisioning instance to completion. */
  completeBoot(key: EnvKey): void;
  /** Crash a live instance out from under its handle. */
  crash(key: EnvKey): void;
  /** Fail a provisioning instance, leaving dead residue in the runtime. */
  failBoot(key: EnvKey): void;
  /** True if the runtime still holds anything allocated for this key. */
  runtimeHolds(key: EnvKey): boolean;
  /** The options the runtime actually realized for this key's instance. */
  claimedOptions(key: EnvKey): Record<string, string> | undefined;
  /** Make the next claim fail with the given taxonomy kind. */
  failNextClaim(kind: 'capacity-exhausted' | 'driver-unavailable'): void;
}

function mockHarness(): Harness {
  const runtime = new MockDevEnvRuntime();
  const make = (): MockDevEnvDriver =>
    new MockDevEnvDriver({
      installScope: INSTALL,
      runtime,
      knownStamps: ['sample-app'],
      manualCompletion: true,
    });
  const driver = make();
  return {
    name: 'mock',
    driver,
    restart: () => make(),
    completeBoot: (key) => runtime.complete(instanceName(key)),
    crash: (key) => runtime.kill(instanceName(key)),
    failBoot: (key) => runtime.failProvisioning(instanceName(key), { kind: 'instantiation-failed', retryable: false }),
    runtimeHolds: (key) => runtime.instances.has(instanceName(key)),
    claimedOptions: (key) => runtime.instances.get(instanceName(key))?.options,
    failNextClaim: (kind) => driver.failNextClaim({ kind, retryable: true }),
  };
}

function k8sHarness(): Harness {
  const fake = new FakeKube();
  const materialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-k8s-conformance-'));
  const make = (): K8sDevEnvDriver =>
    new K8sDevEnvDriver({ installScope: INSTALL, cli: fake, stamps: { 'sample-app': {} }, materialsDir });
  const namespaceOf = (key: EnvKey): string | undefined =>
    fake.namespaceByLabel(DEV_ENV_LABELS.instance, key.instanceId)?.name;
  return {
    name: 'k8s',
    driver: make(),
    restart: () => {
      fake.severWatches();
      return make();
    },
    completeBoot: (key) => fake.completeBoot(namespaceOf(key)!),
    crash: (key) => fake.crash(namespaceOf(key)!),
    failBoot: (key) => fake.failBoot(namespaceOf(key)!),
    runtimeHolds: (key) => namespaceOf(key) !== undefined,
    claimedOptions: (key) => {
      const ns = fake.namespaceByLabel(DEV_ENV_LABELS.instance, key.instanceId);
      if (!ns) return undefined;
      const options: Record<string, string> = {};
      for (const [k, v] of Object.entries(ns.annotations)) {
        if (k.startsWith('nanoclaw-dev/option.')) options[k.slice('nanoclaw-dev/option.'.length)] = v;
      }
      return options;
    },
    failNextClaim: (kind) =>
      fake.failNextClaimWith(
        kind === 'capacity-exhausted' ? 'exceeded quota: dev-env instances' : 'connection refused: apiserver',
      ),
  };
}

/**
 * The docker harness. Two deliberate differences from the k8s one, both of
 * them findings rather than accommodations:
 *
 * - It declares an APP-shape stamp where the k8s harness declares a bare one.
 *   A bare k8s stamp still has an address (a vcluster has an apiserver); a
 *   bare docker env is a NETWORK, and a network is a name, not a host. The
 *   endpoints case below therefore reads honestly here only against a stamp
 *   that actually serves something.
 * - Its "crash" takes the whole instance, network included. On docker the
 *   SCOPE is the network, so "the runtime no longer holds this instance"
 *   means the network is gone — the exact analogue of a deleted namespace.
 */
function dockerHarness(): Harness {
  const fake = new FakeDocker();
  const make = (): DockerDevEnvDriver =>
    new DockerDevEnvDriver({
      installScope: INSTALL,
      cli: fake,
      stamps: { 'sample-app': BUILTIN_STAMPS['sample-app'] },
      probeIntervalMs: 5,
    });
  return {
    name: 'docker',
    driver: make(),
    restart: () => {
      fake.severEvents();
      return make();
    },
    completeBoot: (key) => fake.completeBoot(key.instanceId),
    crash: (key) => fake.crash(key.instanceId),
    failBoot: (key) => fake.failBoot(key.instanceId),
    runtimeHolds: (key) => fake.holds(key.instanceId),
    claimedOptions: (key) => fake.optionsOf(key.instanceId),
    failNextClaim: (kind) =>
      fake.failNextWith(
        kind === 'capacity-exhausted'
          ? 'Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults'
          : 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      ),
  };
}

let harnesses: Harness[];
beforeEach(() => {
  harnesses = [mockHarness(), k8sHarness(), dockerHarness()];
});

function eachDriver(name: string, body: (h: Harness) => Promise<void> | void): void {
  it(name, async () => {
    for (const harness of harnesses) {
      try {
        await body(harness);
      } catch (error) {
        throw new Error(`[${harness.name}] ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }
  });
}

let n = 0;
function freshKey(): EnvKey {
  n += 1;
  return { envId: `env-${n}`, instanceId: `ins-${n}` };
}

function claimSpec(key: EnvKey, stampId = 'sample-app'): DriverClaimSpec {
  return { key, stampId, labels: devEnvLabels(INSTALL, key, stampId), options: {} };
}

describe('conformance: claims', () => {
  eachDriver('an unknown stamp is refused before anything is allocated', async (h) => {
    const key = freshKey();
    await expect(h.driver.claim(claimSpec(key, 'no-such-stamp'))).rejects.toMatchObject({
      kind: 'stamp-unknown',
      retryable: false,
    });
    expect(h.runtimeHolds(key)).toBe(false);
  });

  eachDriver('a claim may return still-provisioning; readiness fires at most once (D18)', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    expect((await handle.status()).phase).toBe('provisioning');

    const ready = vi.fn();
    handle.onReady(ready);
    h.completeBoot(key);

    expect(ready).toHaveBeenCalledOnce();
    const status = await handle.status();
    expect(status.phase).toBe('ready');
  });

  eachDriver('claim is idempotent on key: an existing live instance IS the claim', async (h) => {
    const key = freshKey();
    const first = await h.driver.claim(claimSpec(key));
    const second = await h.driver.claim(claimSpec(key));
    expect(second.name).toBe(first.name);
    expect(second.key).toEqual(key);
  });

  eachDriver('ready status carries named endpoints and no secret-shaped values', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    h.completeBoot(key);

    const status = await handle.status();
    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    expect(Object.keys(status.endpoints).length).toBeGreaterThan(0);
    // Access is material BY REFERENCE — paths, never values. Same measure the
    // session seam applies to container env: issuer-prefixed credential shapes
    // must not cross the seam whatever the key is called.
    for (const value of [...Object.values(status.endpoints), ...Object.values(status.access)]) {
      expect(value).not.toMatch(/^(sk-|ghp_|github_pat_|xox[baprs]-|AKIA|eyJ)/);
      expect(value).not.toContain('PRIVATE KEY');
    }
  });

  eachDriver('claim options reach the driver byte-identical — composition keeps the last word', async (h) => {
    // The one DriverClaimSpec field nothing else observes: pools key on
    // shape-changing options, so an option dropped here lands claims on
    // wrong-shaped instances with no error anywhere.
    const key = freshKey();
    const spec = { ...claimSpec(key), options: { flavor: 'dev', 'pg-shape': 'template' } };
    await h.driver.claim(spec);
    expect(h.claimedOptions(key)).toEqual({ flavor: 'dev', 'pg-shape': 'template' });
  });

  eachDriver('claim failures cross the seam in taxonomy shape, never raw', async (h) => {
    h.failNextClaim('capacity-exhausted');
    await expect(h.driver.claim(claimSpec(freshKey()))).rejects.toMatchObject({
      kind: 'capacity-exhausted',
      retryable: true,
    });
  });

  it('every builtin stamp id is claimable on a default-configured driver', async () => {
    // The builtin table is the floor: the mock's stamp list follows it (it
    // must not refuse an id every real driver knows), and the k8s default
    // table must construct and claim — which is also what proves each builtin
    // childManifests stamp clears the construction-time readiness refusal.
    const mock = new MockDevEnvDriver({
      installScope: INSTALL,
      runtime: new MockDevEnvRuntime(),
      manualCompletion: true,
    });
    const fake = new FakeKube();
    const materialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-builtin-'));
    try {
      const k8s = new K8sDevEnvDriver({ installScope: INSTALL, cli: fake, materialsDir });
      for (const stampId of Object.keys(BUILTIN_STAMPS)) {
        await expect(mock.claim(claimSpec(freshKey(), stampId))).resolves.toBeDefined();
        await expect(k8s.claim(claimSpec(freshKey(), stampId))).resolves.toBeDefined();
      }
    } finally {
      fs.rmSync(materialsDir, { recursive: true, force: true });
    }
  });

  it('the builtin table stops being a floor once a second runtime exists — and says so at claim', async () => {
    // A FINDING, pinned rather than papered over. `BUILTIN_STAMPS.nanoclaw` is
    // a Kubernetes manifest stream, and the shared stamp vocabulary
    // (K8sStampConfig: childManifests + a {deployment, namespace} readiness
    // gate) is structurally unrealizable on a docker daemon. So the claim that
    // every builtin is claimable on every default-configured driver is TRUE of
    // the two k8s-adjacent drivers above and FALSE across runtimes.
    //
    // What the contract owes in exchange is that the refusal is NAMED and
    // instant — never a boot that polls out its budget — and that the app-shape
    // builtin still claims. Both are asserted here. The cheaper home for this
    // refusal is registration (the CLI already refuses a pull-origin stamp on
    // `imagePull: false`); it would need one capability field expressing the
    // SHAPE a driver realizes, and it would not remove this check, because a
    // code-provided stamp never passes through the registry at all.
    const docker = new DockerDevEnvDriver({ installScope: INSTALL, cli: new FakeDocker(), probeIntervalMs: 5 });

    await expect(docker.claim(claimSpec(freshKey(), 'sample-app'))).resolves.toBeDefined();
    await expect(docker.claim(claimSpec(freshKey(), 'nanoclaw'))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('childManifests'),
    });
  });
});

describe('conformance: release', () => {
  eachDriver('release is full teardown — nothing this key allocated survives (D10)', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    h.completeBoot(key);

    await handle.release('done');

    expect(h.runtimeHolds(key)).toBe(false);
    expect((await handle.status()).phase).toBe('released');
  });

  eachDriver('release is idempotent: the reaper and an explicit release both win', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    h.completeBoot(key);
    await handle.release('first');
    await expect(handle.release('second')).resolves.toBeUndefined();
  });

  eachDriver('release fires no terminal event — only unrequested ends do', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    h.completeBoot(key);
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    await handle.release('done');

    expect(terminal).not.toHaveBeenCalled();
  });

  eachDriver('a crash fires exactly one terminal event with a taxonomy failure', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    h.completeBoot(key);
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    h.crash(key);

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instance-died' });
  });
});

describe('conformance: adoption — the restart story', () => {
  eachDriver('handles are rebuilt from runtime labels alone, and are live', async (h) => {
    const key = freshKey();
    await h.driver.claim(claimSpec(key));
    h.completeBoot(key);

    const adopted = await adoptOne(h.restart(), key);

    expect(adopted.key).toEqual(key);
    expect(adopted.stampId).toBe('sample-app');
    expect((await adopted.status()).phase).toBe('ready');
    await adopted.release('adopted-then-released');
    expect(h.runtimeHolds(key)).toBe(false);
  });

  eachDriver('a claim in flight when the host died completes on the adopted handle', async (h) => {
    const key = freshKey();
    await h.driver.claim(claimSpec(key));

    const adopted = await adoptOne(h.restart(), key);
    expect((await adopted.status()).phase).toBe('provisioning');

    const ready = vi.fn();
    adopted.onReady(ready);
    h.completeBoot(key);

    expect(ready).toHaveBeenCalledOnce();
  });

  eachDriver('re-claiming an adopted key returns the live instance, not a duplicate', async (h) => {
    // Idempotency-on-key is the seam floor under any caller-side replay: the
    // claim that already happened IS the claim.
    const key = freshKey();
    await h.driver.claim(claimSpec(key));
    h.completeBoot(key);

    const replayed = await h.restart().claim(claimSpec(key));

    expect((await replayed.status()).phase).toBe('ready');
  });

  eachDriver('resume converges a surviving in-flight claim and allocates nothing for a vanished one', async (h) => {
    // The registry's re-adoption contract: an instance that survived the
    // restart is converged in place; one that did not is the registry's fact
    // to settle — resume must never mint a replacement behind its back.
    const key = freshKey();
    await h.driver.claim(claimSpec(key));

    const restarted = h.restart();
    await restarted.resumeClaim?.(claimSpec(key));
    expect(h.runtimeHolds(key)).toBe(true);

    h.crash(key);
    await restarted.resumeClaim?.(claimSpec(key));
    expect(h.runtimeHolds(key)).toBe(false);
  });

  eachDriver('failed residue is discoverable and reapable', async (h) => {
    const key = freshKey();
    const handle = await h.driver.claim(claimSpec(key));
    h.failBoot(key);
    expect((await handle.status()).phase).toBe('failed');

    const restarted = h.restart();
    await restarted.reapResidue?.(INSTALL);

    expect(h.runtimeHolds(key)).toBe(false);
    expect(await restarted.listInstances(INSTALL)).not.toContainEqual(expect.objectContaining({ key }));
  });

  eachDriver('discovery is scoped to the install', async (h) => {
    const key = freshKey();
    const foreign: DriverClaimSpec = {
      ...claimSpec(key),
      labels: devEnvLabels('some-other-install', key, 'sample-app'),
    };
    await h.driver.claim(foreign);

    const found = await h.restart().listInstances(INSTALL);

    expect(found.map((f) => f.key.envId)).not.toContain(key.envId);
  });
});

describe('conformance: capabilities are honest', () => {
  eachDriver('declares isolation and egress posture; features gate on these, never on kind', (h) => {
    const capabilities = h.driver.capabilities();
    expect(typeof capabilities.isolation).toBe('string');
    expect(typeof capabilities.sealedEgress).toBe('boolean');
    // C15: the two placement flags — two, not one, because pulling and
    // building are different driver properties gated separately at create.
    expect(typeof capabilities.imagePull).toBe('boolean');
    expect(typeof capabilities.imageBuild).toBe('boolean');
  });
});

describe('the zero-NanoCo gate (D9)', () => {
  it('dev-env core contains no NanoCo-specific references', () => {
    // The platform is tenant-generic; NanoCo is customer zero, layered like any
    // customer. This is the acceptance test the spec names, kept where the code
    // lives so it fails in the same run that introduces the reference.
    const self = new URL(import.meta.url).pathname;
    const dir = path.dirname(self);
    for (const file of fs.readdirSync(dir)) {
      // The gate is the one file allowed to say the name — it is ABOUT the name.
      if (!file.endsWith('.ts') || file === path.basename(self)) continue;
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source, `${file} must stay tenant-generic`).not.toMatch(/nanoco/i);
    }
  });
});

async function adoptOne(driver: DevEnvDriver, key: EnvKey): Promise<DevEnvInstanceHandle> {
  const handles = await driver.listInstances(INSTALL);
  const handle = handles.find((h) => h.key.envId === key.envId);
  if (!handle) throw new Error(`adoption found no instance for env ${key.envId}`);
  return handle;
}
