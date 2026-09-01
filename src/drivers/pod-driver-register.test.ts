/**
 * The driver-installation seam: one appended import makes `pod` a kind the
 * host's own selection can resolve.
 *
 * The case that matters is not "the class exists" — it is that registering
 * through the registry module alone is enough, with selection never imported
 * first. That is the order an appended `import './pod-driver-register.js';` in
 * `src/drivers/installed.ts` actually produces, and the shape trunk's selection
 * refuses to guess at: an unregistered kind throws rather than falling back to
 * docker, so a wiring that silently did nothing would take the host down loudly
 * instead of running the wrong runtime.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let cwd: string;
let previous: string;

const STORAGE_ENV = {
  NANOCLAW_MAILBOX_S3_BUCKET: 'nanoco-agent-mailbox',
  NANOCLAW_MAILBOX_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
  NANOCLAW_MAILBOX_S3_PREFIX: 'nanoclaw',
  NANOCLAW_MAILBOX_S3_REGION: 'us-east-1',
  NANOCLAW_WORKSPACE_S3_BUCKET: 'nanoco-agent-workspace',
  NANOCLAW_WORKSPACE_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
  NANOCLAW_WORKSPACE_S3_PREFIX: 'restic',
  NANOCLAW_WORKSPACE_S3_REGION: 'us-east-1',
};

beforeEach(() => {
  vi.resetModules();
  previous = process.cwd();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-pod-register-'));
  process.chdir(cwd);
  delete process.env.NANOCLAW_POD_NAMESPACE;
  delete process.env.NANOCO_KATA_AVAILABLE;
  delete process.env.NANOCO_KATA_RUNTIME_CLASS;
  delete process.env.NANOCLAW_POD_VOLUME_PVC;
  delete process.env.NANOCLAW_POD_VOLUME_ROOT;
  for (const key of Object.keys(STORAGE_ENV)) delete process.env[key];
});

afterEach(() => {
  process.chdir(previous);
  delete process.env.NANOCLAW_POD_NAMESPACE;
  delete process.env.NANOCO_KATA_AVAILABLE;
  delete process.env.NANOCO_KATA_RUNTIME_CLASS;
  delete process.env.NANOCLAW_POD_VOLUME_PVC;
  delete process.env.NANOCLAW_POD_VOLUME_ROOT;
  for (const key of Object.keys(STORAGE_ENV)) delete process.env[key];
});

describe('pod driver registration', () => {
  it('resolves the RuntimeClass name from the env, defaulting to the harness-provisioned class', async () => {
    // 'kata' names no class a real cluster holds; the default is the class the
    // encrypted-workspace harness provisions on a Kata-ready substrate.
    const { kataRuntimeClass } = await import('./runtime-class.js');
    expect(kataRuntimeClass({})).toBe('kata-qemu-runtime-rs');
    expect(kataRuntimeClass({ NANOCO_KATA_RUNTIME_CLASS: 'kata-clh' })).toBe('kata-clh');
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCO_KATA_RUNTIME_CLASS=kata-clh\n');
    expect(kataRuntimeClass({})).toBe('kata-clh');
    // process.env precedence, the same order every other NanoClaw setting keeps.
    expect(kataRuntimeClass({ NANOCO_KATA_RUNTIME_CLASS: 'kata-x' })).toBe('kata-x');
  });

  it('treats Kata availability as an explicit operator declaration, failing closed', async () => {
    const { kataAvailable } = await import('./runtime-class.js');
    expect(kataAvailable({})).toBe(false);
    expect(kataAvailable({ NANOCO_KATA_AVAILABLE: '0' })).toBe(false);
    expect(kataAvailable({ NANOCO_KATA_AVAILABLE: '1' })).toBe(true);
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCO_KATA_AVAILABLE=1\n');
    expect(kataAvailable({})).toBe(true);
  });

  it('the registered factory carries the declaration onto capabilities().isolationTiers', async () => {
    // A registration that dropped the option would advertise container-only
    // forever, and every vm session would refuse at prepare.
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCO_KATA_AVAILABLE=1\n');
    await import('./pod-driver-register.js');
    const { createSessionDriver } = await import('./index.js');
    expect(createSessionDriver('pod').capabilities().isolationTiers).toEqual(['container', 'vm']);
  });

  it('advertises only the container tier when nothing declares Kata', async () => {
    await import('./pod-driver-register.js');
    const { createSessionDriver } = await import('./index.js');
    expect(createSessionDriver('pod').capabilities().isolationTiers).toEqual(['container']);
  });

  it('makes `pod` resolvable through the host selection that ships with the seam', async () => {
    await import('./pod-driver-register.js');
    const { createSessionDriver, listSessionDriverKinds } = await import('./index.js');
    expect(listSessionDriverKinds()).toContain('pod');
    expect(createSessionDriver('pod').kind).toBe('pod');
  });

  it('selects the gateway sidecar realization that shares the Pod namespace', async () => {
    const { defaultSessionSidecarDriver } = await import('../nanoco/session-sidecar.js');
    expect(defaultSessionSidecarDriver().sharesNetworkNamespace).toBe(true);
  });

  it('leaves docker the default when nothing selects pod', async () => {
    await import('./pod-driver-register.js');
    const { configuredDriverKind } = await import('./index.js');
    expect(configuredDriverKind({})).toBe('docker');
  });

  it('shares the NanoCo session material root with the Pod mount policy', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCO_SESSION_MATERIAL_ROOT=/session-materials\n');
    const { mountPolicy } = await import('./index.js');
    expect(mountPolicy({}).materialsRoot).toBe('/session-materials');
  });

  it('refuses a second registration instead of letting an import order decide', async () => {
    await import('./pod-driver-register.js');
    const { registerSessionDriver } = await import('./driver-registry.js');
    expect(() => registerSessionDriver('pod', (policy) => ({}) as never)).toThrow(/already registered/);
  });
});

describe('podNamespace', () => {
  it('defaults to agents', async () => {
    const { podNamespace } = await import('./pod-driver.js');
    expect(podNamespace({})).toBe('agents');
  });

  it('reads .env, not only the process environment', async () => {
    // The host service has no `EnvironmentFile=` — it parses `.env` in-process.
    // A namespace that only honoured `process.env` would be silently ignored in
    // the file every other NanoClaw setting is written to, and the driver would
    // create pods in `agents` on a cluster where that namespace has no policy.
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCLAW_POD_NAMESPACE=tenant-b\n');
    const { podNamespace } = await import('./pod-driver.js');
    expect(podNamespace({})).toBe('tenant-b');
  });

  it('lets the process environment win over .env', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCLAW_POD_NAMESPACE=tenant-b\n');
    const { podNamespace } = await import('./pod-driver.js');
    expect(podNamespace({ NANOCLAW_POD_NAMESPACE: 'tenant-c' })).toBe('tenant-c');
  });

  it('is the namespace the driver actually files pods under', async () => {
    // The setting is only real if it reaches kubectl. Asserting the resolved
    // string alone would pass even if the constructor ignored it.
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCLAW_POD_NAMESPACE=tenant-b\n');
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const cli = new FakeCli('kubectl');
    cli.responses = [{ match: /^get pods /, output: '{"items":[]}' }];
    const driver = new PodSessionDriver({
      groupsRoot: '/install/groups',
      dataRoot: '/install/data',
      surfaceRoots: [],
      materialsRoot: '/install/data/nanoco-sessions',
      cli,
      kataAvailable: true,
    });

    await driver.listSessions('spike');
    expect(cli.joined().join('\n')).toContain('-n tenant-b');
  });
});

describe('execSpec', () => {
  it('describes TTY and plain kubectl exec without making a runtime call', async () => {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY } = await import('./spec-fixture.js');
    const { LABELS } = await import('./types.js');
    const cli = new FakeCli('kubectl');
    cli.responses = [{
      match: /^get pods /,
      output: JSON.stringify({
        items: [{ metadata: { name: 'ncl-spike-s1', labels: {
          [LABELS.group]: 'g1',
          [LABELS.session]: 's1',
        } } }],
      }),
    }];
    const driver = new PodSessionDriver({ ...FIXTURE_POLICY, cli, kataAvailable: true });
    const [{ handle }] = await driver.listSessions('spike');
    const before = cli.calls.length;
    const command = ['sh', '-c', 'echo "$HOME"', '--', '-t', '-n', 'other'];

    expect(handle.execSpec(command)).toEqual({
      bin: 'kubectl',
      argsTty: ['exec', '-i', '-t', '-n', 'agents', 'ncl-spike-s1', '-c', 'agent', '--', ...command],
      argsPlain: ['exec', '-i', '-n', 'agents', 'ncl-spike-s1', '-c', 'agent', '--', ...command],
    });
    expect(cli.calls.length).toBe(before);
    expect(cli.started).toHaveLength(0);
  });
});

describe('agent storage coordinates', () => {
  async function composedAgentEnvironment(): Promise<{
    agent: Record<string, string>;
    sidecar: Record<string, string>;
  }> {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const spec = fixtureSpec();
    spec.containers.push({
      role: 'egress-sidecar',
      image: 'nanoco-session-sidecar:test',
      env: {},
      mounts: [],
    });
    const pod = new PodSessionDriver({
      ...FIXTURE_POLICY,
      kataAvailable: true,
      cli: new FakeCli('kubectl'),
      statHostPath: () => 'Directory',
    }).composePod(spec);
    const agent = (pod.spec!.containers as import('./pod-driver.js').V1Container[])[0]!;
    const sidecar = (pod.spec!.initContainers as import('./pod-driver.js').V1Container[])[0]!;
    return {
      agent: Object.fromEntries((agent.env ?? []).map(({ name, value }) => [name, value])),
      sidecar: Object.fromEntries((sidecar.env ?? []).map(({ name, value }) => [name, value])),
    };
  }

  it('projects only the four mailbox coordinates into the agent, not workspace coordinates or its sidecar', async () => {
    fs.writeFileSync(
      path.join(cwd, '.env'),
      `${Object.entries(STORAGE_ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n` + 'AWS_SECRET_ACCESS_KEY=must-not-pass\n',
    );

    const { agent, sidecar } = await composedAgentEnvironment();
    const mailbox = Object.fromEntries(Object.entries(STORAGE_ENV).filter(([key]) => key.includes('_MAILBOX_')));
    expect(agent).toMatchObject(mailbox);
    expect(agent.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    for (const key of Object.keys(STORAGE_ENV).filter((key) => key.includes('_WORKSPACE_'))) expect(agent[key]).toBeUndefined();
    for (const key of Object.keys(STORAGE_ENV)) expect(sidecar[key]).toBeUndefined();
  });

  it('refuses a partial coordinate set instead of starting a misconfigured agent', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), `NANOCLAW_MAILBOX_S3_BUCKET=${STORAGE_ENV.NANOCLAW_MAILBOX_S3_BUCKET}\n`);
    await expect(composedAgentEnvironment()).rejects.toThrow(
      /partial agent storage runtime configuration \(1\/4 values\)/,
    );
  });

  it('realizes the trusted contributed environment after the composed environment', async () => {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const spec = fixtureSpec();
    const agent = spec.containers.find(({ role }) => role === 'agent')!;
    agent.contributedEnv = { HTTPS_PROXY: 'http://gateway:15001' };
    const pod = new PodSessionDriver({
      ...FIXTURE_POLICY,
      kataAvailable: true,
      cli: new FakeCli('kubectl'),
      statHostPath: () => 'Directory',
    }).composePod(spec);
    const realizedAgent = (pod.spec!.containers as import('./pod-driver.js').V1Container[])[0]!;
    const env = Object.fromEntries(
      (realizedAgent.env ?? []).map(({ name, value }) => [name, value]),
    );
    expect(env.HTTPS_PROXY).toBe('http://gateway:15001');
  });

  it('accepts matching composed storage coordinates and refuses conflicts with host custody', async () => {
    fs.writeFileSync(
      path.join(cwd, '.env'),
      `${Object.entries(STORAGE_ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    );
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const spec = fixtureSpec();
    Object.assign(spec.containers.find(({ role }) => role === 'agent')!.env, STORAGE_ENV);
    const driver = new PodSessionDriver({
      ...FIXTURE_POLICY,
      kataAvailable: true,
      cli: new FakeCli('kubectl'),
      statHostPath: () => 'Directory',
    });
    expect(() => driver.composePod(spec)).not.toThrow();

    spec.containers.find(({ role }) => role === 'agent')!.env.NANOCLAW_MAILBOX_S3_BUCKET = 'recipe-bucket';
    expect(() => driver.composePod(spec)).toThrow(
      /agent spec env conflicts with host-managed storage coordinate NANOCLAW_MAILBOX_S3_BUCKET/,
    );
  });
});

describe('pod mount realization', () => {
  it('uses Kubelet readiness as activity and reports watch loss as unknown', async () => {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY } = await import('./spec-fixture.js');
    const cli = new FakeCli();
    cli.responses = [{
      match: /^get pods /,
      output: JSON.stringify({ items: [{
        metadata: { name: 'pod', labels: {
          'nanoclaw-group': 'g',
          'nanoclaw-session': 's',
        } },
        status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true }] },
      }] }),
    }];
    const driver = new PodSessionDriver({ ...FIXTURE_POLICY, cli, statHostPath: () => 'Directory' });
    const key = { installSlug: 'test', agentGroupId: 'g', sessionId: 's' };

    await driver.listSessions('test');
    expect(driver.activityStatus(key)).toBe(true);

    driver.watchSessions('test', () => {});
    cli.started.at(-1)!.proc.emitStdout(`${JSON.stringify({
      type: 'MODIFIED',
      object: {
        metadata: { labels: { 'nanoclaw-group': 'g', 'nanoclaw-session': 's' } },
        status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: false }] },
      },
    })}\n`);
    expect(driver.activityStatus(key)).toBe(false);
    cli.started.at(-1)!.proc.emitExit(1);
    expect(driver.activityStatus(key)).toBeUndefined();
  });

  it('isolates each pod heartbeat and attaches exact probe contracts', async () => {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const driver = new PodSessionDriver({ ...FIXTURE_POLICY, cli: new FakeCli(), statHostPath: () => 'Directory' });
    const pod = driver.composePod(fixtureSpec());
    const agent = (pod.spec!.containers as import('./pod-driver.js').V1Container[])[0]!;
    const heartbeat = (pod.spec!.volumes as import('./pod-driver.js').V1Volume[]).find(({ name }) => name === 'agent-heartbeat');
    expect(heartbeat).toEqual({ name: 'agent-heartbeat', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
    expect(agent.volumeMounts).toContainEqual({ name: 'agent-heartbeat', mountPath: '/workspace/.heartbeat', subPath: '.heartbeat' });
    expect(agent.readinessProbe).toEqual({
      exec: { command: ['/usr/local/bin/nanoclaw-agent-health', 'readiness'] },
      periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 1, successThreshold: 1,
    });
    expect(agent.livenessProbe).toEqual({
      exec: { command: ['/usr/local/bin/nanoclaw-agent-health', 'liveness'] },
      periodSeconds: 60, timeoutSeconds: 10, failureThreshold: 3, successThreshold: 1,
    });
  });

  it('orders nested targets after their parents', async () => {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const spec = fixtureSpec();
    spec.containers[0]!.mounts = [
      { class: 'group-state', hostPath: '/install/groups/g1/tasks', containerPath: '/workspace/agent/tasks', mode: 'ro', groupScope: 'g1' },
      { class: 'group-state', hostPath: '/install/data/v2-sessions/g1/s1', containerPath: '/workspace', mode: 'rw', groupScope: 'g1' },
      { class: 'group-state', hostPath: '/install/groups/g1', containerPath: '/workspace/agent', mode: 'rw', groupScope: 'g1' },
    ];
    const pod = new PodSessionDriver({
      ...FIXTURE_POLICY,
      kataAvailable: true,
      cli: new FakeCli('kubectl'),
      statHostPath: () => 'Directory',
    }).composePod(spec);
    const agent = (pod.spec!.containers as import('./pod-driver.js').V1Container[])[0]!;

    expect(agent.volumeMounts.map(({ mountPath }) => mountPath).filter((mountPath) => !['/dev/shm', '/workspace/.heartbeat'].includes(mountPath))).toEqual([
      '/workspace',
      '/workspace/agent',
      '/workspace/agent/tasks',
    ]);
  });

  it('types only the filesystem entry named by the spec', async () => {
    const { statHostPath } = await import('./pod-driver.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-stat-'));
    fs.mkdirSync(path.join(dir, 'directory'));
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    fs.symlinkSync(path.join(dir, 'directory'), path.join(dir, 'link'));

    expect(statHostPath(path.join(dir, 'directory'))).toBe('Directory');
    expect(statHostPath(path.join(dir, 'file'))).toBe('File');
    // Was `toBeNull()` until statHostPath moved to `statSync`: a Secret volume
    // is a directory of symlinks, so an lstat here refused material that was
    // present. The real-filesystem describe at the end of this file owns that
    // case; this line is kept only so the two do not disagree.
    expect(statHostPath(path.join(dir, 'link'))).toBe('Directory');
    expect(statHostPath(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('isolation tiers — kata availability and the resolved RuntimeClass', () => {
  async function tierDriver(opts: { kataAvailable?: boolean } = {}) {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const cli = new FakeCli('kubectl');
    cli.responses = [{ match: /^get pods /, output: '{"items":[]}' }];
    const driver = new PodSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      statHostPath: () => 'Directory',
      ...opts,
    });
    return { driver, cli, fixtureSpec };
  }

  it('prepare REFUSES a vm spec while kata is unavailable — loudly, naming the tiers', async () => {
    // validateSpec's third argument judges the tier against THIS driver's own
    // capabilities() — container-only without kata — so a vm spec refuses by
    // name instead of composing a pod that silently runs un-isolated on runc.
    const { driver, cli, fixtureSpec } = await tierDriver();
    await expect(driver.prepare(fixtureSpec({ runtimeTier: 'vm' }))).rejects.toThrow(
      /not in driver isolation tiers \[container\]/,
    );
    expect(cli.calls.some((c) => c.args[0] === 'create')).toBe(false);
  });

  it('the tier refusal is a non-retryable spec-invalid — no respawn can widen the tiers', async () => {
    const { driver, fixtureSpec } = await tierDriver();
    await expect(driver.prepare(fixtureSpec({ runtimeTier: 'vm' }))).rejects.toMatchObject({
      kind: 'spec-invalid',
      retryable: false,
    });
  });

  it('names the resolved RuntimeClass on a vm-tier pod when kata is available', async () => {
    const { driver, fixtureSpec } = await tierDriver({ kataAvailable: true });
    const pod = driver.composePod(fixtureSpec({ runtimeTier: 'vm' }));
    expect(pod.spec!.runtimeClassName).toBe('kata-qemu-runtime-rs');
    const agent = (pod.spec!.containers as import('./pod-driver.js').V1Container[])[0]!;
    // The limit sizes the Kata guest; the request is what the scheduler
    // reserves — six full-limit reservations filled a 30Gi node while real
    // usage sat near 0.6Gi per session (nancy-v3 OutOfMemory, 2026-09-01).
    expect(agent.resources).toEqual({
      requests: { memory: '1024Mi' },
      limits: { memory: '4096Mi' },
    });
  });

  it('runs the workspace composer inside the vm-tier Kata pod', async () => {
    const { driver, fixtureSpec } = await tierDriver({ kataAvailable: true });
    const spec = fixtureSpec({ runtimeTier: 'vm' });
    spec.containers.push({ role: 'workspace-composer', image: 'materializer', env: {}, mounts: [] });
    const pod = driver.composePod(spec);
    expect(pod.spec!.runtimeClassName).toBe('kata-qemu-runtime-rs');
    const initContainers = pod.spec!.initContainers as import('./pod-driver.js').V1Container[];
    expect(initContainers.some((container) => container.name === 'workspace-composer')).toBe(true);
  });

  it('lets NANOCO_KATA_RUNTIME_CLASS point the pod at the cluster\'s own class', async () => {
    process.env.NANOCO_KATA_RUNTIME_CLASS = 'kata-clh';
    try {
      const { driver, fixtureSpec } = await tierDriver({ kataAvailable: true });
      const pod = driver.composePod(fixtureSpec({ runtimeTier: 'vm' }));
      expect(pod.spec!.runtimeClassName).toBe('kata-clh');
    } finally {
      delete process.env.NANOCO_KATA_RUNTIME_CLASS;
    }
  });

  it('names no RuntimeClass for a container-tier pod, kata available or not', async () => {
    const { driver, fixtureSpec } = await tierDriver({ kataAvailable: true });
    const pod = driver.composePod(fixtureSpec());
    expect(pod.spec!.runtimeClassName).toBeUndefined();
    expect((pod.spec!.containers as import('./pod-driver.js').V1Container[])[0]!.resources).toBeUndefined();
  });

  it('names no RuntimeClass for a vm spec without kata — composition never invents a class', async () => {
    const { driver, fixtureSpec } = await tierDriver();
    const pod = driver.composePod(fixtureSpec({ runtimeTier: 'vm' }));
    expect(pod.spec!.runtimeClassName).toBeUndefined();
  });
});

/**
 * `statHostPath` against a REAL filesystem, because every other test in this
 * tree injects a fake one — which is exactly how the defect below survived.
 *
 * Kubernetes projects a Secret volume as symlinks into a timestamped `..data/`
 * sibling, so a mounted PKI file is a symlink and never a regular file. Under
 * `lstatSync` this function answered `null` for material that was present and
 * readable, `PodSessionSidecarDriver` refused it as "not present on the node",
 * and the sidecar manager rethrew that as a generic "failed to start" — so a
 * governed child accepted turns, provisioned channels, and never spawned a
 * session pod.
 */
