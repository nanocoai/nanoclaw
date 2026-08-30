/**
 * The k8s placement realization (C15): the namespace posture, the egress
 * netpol, the Job spec — pinned as OBJECTS (the claim-route pattern) — and
 * the driver's placeImage/probeImage against the fake cluster: the unwired
 * refusal, the happy path, the failure path carrying the placer's own words,
 * and the truncation-honest node probe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeKube } from './k8s-fake-kube.js';
import { K8sDevEnvDriver } from './k8s-driver.js';
import {
  DEFAULT_CONTAINERD_SOCKET,
  PLACEMENT_LABEL,
  buildPlacementJob,
  buildPlacementNamespace,
  buildPlacementNetpol,
  placementJobName,
  placementNamespaceName,
  type PlacementEgress,
} from './k8s-place.js';
import { placeRef } from './stamp-images.js';
import { DEV_ENV_LABELS, type DriverPlaceSpec } from './types.js';

const INSTALL = 'k8s-place-suite';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const SOURCE_REF = `registry.example.invalid/org/app:1@${DIGEST}`;

const EGRESS: PlacementEgress = {
  proxyUrl: 'http://10.0.0.7:3128',
  proxyCaPath: '/etc/platform/gateway-ca.pem',
  placerImage: 'example-placer:pinned',
};

function spec(overrides: Partial<DriverPlaceSpec> = {}): DriverPlaceSpec {
  return {
    stampId: 'my-app',
    version: 1,
    ref: placeRef('my-app', 1),
    labels: { [DEV_ENV_LABELS.install]: INSTALL, [DEV_ENV_LABELS.stamp]: 'my-app' },
    origin: { kind: 'pull', digest: DIGEST, sourceRef: SOURCE_REF },
    ...overrides,
  };
}

describe('the built objects', () => {
  it('the placement namespace carries the RELAXED posture — the standing exception lives here and nowhere else', () => {
    const ns = buildPlacementNamespace('nanoclaw-dev-place', INSTALL) as {
      metadata: { labels: Record<string, string> };
    };
    expect(ns.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('privileged');
    expect(ns.metadata.labels[DEV_ENV_LABELS.install]).toBe(INSTALL);
    expect(ns.metadata.labels[PLACEMENT_LABEL]).toBe('namespace');
  });

  it('the netpol is default-deny egress + DNS, opened to an IP-literal proxy by /32', () => {
    const { policy, residual } = buildPlacementNetpol('nanoclaw-dev-place', INSTALL, 'http://10.0.0.7:3128');
    expect(residual).toBeNull();
    const spec_ = (policy as { spec: { podSelector: object; policyTypes: string[]; egress: unknown[] } }).spec;
    expect(spec_.podSelector).toEqual({}); // every pod in the namespace, no exceptions
    expect(spec_.policyTypes).toEqual(['Egress']);
    expect(JSON.stringify(spec_.egress)).toContain('"cidr":"10.0.0.7/32"');
    expect(JSON.stringify(spec_.egress)).toContain('"port":3128');
  });

  it('a DNS-named proxy has no netpol form: the namespace stays sealed and the residual says so', () => {
    const { policy, residual } = buildPlacementNetpol('nanoclaw-dev-place', INSTALL, 'http://gw.internal:3128');
    expect(residual).toContain('DNS-named');
    expect(JSON.stringify(policy)).not.toContain('ipBlock'); // fail closed, never a guessed opening
  });

  it('the Job pulls the signed digest through the proxy, tags the derived ref, and mounts no credential', () => {
    const job = buildPlacementJob({ namespaceName: 'nanoclaw-dev-place', installScope: INSTALL, spec: spec(), egress: EGRESS });
    const text = JSON.stringify(job);
    expect(text).toContain(`images pull ${SOURCE_REF}`);
    expect(text).toContain(`tag --force ${SOURCE_REF} place.nanoclaw.invalid/stamp/my-app:v1`);
    expect(text).toContain('"HTTPS_PROXY","value":"http://10.0.0.7:3128"');
    expect(text).toContain(DEFAULT_CONTAINERD_SOCKET);
    expect(text).toContain('"imagePullPolicy":"IfNotPresent"');
    expect(text).toContain('"backoffLimit":0');
    // Ruling 3: no secret rides the pod — the gateway holds custody. The only
    // volumes are the socket and the CA.
    const volumes = (job as { spec: { template: { spec: { volumes: Array<{ name: string }> } } } }).spec.template.spec
      .volumes;
    expect(volumes.map((v) => v.name).sort()).toEqual(['containerd-sock', 'proxy-ca']);
  });

  it('refuses a spec whose ref is not registry-derived or whose source is not pinned to the signed digest', () => {
    const base = { namespaceName: 'nanoclaw-dev-place', installScope: INSTALL, egress: EGRESS };
    expect(() =>
      buildPlacementJob({ ...base, spec: spec({ ref: 'docker.io/evil/shadow:v1' }) }),
    ).toThrow(/registry-derived/);
    expect(() =>
      buildPlacementJob({ ...base, spec: spec({ origin: { kind: 'pull', digest: DIGEST, sourceRef: 'registry.example.invalid/org/app:1' } }) }),
    ).toThrow(/not pinned/);
  });
});

describe('the driver realization', () => {
  let fake: FakeKube;

  beforeEach(() => {
    fake = new FakeKube();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDriver(overrides: Partial<ConstructorParameters<typeof K8sDevEnvDriver>[0]> = {}): K8sDevEnvDriver {
    return new K8sDevEnvDriver({
      installScope: INSTALL,
      cli: fake,
      stamps: { 'sample-app': {} },
      materialsDir: '/tmp/unused-k8s-place-suite',
      placement: EGRESS,
      ...overrides,
    });
  }

  const NS = placementNamespaceName('nanoclaw-dev');
  const JOB = placementJobName('my-app', 1);

  it('refuses every placement on an unwired deployment with the gateway-egress reason — nothing pulls around it', async () => {
    const driver = makeDriver({ placement: undefined });
    await expect(driver.placeImage(spec())).rejects.toThrow(/rides the gateway.*gateway-registry-egress/s);
    expect(fake.jobs.size).toBe(0);
  });

  it('declares the pull capability and not the build one', () => {
    expect(makeDriver().capabilities()).toMatchObject({ imagePull: true, imageBuild: false });
  });

  it('places: namespace + netpol converge, the Job runs, storeId is the signed digest, the Job is disposed', async () => {
    vi.useFakeTimers();
    const driver = makeDriver();
    const placing = driver.placeImage(spec());
    // The create ran synchronously up to the first poll sleep.
    expect(fake.namespaces.has(NS)).toBe(true);
    expect(fake.netpols.has(`${NS}/placement-egress`)).toBe(true);
    expect(fake.jobs.has(`${NS}/${JOB}`)).toBe(true);
    fake.completeJob(NS, JOB);
    await vi.advanceTimersByTimeAsync(2_500);
    // A digest-pinned pull is content-addressed: success IS the verification,
    // and what landed is the digest approval signed.
    await expect(placing).resolves.toEqual({ storeId: DIGEST });
    expect(fake.jobs.size).toBe(0); // disposable by contract
    // A second placement converges the namespace/netpol instead of failing on AlreadyExists.
    const again = driver.placeImage(spec({ version: 2, ref: placeRef('my-app', 2) }));
    fake.completeJob(NS, placementJobName('my-app', 2));
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(again).resolves.toEqual({ storeId: DIGEST });
  });

  it("a failed Job rejects with the placer's own words, and the corpse is still disposed", async () => {
    vi.useFakeTimers();
    const driver = makeDriver();
    const placing = driver.placeImage(spec());
    fake.failJob(NS, JOB, 'ctr: failed to resolve reference: 401 Unauthorized');
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(placing).rejects.toThrow(/placement job failed: .*401 Unauthorized/);
    expect(fake.jobs.size).toBe(0);
  });

  it('times out a Job that never finishes, inside the driver budget', async () => {
    vi.useFakeTimers();
    const driver = makeDriver({ bootTimeoutMs: 10_000 });
    const placing = driver.placeImage(spec());
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(placing).rejects.toThrow(/did not finish inside/);
    expect(fake.jobs.size).toBe(0);
  });

  it('probeImage answers from node reports, truncation-honestly', async () => {
    const driver = makeDriver();
    const ref = placeRef('my-app', 1);
    // Present: true.
    fake.nodeImages.set('fake-node', [ref]);
    await expect(driver.probeImage(ref)).resolves.toBe(true);
    // Absent from an untruncated report: a real eviction.
    fake.nodeImages.set('fake-node', ['other.example/a:1']);
    await expect(driver.probeImage(ref)).resolves.toBe(false);
    // Absent from a possibly-truncated report (kubelet caps at 50): cannot
    // prove absence — a guessed eviction would close the claim gate over a
    // live image.
    fake.nodeImages.set(
      'fake-node',
      Array.from({ length: 50 }, (_, i) => `filler.example/img:${i}`),
    );
    await expect(driver.probeImage(ref)).resolves.toBe(true);
  });

  it('reapResidue sweeps terminal placement jobs a dying host orphaned, and spares live ones', async () => {
    const driver = makeDriver();
    // The orphans a dead reconciler leaves, seeded as runtime state: a
    // terminal job (its verdict already read or lost), and a young running
    // one this process may still hold.
    fake.jobs.set(`${NS}/place-ghost-v1`, {
      name: 'place-ghost-v1',
      namespace: NS,
      labels: { [PLACEMENT_LABEL]: 'job', [DEV_ENV_LABELS.install]: INSTALL },
      doc: {},
      status: { failed: 1 },
      creationTimestamp: new Date().toISOString(),
    });
    fake.jobs.set(`${NS}/place-live-v1`, {
      name: 'place-live-v1',
      namespace: NS,
      labels: { [PLACEMENT_LABEL]: 'job', [DEV_ENV_LABELS.install]: INSTALL },
      doc: {},
      status: {}, // running, young — this process may hold it
      creationTimestamp: new Date().toISOString(),
    });
    await driver.reapResidue(INSTALL);
    expect(fake.jobs.has(`${NS}/place-ghost-v1`)).toBe(false);
    expect(fake.jobs.has(`${NS}/place-live-v1`)).toBe(true);
  });
});
