/**
 * The conformance floor — identical on every driver, forever.
 *
 * Every case here drives the same `SessionSpec` through a driver's realization
 * and asserts the same observable outcome. Where two drivers must differ, the
 * difference is a declared capability, never a branch on the driver's identity:
 * `if (driver === 'x')` above this seam is the thing this file exists to make
 * unnecessary.
 *
 * Only the Docker driver ships in this tree, so the harness list has one
 * entry; an out-of-tree driver adds its own harness and must pass every case
 * unchanged. The suite asserts spec-realization fidelity (including *absence*:
 * no secret env, no extra mounts), the mount-class rules, prepare idempotency,
 * adoption from labels alone, stop-is-full-teardown, and failure-taxonomy
 * mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerSessionDriver } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { withSessionEvents, type SessionEventsDriver } from './session-events.js';
import { FIXTURE_POLICY, fixtureSpec, fixtureSpecWithAux } from './spec-fixture.js';
import { GROUP_FOLDER_LABEL, LABELS, validateSpec, type SessionSpec } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The Docker realization re-checks that mount sources exist (a missing source
// would silently become a fresh empty directory); fixture paths are not real
// files on the test host.
vi.mock('fs', () => ({ default: { existsSync: (): boolean => true } }));

/**
 * What a driver realized, in vocabulary no runtime owns. This is the
 * translation layer that lets one assertion cover every driver.
 */
interface Realized {
  containers: Array<{
    role: string;
    image: string;
    env: Record<string, string>;
    mounts: Array<{ hostPath: string; containerPath: string; ro: boolean }>;
  }>;
  labels: Record<string, string>;
}

type Harness = {
  name: string;
  driver: SessionEventsDriver;
  cli: FakeCli;
  realize(spec: SessionSpec): Promise<Realized>;
  /** Make the next realization fail with a runtime message of the given shape. */
  failWith(message: string): void;
};

function dockerHarness(): Harness {
  const cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  // Wrapped exactly as `createSessionDriver` wraps it in production: the
  // conformance surface is the seam consumers see, and `onTerminal` lives in
  // the session-events hub, not in any driver.
  const driver = withSessionEvents(new DockerSessionDriver({ ...FIXTURE_POLICY, cli }));
  return {
    name: 'docker',
    driver,
    cli,
    async realize(spec) {
      await driver.prepare(spec);
      // The Docker realization refuses specs carrying auxiliary containers
      // (capabilities().auxiliaryContainers is false), so the one create per
      // prepare IS the whole session; read back what it emitted.
      const create = cli.callMatching(/^create /)!.args;
      const env: Record<string, string> = {};
      const mounts: Realized['containers'][number]['mounts'] = [];
      const labels: Record<string, string> = {};
      for (let i = 0; i < create.length; i++) {
        if (create[i] === '-e') {
          const eq = create[i + 1].indexOf('=');
          env[create[i + 1].slice(0, eq)] = create[i + 1].slice(eq + 1);
        }
        if (create[i] === '-v') {
          const parts = create[i + 1].split(':');
          mounts.push({ hostPath: parts[0], containerPath: parts[1], ro: parts[2] === 'ro' });
        }
        if (create[i] === '--label') {
          const eq = create[i + 1].indexOf('=');
          labels[create[i + 1].slice(0, eq)] = create[i + 1].slice(eq + 1);
        }
      }
      const agent = spec.containers.find((c) => c.role === 'agent')!;
      return { containers: [{ role: 'agent', image: agent.image, env, mounts }], labels };
    },
    failWith(message) {
      cli.responses = [
        { match: /^inspect /, throws: new Error('No such object') },
        { match: /^create /, throws: new Error(message) },
      ];
    },
  };
}

let harnesses: Harness[];
beforeEach(() => {
  vi.clearAllMocks();
  harnesses = [dockerHarness()];
});