describe('statHostPath against a real filesystem', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-host-path-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves a SYMLINKED file — the shape every Secret mount takes', async () => {
    const { statHostPath } = await import('./pod-driver.js');
    const data = path.join(root, '..data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'gateway-server-ca.pem'), 'pem');
    const link = path.join(root, 'gateway-server-ca.pem');
    fs.symlinkSync(path.join(data, 'gateway-server-ca.pem'), link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statHostPath(link)).toBe('File');
  });

  it('resolves a symlinked directory', async () => {
    const { statHostPath } = await import('./pod-driver.js');
    const target = path.join(root, 'real');
    fs.mkdirSync(target);
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link);
    expect(statHostPath(link)).toBe('Directory');
  });

  it('still refuses a DANGLING symlink — the check keeps its teeth', async () => {
    const { statHostPath } = await import('./pod-driver.js');
    const link = path.join(root, 'gone.pem');
    fs.symlinkSync(path.join(root, 'nowhere.pem'), link);
    expect(statHostPath(link)).toBeNull();
  });

  it('answers File and Directory for ordinary entries, and null for an absent path', async () => {
    const { statHostPath } = await import('./pod-driver.js');
    const file = path.join(root, 'plain.pem');
    fs.writeFileSync(file, 'pem');
    expect(statHostPath(file)).toBe('File');
    expect(statHostPath(root)).toBe('Directory');
    expect(statHostPath(path.join(root, 'absent'))).toBeNull();
  });
});

/**
 * INTERIM — PVC volume mode. Deleted together with the implementation when the
 * agent-materializer plan lands; see the banner above `podVolumePvc`.
 *
 * Two halves, and the FIRST one is what protects everything already deployed:
 * all four recipes that consume this skill run the host as a NODE process,
 * where hostPath is both legal and correct, so an unset environment must keep
 * composing the same pod it always did. The second half is the pod-hosted host,
 * where the paths the driver is handed are POD paths — `/nanoclaw` does not
 * exist on the node — and hostPath is not merely PSA-forbidden but wrong.
 */
describe('PVC volume mode', () => {
  type Volume = import('./pod-driver.js').V1Volume;
  type VolumeMount = import('./pod-driver.js').V1VolumeMount;
  type Container = import('./pod-driver.js').V1Container;

  /** The claim that backs the host's own tree, and the tree's root inside it. */
  const PVC = { claimName: 'nanoclaw-tree', root: '/install' };

  async function pvcDriver(opts: Partial<import('./pod-driver.js').PodDriverOptions> = {}) {
    const { PodSessionDriver } = await import('./pod-driver.js');
    const { FakeCli } = await import('./fake-cli.js');
    const { FIXTURE_POLICY, fixtureSpec } = await import('./spec-fixture.js');
    const cli = new FakeCli('kubectl');
    cli.responses = [{ match: /^get pods /, output: '{"items":[]}' }];
    const driver = new PodSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      statHostPath: () => 'Directory',
      ...opts,
    });
    return { driver, cli, fixtureSpec };
  }

  const agentOf = (pod: import('./pod-driver.js').ComposedPod): Container =>
    (pod.spec!.containers as Container[])[0]!;
  const volumesOf = (pod: import('./pod-driver.js').ComposedPod): Volume[] =>
    pod.spec!.volumes as Volume[];

  /** The two gateway CAs a governed child gets Secret-projected, outside the tree. */
  const GATEWAY_CA_MOUNTS = [
    {
      class: 'allowlisted-extra' as const,
      hostPath: '/etc/nanoco/pki/gateway-server-ca.pem',
      containerPath: '/run/session/gateway-server-ca.pem',
      mode: 'ro' as const,
      groupScope: 'g1',
    },
    {
      class: 'allowlisted-extra' as const,
      hostPath: '/etc/nanoco/pki/gateway-client-ca.pem',
      containerPath: '/run/session/gateway-client-ca.pem',
      mode: 'ro' as const,
      groupScope: 'g1',
    },
  ];

  describe('podVolumePvc — both keys or neither, and the root must be absolute', () => {
    it('is null when NEITHER key is set, which is what keeps the mode default-off', async () => {
      const { podVolumePvc } = await import('./pod-driver.js');
      expect(podVolumePvc()).toBeNull();
    });

    it('REFUSES half a configuration, naming the key that is missing', async () => {
      // Half a configuration is a config bug, not a mode. Answering null for it
      // would emit hostPath under a claim name the operator had already set —
      // the default-off scoping undone silently, in the one deployment that
      // cannot survive it.
      const { podVolumePvc } = await import('./pod-driver.js');
      process.env.NANOCLAW_POD_VOLUME_PVC = 'nanoclaw-tree';
      expect(() => podVolumePvc()).toThrow(/together; only NANOCLAW_POD_VOLUME_PVC is set/);

      delete process.env.NANOCLAW_POD_VOLUME_PVC;
      process.env.NANOCLAW_POD_VOLUME_ROOT = '/install';
      expect(() => podVolumePvc()).toThrow(/together; only NANOCLAW_POD_VOLUME_ROOT is set/);
    });

    it('refuses a relative root — every subPath is derived from it', async () => {
      const { podVolumePvc } = await import('./pod-driver.js');
      process.env.NANOCLAW_POD_VOLUME_PVC = 'nanoclaw-tree';
      process.env.NANOCLAW_POD_VOLUME_ROOT = 'host';
      expect(() => podVolumePvc()).toThrow(/NANOCLAW_POD_VOLUME_ROOT must be an absolute path, got 'host'/);
    });

    it('returns the trimmed claim and the normalized root when both are set', async () => {
      const { podVolumePvc } = await import('./pod-driver.js');
      process.env.NANOCLAW_POD_VOLUME_PVC = '  nanoclaw-tree  ';
      process.env.NANOCLAW_POD_VOLUME_ROOT = '/nanoclaw/host/../host';
      expect(podVolumePvc()).toEqual({ claimName: 'nanoclaw-tree', root: '/nanoclaw/host' });
    });
  });

  describe('default-off — the four node-process recipes', () => {
    it('composes exactly the hostPath volumes and mounts it always did', async () => {
      // The regression guard. Written as literals rather than a snapshot so a
      // change to this arm has to be argued for in a diff, not accepted with -u.
      const { volumeName } = await import('./pod-driver.js');
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: null });
      const pod = driver.composePod(fixtureSpec());

      expect(volumesOf(pod)).toEqual([
        // dev-shm is registered before any container is realized, so it leads
        // the map; the mount volumes follow in mount-depth order.
        { name: 'dev-shm', emptyDir: { medium: 'Memory', sizeLimit: '1024Mi' } },
        {
          name: volumeName('/install/data/v2-sessions/g1/s1'),
          hostPath: { path: '/install/data/v2-sessions/g1/s1', type: 'Directory' },
        },
        {
          name: volumeName('/install/container/agent-runner/src'),
          hostPath: { path: '/install/container/agent-runner/src', type: 'Directory' },
        },
        {
          name: volumeName('/install/container/CLAUDE.md'),
          hostPath: { path: '/install/container/CLAUDE.md', type: 'Directory' },
        },
        { name: 'agent-heartbeat', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
      ]);
      expect(agentOf(pod).volumeMounts).toEqual([
        { name: volumeName('/install/data/v2-sessions/g1/s1'), mountPath: '/workspace', readOnly: false },
        { name: volumeName('/install/container/agent-runner/src'), mountPath: '/app/src', readOnly: true },
        { name: volumeName('/install/container/CLAUDE.md'), mountPath: '/app/CLAUDE.md', readOnly: true },
        { name: 'dev-shm', mountPath: '/dev/shm' },
        { name: 'agent-heartbeat', mountPath: '/workspace/.heartbeat', subPath: '.heartbeat' },
      ]);
      expect(JSON.stringify(pod)).not.toContain('persistentVolumeClaim');
      expect(agentOf(pod).volumeMounts.filter((mount) => mount.name !== 'agent-heartbeat').every((mount) => !mount.subPath)).toBe(true);
    });

    it('an explicit null forces hostPath even when the environment selects a claim', async () => {
      // `opts.volumePvc !== undefined` is what makes null an OPT-OUT rather
      // than "unset". Written as `opts.volumePvc ?? podVolumePvc()` it would
      // collapse to the env instead, and every caller that passes null — the
      // regression guard above included — would silently be testing PVC mode.
      process.env.NANOCLAW_POD_VOLUME_PVC = 'nanoclaw-tree';
      process.env.NANOCLAW_POD_VOLUME_ROOT = '/install';
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: null });
      const pod = driver.composePod(fixtureSpec());

      expect(volumesOf(pod).filter((v) => v.persistentVolumeClaim)).toEqual([]);
      expect(volumesOf(pod).filter((v) => v.hostPath)).toHaveLength(3);
    });

    it('an unset environment is the same pod as an explicit opt-out', async () => {
      // `volumePvc: undefined` reads the env; `null` forces hostPath. On a node
      // -process host the two must be indistinguishable, or the mode is not
      // default-off at all — it is default-on for anyone who never passes it.
      const read = await pvcDriver();
      const forced = await pvcDriver({ volumePvc: null });
      expect(JSON.stringify(read.driver.composePod(read.fixtureSpec()))).toBe(
        JSON.stringify(forced.driver.composePod(forced.fixtureSpec())),
      );
    });
  });

  describe('claim mode — the pod-hosted host', () => {
    it('emits ONE claim volume, no hostPath at all, and a subPath per mount', async () => {
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: PVC });
      const pod = driver.composePod(fixtureSpec());

      expect(volumesOf(pod).filter((v) => v.persistentVolumeClaim)).toEqual([
        { name: 'nanoclaw-pvc', persistentVolumeClaim: { claimName: 'nanoclaw-tree' } },
      ]);
      // Not `.filter(v => v.hostPath).toEqual([])`: PSA baseline rejects the
      // pod if the string appears anywhere, including a container we forgot.
      expect(JSON.stringify(pod)).not.toContain('hostPath');
      // Only spec mounts move onto the claim; /dev/shm stays an emptyDir.
      expect(volumesOf(pod).find((v) => v.name === 'dev-shm')?.emptyDir).toBeDefined();

      expect(agentOf(pod).volumeMounts.filter((m) => m.name === 'nanoclaw-pvc')).toEqual([
        { name: 'nanoclaw-pvc', mountPath: '/workspace', subPath: 'data/v2-sessions/g1/s1', readOnly: false },
        { name: 'nanoclaw-pvc', mountPath: '/app/src', subPath: 'container/agent-runner/src', readOnly: true },
        { name: 'nanoclaw-pvc', mountPath: '/app/CLAUDE.md', subPath: 'container/CLAUDE.md', readOnly: true },
      ]);
    });

    it('mounts the claim root itself with NO subPath key — not an empty one', async () => {
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: PVC });
      const spec = fixtureSpec();
      spec.containers[0]!.mounts = [
        { class: 'group-state', hostPath: '/install', containerPath: '/workspace', mode: 'rw', groupScope: 'g1' },
      ];
      const mount = agentOf(driver.composePod(spec)).volumeMounts.find(
        (m) => m.name === 'nanoclaw-pvc',
      ) as VolumeMount;

      expect(mount).toEqual({ name: 'nanoclaw-pvc', mountPath: '/workspace', readOnly: false });
      // `subPath: undefined` survives toEqual; kubelet still sees the key.
      expect('subPath' in mount).toBe(false);
    });

    it('reads the mode from the environment when no option is injected', async () => {
      // The constructor wiring, not just the parser: a driver built the way the
      // host builds it must pick the mode up from the operator's environment.
      process.env.NANOCLAW_POD_VOLUME_PVC = 'nanoclaw-tree';
      process.env.NANOCLAW_POD_VOLUME_ROOT = '/install';
      const { driver, fixtureSpec } = await pvcDriver();
      const pod = driver.composePod(fixtureSpec());

      expect(volumesOf(pod).filter((v) => v.persistentVolumeClaim)).toHaveLength(1);
      expect(JSON.stringify(pod)).not.toContain('hostPath');
    });

    it('still refuses a source that is absent — the claim is mounted here too', async () => {
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: PVC, statHostPath: () => null });
      expect(() => driver.composePod(fixtureSpec())).toThrow(/mount source missing on node/);
    });
  });

  describe('the refusal', () => {
    it('REFUSES a source outside the claim root instead of falling back to hostPath', async () => {
      // This is the case the governed child hits: its two gateway CAs are
      // Secret-projected at /etc/nanoco/pki, outside the tree the claim backs,
      // and they are copied into the tree by an init container rather than
      // special-cased here. A fallback would emit the very PSA-baseline
      // violation this mode exists to make impossible — surfacing later as a
      // namespace admission denial that names no cause.
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: PVC });
      const spec = fixtureSpec();
      spec.containers.push({
        role: 'egress-sidecar',
        image: 'nanoco-session-sidecar:test',
        env: {},
        mounts: GATEWAY_CA_MOUNTS,
      });

      let thrown: unknown;
      try {
        driver.composePod(spec);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ kind: 'spec-invalid', retryable: false });
      expect(String((thrown as Error).message)).toContain('/etc/nanoco/pki/gateway-server-ca.pem');
      expect(String((thrown as Error).message)).toContain('/install');
      expect(String((thrown as Error).message)).toContain('outside the PVC volume root');
    });

    it('is PVC mode refusing, not the spec being invalid', async () => {
      // Without this half the case above would pass on any spec bug at all —
      // and a fallback arm that emitted hostPath for the CAs would still throw
      // somewhere later, for some other reason, and look caught.
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: null });
      const spec = fixtureSpec();
      spec.containers.push({
        role: 'egress-sidecar',
        image: 'nanoco-session-sidecar:test',
        env: {},
        mounts: GATEWAY_CA_MOUNTS,
      });
      const pod = driver.composePod(spec);

      expect(volumesOf(pod).map((v) => v.hostPath?.path)).toContain('/etc/nanoco/pki/gateway-server-ca.pem');
    });

    it('treats a string prefix that is not a path boundary as outside the root', async () => {
      const { driver, fixtureSpec } = await pvcDriver({ volumePvc: PVC });
      const spec = fixtureSpec();
      spec.containers[0]!.mounts = [
        { class: 'group-state', hostPath: '/installed/data', containerPath: '/workspace', mode: 'rw', groupScope: 'g1' },
      ];
      expect(() => driver.composePod(spec)).toThrow(/outside the PVC volume root/);
    });
  });

  it('carries the mount CLASS annotations identically in both arms', async () => {
    // The admission policy checks class + groupScope against the mount path, so
    // an arm that dropped these would deny every session on a pod-hosted host —
    // and the pod itself would look correct in every other respect.
    const expected = {
      'nanoclaw.dev/mount.agent.0': 'group-state:g1:/workspace:rw',
      'nanoclaw.dev/mount.agent.1': 'install-surface:g1:/app/src:ro',
      'nanoclaw.dev/mount.agent.2': 'install-surface:g1:/app/CLAUDE.md:ro',
    };
    const hostPathMode = await pvcDriver({ volumePvc: null });
    const claimMode = await pvcDriver({ volumePvc: PVC });

    expect(hostPathMode.driver.composePod(hostPathMode.fixtureSpec()).metadata.annotations).toEqual(expected);
    expect(claimMode.driver.composePod(claimMode.fixtureSpec()).metadata.annotations).toEqual(expected);
  });
});