/**
 * Watch events are hints: the hub re-reads truth asynchronously before it
 * fires `onTerminal`, so delivery lands a tick after the runtime's event.
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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

describe('conformance: spec realization fidelity', () => {
  eachDriver('realizes the agent image and env exactly as declared', async (h) => {
    const realized = await h.realize(fixtureSpec());
    const agent = realized.containers.find((c) => c.role === 'agent')!;

    expect(agent.image).toBe('nanoclaw-agent:spike-p0');
    // Declared env passes through byte-identical: composition keeps the last
    // word on what a session's environment is, and no driver may add to it.
    expect(agent.env).toEqual({ TZ: 'UTC', HTTPS_PROXY: 'http://127.0.0.1:15001' });
  });

  eachDriver('realizes every declared agent mount, with its mode, and no others', async (h) => {
    const realized = await h.realize(fixtureSpec());
    const agent = realized.containers.find((c) => c.role === 'agent')!;

    expect(agent.mounts).toEqual([
      { hostPath: '/install/data/v2-sessions/g1/s1', containerPath: '/workspace', ro: false },
      { hostPath: '/install/container/agent-runner/src', containerPath: '/app/src', ro: true },
      { hostPath: '/install/container/CLAUDE.md', containerPath: '/app/CLAUDE.md', ro: true },
    ]);
  });

  eachDriver('never places identity material in the agent container', async (h) => {
    const realized = await h.realize(fixtureSpec());
    const agent = realized.containers.find((c) => c.role === 'agent')!;

    expect(agent.mounts.some((m) => m.hostPath.includes('session-materials'))).toBe(false);
    expect(JSON.stringify(agent.env)).not.toContain('session-key');
  });

  eachDriver('stamps the four canonical labels', async (h) => {
    const realized = await h.realize(fixtureSpec());
    expect(realized.labels).toMatchObject({
      [LABELS.install]: 'spike',
      [LABELS.group]: 'g1',
      [LABELS.session]: 's1',
      [LABELS.role]: 'agent',
    });
  });

  eachDriver('carries the group-folder label byte-identical on every driver (D9)', async (h) => {
    // Admission joins `groups/<folder>` hostPaths against this value verbatim,
    // so any driver that mangles it (projection, truncation, case-folding)
    // breaks the policy for every session of the group.
    const realized = await h.realize(fixtureSpec());
    expect(realized.labels[GROUP_FOLDER_LABEL]).toBe('agent-one');
  });
});

describe('conformance: mount and env policy', () => {
  const rejections: Array<[string, (spec: SessionSpec) => void]> = [
    [
      'identity material on the agent role',
      (spec) =>
        spec.containers[0].mounts.push({
          class: 'identity-material',
          hostPath: '/install/data/session-materials/c/session-key.pem',
          containerPath: '/run/session/session-key.pem',
          mode: 'ro',
          groupScope: 'g1',
        }),
    ],
    [
      'a writable install surface',
      (spec) =>
        spec.containers[0].mounts.push({
          class: 'install-surface',
          hostPath: '/install/container/skills',
          containerPath: '/app/skills',
          mode: 'rw',
          groupScope: 'g1',
        }),
    ],
    [
      'group state belonging to another group',
      (spec) =>
        spec.containers[0].mounts.push({
          class: 'group-state',
          hostPath: '/install/data/v2-sessions/g2/s2',
          containerPath: '/workspace/other',
          mode: 'rw',
          groupScope: 'g1',
        }),
    ],
    ['a secret-shaped env key', (spec) => (spec.containers[0].env.SERVICE_TOKEN = 'shhh')],
  ];

  for (const [what, mutate] of rejections) {
    eachDriver(`rejects ${what} before allocating anything`, async (h) => {
      const spec = fixtureSpec();
      mutate(spec);
      await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy', retryable: false });
      expect(h.cli.calls.some((c) => c.args[0] === 'create' && !c.args.includes('--dry-run=server'))).toBe(false);
    });
  }
});

describe('conformance: the multi-container contract (validateSpec is the shared layer)', () => {
  // Multi-container specs are contract-legal; this tree's Docker realization
  // refuses to REALIZE them (the last case), so the validation rules over
  // auxiliary containers are asserted at the shared layer every driver runs
  // before allocating anything.
  it('accepts the overlay-composed auxiliary container, its identity material, and its trust anchor', () => {
    // The CA from outside the material root rides as an allowlisted extra:
    // same file, correct class — it verifies an upstream's server certificate,
    // carries no identity of ours, and is world-readable by design.
    expect(() => validateSpec(fixtureSpecWithAux(), FIXTURE_POLICY)).not.toThrow();
  });

  it('accepts a container path under a credential-named key (material passed by reference)', () => {
    // The invariant is that no credential VALUE rides in the environment. The
    // design passes material by reference — mount the file read-only, put its
    // path in an env var — so a key-name-only rule would deny every session
    // whose auxiliary containers need their own client key.
    const spec = fixtureSpecWithAux();
    spec.containers[1].env.PROXY_CLIENT_KEY = '/run/session/session-key.pem';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
  });

  it('refuses identity material that does not live under the material root', () => {
    // The shape that reached a live node: a file from the deployment's PKI
    // root wearing the class of the material root. The class must be refused
    // rather than trusted, because a driver that trusted it would mount an
    // unpinned host path as though it were provisioner-emitted.
    const spec = fixtureSpecWithAux();
    spec.containers[1].mounts.push({
      class: 'identity-material',
      hostPath: '/pki/other-ca.pem',
      containerPath: '/run/session/other-ca.pem',
      mode: 'ro',
      groupScope: 'g1',
    });
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/denied-by-policy/);
  });

  it('keeps every auxiliary mount out of the agent container', () => {
    // Which container holds a file is the mount list's job, not the class's —
    // the aux fixture's material never widens the agent's surface.
    const spec = fixtureSpecWithAux();
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    expect(agent.mounts.map((m) => m.containerPath).some((p) => p.startsWith('/run/session/'))).toBe(false);
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
  });

  eachDriver('a driver that does not manage auxiliary containers refuses the spec whole', async (h) => {
    // Never a silent subset: realizing only the agent would validate
    // containers that never exist — false semantics on a public contract.
    if (h.driver.capabilities().auxiliaryContainers) {
      await expect(h.driver.prepare(fixtureSpecWithAux())).resolves.toBeDefined();
      return;
    }
    await expect(h.driver.prepare(fixtureSpecWithAux())).rejects.toMatchObject({
      kind: 'spec-invalid',
      retryable: false,
    });
    expect(h.cli.calls.some((c) => c.args[0] === 'create')).toBe(false);
  });
});

describe('conformance: admission judges the path the runtime mounts', () => {
  eachDriver('refuses a mount whose path escapes its root lexically', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      // Prefix-passes under the groups root, normalizes into another group's
      // folder once the runtime resolves it.
      class: 'group-state',
      hostPath: '/install/groups/agent-one/../other-folder/CLAUDE.md',
      containerPath: '/workspace/escape',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver('refuses a relative hostPath (a named volume in Docker vocabulary, not a bind)', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: 'projects/thing',
      containerPath: '/workspace/extra/thing',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver("refuses another group's folder claimed as this session's group state", async (h) => {
    // The groups root holds EVERY group's folder; the folder label pins the
    // session to its own subtree. This exact mount was accepted before the pin.
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'group-state',
      hostPath: '/install/groups/other-folder/CLAUDE.md',
      containerPath: '/workspace/other-group',
      mode: 'ro',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver("still accepts this group's own folder as group state", async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'group-state',
      hostPath: '/install/groups/agent-one/CLAUDE.md',
      containerPath: '/workspace/group-claude.md',
      mode: 'ro',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).resolves.toBeDefined();
  });

  eachDriver('refuses two mounts claiming one containerPath', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: '/home/operator/projects/thing',
      containerPath: '/workspace',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'spec-invalid' });
  });

  eachDriver('refuses a spec without exactly one agent container', async (h) => {
    const zero = fixtureSpec();
    zero.containers = [];
    await expect(h.driver.prepare(zero)).rejects.toMatchObject({ kind: 'spec-invalid' });
    const two = fixtureSpec();
    two.containers = [...two.containers, { ...two.containers[0] }];
    await expect(h.driver.prepare(two)).rejects.toMatchObject({ kind: 'spec-invalid' });
  });
});

describe('conformance: the contributed-env lane (provenance as structure)', () => {
  eachDriver('accepts a credential-NAMED key on the contributed lane', async (h) => {
    // The lane exists for exactly this: a provider registers a bearer
    // placeholder for the gateway to overwrite on the wire. The value is not a
    // credential, and the name check alone would deny the install's every spawn.
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { ANTHROPIC_AUTH_TOKEN: 'placeholder' };
    const realized = await h.realize(spec);
    const agent = realized.containers.find((c) => c.role === 'agent')!;
    expect(agent.env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder');
  });

  eachDriver('the contributed lane wins a key collision with composed env', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { HTTPS_PROXY: 'http://gateway.internal:15001' };
    const realized = await h.realize(spec);
    const agent = realized.containers.find((c) => c.role === 'agent')!;
    expect(agent.env.HTTPS_PROXY).toBe('http://gateway.internal:15001');
  });

  eachDriver('still refuses a credential VALUE on the contributed lane', async (h) => {
    // The lane exempts names, never bytes: real material rides mounts by
    // reference, from every contributor.
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { UPSTREAM: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' };
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver(
    'the composed lane still refuses credential-shaped names — the lane is the exemption, not the install',
    async (h) => {
      const spec = fixtureSpec();
      spec.containers[0].env.SERVICE_TOKEN = 'placeholder';
      await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    },
  );
});

describe('conformance: a class that grants cannot be claimed by a path that has not earned it', () => {
  // Both of these were accepted before the path/class check existed, and both
  // are one word in a mount literal away from a correctly-composed spec.
  eachDriver('refuses a session private key relabelled as an allowlisted extra on the agent', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      // The no-credentials invariant is the seam's headline property, and
      // `allowlisted-extra` is permitted unconditionally — so without the path
      // check this mounts a private key into the agent and nothing objects.
      class: 'allowlisted-extra',
      hostPath: '/install/data/session-materials/channel-abc-XXXX/session-key.pem',
      containerPath: '/run/session/session-key.pem',
      mode: 'ro',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver('refuses a writable runner source relabelled as an allowlisted extra', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      // `install-surface` forces read-only; `allowlisted-extra` does not. This
      // is a writable mount of the code the agent executes.
      class: 'allowlisted-extra',
      hostPath: '/install/container/agent-runner/src',
      containerPath: '/app/src-rw',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver('accepts the stamped plugins tree as a read-only install surface', async (h) => {
    // `groups/<folder>/plugins` holds code the agent executes, stamped from a
    // validated plugin. It is an install surface living inside the group
    // folder, pinned by the group-folder label rather than by a surface root
    // (see `stampedPluginsRoot`) — the fixture's folder label is 'agent-one'.
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: '/install/groups/agent-one/plugins',
      containerPath: '/workspace/agent/plugins',
      mode: 'ro',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).resolves.toBeDefined();
  });

  eachDriver('refuses a writable stamped plugins tree', async (h) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: '/install/groups/agent-one/plugins',
      containerPath: '/workspace/agent/plugins',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver('refuses a stamped plugins tree relabelled as an allowlisted extra', async (h) => {
    // The relabel that matters most here: `allowlisted-extra` is permitted
    // unconditionally and carries no read-only rule, so without the path pin
    // this is a writable mount of executed plugin code.
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: '/install/groups/agent-one/plugins',
      containerPath: '/workspace/agent/plugins',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver("refuses another group's plugins tree claimed as this session's install surface", async (h) => {
    // The pin is joined through the folder label, so it grants exactly one
    // group's plugins subtree — not every group's.
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: '/install/groups/some-other-group/plugins',
      containerPath: '/workspace/agent/plugins',
      mode: 'ro',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  eachDriver('still accepts an operator-configured read-write mount outside those roots', async (h) => {
    // The rule must not swallow the mount-allowlist feature, whose whole point
    // is arbitrary vetted host paths, sometimes writable.
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: '/home/operator/projects/thing',
      containerPath: '/workspace/extra/thing',
      mode: 'rw',
      groupScope: 'g1',
    });
    await expect(h.driver.prepare(spec)).resolves.toBeDefined();
  });
});

describe('conformance: the no-secrets rule measures values, not names', () => {
  // The name check alone catches `..._TOKEN` and misses the identical
  // credential under any other name. An attacker or a careless composer picks
  // the name, so the name is the wrong thing to measure.
  const leaks: Array<[string, string]> = [
    ['ANTHROPIC_AUTH', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'],
    ['GW_CRED', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['SESSION_BEARER', 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.c2ln'],
    ['INLINE', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n'],
  ];
  for (const [key, value] of leaks) {
    eachDriver(`refuses a credential in ${key}, whatever the key is called`, async (h) => {
      const spec = fixtureSpec();
      spec.containers[0].env[key] = value;
      await expect(h.driver.prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    });
  }

  // The other half, and the one that matters more operationally: a false
  // positive here does not warn, it denies every session at once. These are
  // all values a real spec carries — material passed by reference is
  // credential-NAMED on purpose and must stay exempt while `sk-`-anything
  // stays denied.
  const legitimate: Array<[string, string]> = [
    ['PROXY_CLIENT_KEY', '/run/session/session-key.pem'],
    ['NODE_EXTRA_CA_CERTS', '/run/session/proxy-ca.pem'],
    ['HTTPS_PROXY', 'http://127.0.0.1:15001'],
    ['TZ', 'Europe/London'],
    ['PROXY_UPSTREAM_ADDR', 'egress.internal:9443'],
    ['CONTAINER_IMAGE_DIGEST', 'sha256:9624d7f2e0b1c3a45566778899aabbccddeeff00112233445566778899aabbcc'],
    ['SESSION_ID', 'a1b2c3d4-5566-7788-99aa-bbccddeeff00'],
  ];
  for (const [key, value] of legitimate) {
    eachDriver(`accepts ${key}, which is configuration and not a credential`, async (h) => {
      const spec = fixtureSpec();
      spec.containers[0].env[key] = value;
      await expect(h.driver.prepare(spec)).resolves.toBeDefined();
    });
  }
});

describe('conformance: failure taxonomy', () => {
  eachDriver('maps a missing image to image-unavailable', async (h) => {
    h.failWith('manifest unknown');
    await expect(h.driver.prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'image-unavailable', retryable: true });
  });

  eachDriver('maps an unreachable runtime to runtime-unavailable', async (h) => {
    h.failWith('Cannot connect to the Docker daemon');
    await expect(h.driver.prepare(fixtureSpec())).rejects.toMatchObject({
      kind: 'runtime-unavailable',
      retryable: true,
    });
  });

  eachDriver('never lets a raw runtime error cross the seam', async (h) => {
    h.failWith('/install/data/session-materials/c/session-key.pem: permission denied');
    await expect(h.driver.prepare(fixtureSpec())).rejects.toThrow(/^session realization failed: /);
  });
});

describe('conformance: lifecycle', () => {
  eachDriver('prepare is idempotent on key', async (h) => {
    // An existing live session for this key IS the session — this is also how
    // adoption works.
    h.cli.responses = [{ match: /^inspect /, output: 'spike|g1|s1\n' }];

    const first = await h.driver.prepare(fixtureSpec());
    const second = await h.driver.prepare(fixtureSpec());

    expect(first.key).toEqual(second.key);
    expect(first.name).toBe(second.name);
    expect(h.cli.calls.some((c) => c.args[0] === 'create')).toBe(false);
  });

  eachDriver('fires at most one terminal event, however many hints the stream carries', async (h) => {
    // Watch streams duplicate and replay (watch transports re-send existing
    // state on reconnect; docker events double up) — the hub re-reads truth
    // and delivers at most once per incarnation.
    const handle = await h.driver.prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();

    const proc = h.cli.started.at(-1)!.proc;
    proc.emitExit(1);
    proc.emitExit(1);
    await settled();

    expect(terminal).toHaveBeenCalledOnce();
  });

  eachDriver('stop is full teardown and reports no terminal event', async (h) => {
    // The driver still emits the end it observes — suppression is the hub's,
    // keyed on the stop() intent it saw through the handle. Note (contract):
    // that stop() blocks until the runtime object is gone is an implementation
    // behavior of today's drivers, NOT a guarantee — callers must not rely on
    // blocking-until-gone.
    const handle = await h.driver.prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();
    await handle.stop('host-shutdown');
    h.cli.started.at(-1)!.proc.emitExit(137);
    await settled();

    expect(terminal).not.toHaveBeenCalled();
    const issued = h.cli.joined().join(' | ');
    // Whatever the runtime calls it, nothing this key allocated may survive.
    expect(issued).toMatch(/rm --force ncl-spike-s1/);
  });

  eachDriver('reconstructs adopted handles from labels alone', async (h) => {
    h.cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\n' }];

    const snapshots = await h.driver.listSessions('spike');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].handle.key).toEqual({ installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' });
    expect(snapshots[0].phase).toBe('running');
  });

  eachDriver('lists corpses honestly: a self-exited runtime is terminal, never dressed up as live', async (h) => {
    // Fix 2's pinned behavior: adoption must tell adoptable sessions from
    // corpses (and from prepared-not-started incarnations) WITHOUT a
    // per-handle status() round trip.
    h.cli.responses = [
      {
        match: /^ps -a/,
        output: 'ncl-spike-s1|running|g1|s1\nncl-spike-s2|exited|g2|s2\nncl-spike-s3|created|g3|s3\n',
      },
    ];

    const snapshots = await h.driver.listSessions('spike');

    expect(snapshots.map((s) => [s.handle.key.sessionId, s.phase])).toEqual([
      ['s1', 'running'],
      ['s2', 'terminal'],
      ['s3', 'starting'],
    ]);
  });
});

describe('conformance: capabilities are honest', () => {
  eachDriver('declares what it cannot realize', (h) => {
    const capabilities = h.driver.capabilities();
    expect(capabilities.isolationTiers).toContain('container');
    expect(capabilities.unrealized).toEqual([]);
    expect(capabilities.admissionEnforced).toBe(false);
    expect(capabilities.networkPolicy).toBe('topology');
    expect(capabilities.sharedNetworkNamespace).toBe(false);
    // Realizes the agent container only — and refuses, never drops, the rest.
    expect(capabilities.auxiliaryContainers).toBe(false);
    // The session daemon doubles as the build daemon: rebuild-in-place works.
    expect(capabilities.imageBuild).toBe(true);
  });
});
