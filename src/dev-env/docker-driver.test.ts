/**
 * The docker dev-env driver against a fake daemon.
 *
 * The conformance suite proves this driver clears the seam's floor. This one
 * proves the things that are TRUE OF DOCKER and of nothing else: the daemon
 * socket clamp, the `--internal` egress clamp, the never-pull clamp, the C16
 * bind mount, the imperative claimant attach and its respawn obligation, and
 * the teardown ORDER a network's refusal to die with members makes
 * load-bearing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROBE_IMAGE,
  DockerDevEnvDriver,
  envNetworkName,
  stampContainerName,
} from './docker-driver.js';
import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';

import { FakeDocker } from './docker-fake.js';
import { DEV_TREE_OPTION } from './dev-tree.js';
import { EnvExposureService } from './exposure-service.js';
import type { ExposureBinding, ExposureDraft, ExposureGrant, ExposureProvider } from './exposure-provider.js';
// Side-effect: registers the dev-env migrations, so runMigrations' default
// list covers env_exposures — the house archetype (see exposure.test.ts).
import './index.js';
import { DevEnvService } from './service.js';
import { BUILTIN_STAMPS, type K8sStampConfig } from './stamps.js';
import {
  DEV_ENV_LABELS,
  HOST_OWNER_REF,
  claimantGroupSelector,
  devEnvLabels,
  type DevEnvInstanceHandle,
  type DriverClaimSpec,
  type EnvKey,
} from './types.js';

const INSTALL = 'docker-suite';
const GROUP = 'g1';
const AGENT = 'ncl-docker-suite-s1';

/** The claimant's labels, as the SESSION docker driver stamps them (labelsForKey). */
const AGENT_LABELS = {
  'nanoclaw-install': INSTALL,
  'nanoclaw-group': GROUP,
  'nanoclaw-session': 's1',
  'nanoclaw-role': 'agent',
};

const APP_STAMP = BUILTIN_STAMPS['sample-app'];

let fake: FakeDocker;
let treeDir: string;

beforeEach(() => {
  fake = new FakeDocker();
  treeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-docker-tree-'));
});

afterEach(() => {
  fs.rmSync(treeDir, { recursive: true, force: true });
});

function makeDriver(overrides: Partial<ConstructorParameters<typeof DockerDevEnvDriver>[0]> = {}): DockerDevEnvDriver {
  return new DockerDevEnvDriver({
    installScope: INSTALL,
    cli: fake,
    stamps: { 'sample-app': APP_STAMP },
    probeIntervalMs: 5,
    // The host whose kernel holds the daemon's bridges — pinned so the suite
    // reads the same on a laptop as it does in CI. It decides exactly one
    // thing (whether an exposure can be dialed at all) and the block that
    // cares overrides it.
    hostPlatform: 'linux',
    ...overrides,
  });
}

let n = 0;
function freshKey(): EnvKey {
  n += 1;
  return { envId: `env-${n}`, instanceId: `ins-${n}` };
}

function claimSpec(key: EnvKey, extra: Partial<DriverClaimSpec> = {}): DriverClaimSpec {
  return {
    key,
    stampId: 'sample-app',
    labels: devEnvLabels(INSTALL, key, 'sample-app'),
    options: {},
    materialsScope: GROUP,
    ...extra,
  };
}

/** The claim the service actually issues: an owner, therefore a claimant selector. */
function claimedByGroup(key: EnvKey, ownerRef = GROUP, options: Record<string, string> = {}): DriverClaimSpec {
  return claimSpec(key, { options, claimantSelector: claimantGroupSelector(INSTALL, ownerRef) });
}

describe('the daemon socket clamp — the whole security posture', () => {
  it('never asks for the socket, privilege, or the host netns, on any path', async () => {
    fake.seedContainer(AGENT, AGENT_LABELS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    await handle.status();
    await driver.listInstances(INSTALL);
    await driver.reapResidue(INSTALL);
    // The C14 answer is on this path too: resolving an exposure target must
    // stay a HOST-side read, on the host's socket, like every other verb.
    await handle.resolveExposureTarget!({ port: APP_STAMP.app!.port });
    await handle.release('done');

    for (const argv of fake.joined()) {
      expect(argv).not.toMatch(/docker\.sock|\/var\/run|\/run\/docker/);
      // `--cap-add` is not banned outright — one capability comes back, and
      // only for a stamp whose own declared port needs it (see the low-port
      // test below). What must never appear is any OTHER capability, or the
      // family of flags that spends the boundary wholesale.
      expect(argv).not.toMatch(/--privileged|--cap-add(?!=NET_BIND_SERVICE\b)|--network host|--pid host|--userns/);
      expect(argv).not.toMatch(/--device/);
      // `--security-opt` is not banned — it is REQUIRED, and only ever for
      // no-new-privileges. What must never appear is the family that spends
      // it in the other direction.
      expect(argv).not.toMatch(/--security-opt (seccomp|apparmor|label|systempaths)/);
    }
  });

  it('hardens every container it creates with the posture this repo already applies on this daemon', async () => {
    // NOT a new posture: the session driver's `hardeningArgs` puts exactly
    // these on every agent container on the same daemon, and on a SHARED
    // daemon they are the whole isolation story — an env container that can
    // gain a capability or fork without bound is a hole in the host.
    const driver = makeDriver({ pidsLimit: 2048 });
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId); // drives a prober run too

    const created = fake.joined().filter((argv) => argv.startsWith('create ') || argv.startsWith('run '));
    expect(created.length).toBeGreaterThan(1); // the workload AND the prober
    for (const argv of created) {
      expect(argv).toContain('--cap-drop=ALL');
      expect(argv).toContain('--security-opt no-new-privileges');
      expect(argv).toContain('--init');
      expect(argv).toContain('--pids-limit 2048');
    }
  });

  it('omits the pid cap rather than passing zero — cgroups v2 rejects it and kills the create', async () => {
    const driver = makeDriver({ pidsLimit: 0 });
    await driver.claim(claimedByGroup(freshKey()));

    const created = fake.joined().filter((argv) => argv.startsWith('create '));
    expect(created).toHaveLength(1);
    expect(created[0]).not.toContain('--pids-limit');
    expect(created[0]).toContain('--cap-drop=ALL');
  });

  it('gives back the ONE capability a stamp declaring a privileged port needs', async () => {
    // The posture was copied from the AGENT container's role, which never
    // binds below 1024. An arbitrary stamp does — the platform's own
    // acceptance stamp is whoami on port 80 — and a blanket `--cap-drop=ALL`
    // turns that declaration into an EACCES inside an image whose author never
    // reads this driver. So the capability the declaration requires comes
    // back, and nothing else does.
    const driver = makeDriver({ stamps: { 'sample-app': { app: { ...APP_STAMP.app!, port: 80 } } } });
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    const workload = fake.joined().find((argv) => argv.startsWith('create '))!;
    expect(workload).toContain('--cap-drop=ALL');
    expect(workload).toContain('--cap-add=NET_BIND_SERVICE');
    // The prober connects; it never binds. It asks for nothing back.
    const prober = fake.joined().find((argv) => argv.startsWith('run '))!;
    expect(prober).toContain('--cap-drop=ALL');
    expect(prober).not.toContain('--cap-add');
  });

  it('and gives it to nobody else: a stamp on an unprivileged port keeps the whole drop', async () => {
    const driver = makeDriver(); // sample-app serves 8080
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    const created = fake.joined().filter((argv) => argv.startsWith('create ') || argv.startsWith('run '));
    expect(created.length).toBeGreaterThan(1);
    for (const argv of created) expect(argv).not.toContain('--cap-add');
  });

  it('does exactly ONE thing to the claimant container: connects it to the env network', async () => {
    // The agent gets L3 membership of one internal network and nothing else.
    // No exec, no mount change, no restart, no inspect of its config — the
    // driver's whole vocabulary against a container it does not own is
    // `network connect` and, at teardown, `network disconnect`.
    fake.seedContainer(AGENT, AGENT_LABELS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));

    const touchingAgent = fake.joined().filter((argv) => argv.includes(AGENT));
    expect(touchingAgent).toEqual([`network connect ${envNetworkName(key.instanceId)} ${AGENT}`]);

    await handle.release('done');
    expect(fake.joined().filter((argv) => argv.includes(AGENT))).toEqual([
      `network connect ${envNetworkName(key.instanceId)} ${AGENT}`,
      `network disconnect -f ${envNetworkName(key.instanceId)} ${AGENT}`,
    ]);
    // And the container itself is untouched: same mounts, same env, still running.
    const agent = fake.containers.get(AGENT)!;
    expect(agent.binds).toEqual([]);
    expect(agent.env).toEqual({});
    expect(agent.state).toBe('running');
  });
});

describe('the --internal clamp — attaching a claimant is an egress decision', () => {
  it('every env network is internal, and there is no configuration that makes one routable', async () => {
    const driver = makeDriver();
    await driver.claim(claimedByGroup(freshKey()));

    const creates = fake.joined().filter((argv) => argv.startsWith('network create'));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('--internal');
    expect([...fake.networks.values()].every((network) => network.internal)).toBe(true);
  });
});

describe('the C15 clamp — placed means present, and a claim never pulls', () => {
  it('declares imagePull false and says why in one place', () => {
    const capabilities = makeDriver().capabilities();
    expect(capabilities.imagePull).toBe(false);
    expect(capabilities.imageBuild).toBe(false);
    // The two capability answers that are TRUE here and were predicted false
    // by the seam's own comment before this driver existed.
    expect(capabilities.sealedEgress).toBe(true);
    // The isolation string carries BOTH halves, because an operator reads it
    // in the boot log and half of it is a lie by omission either way: what the
    // boundary is made of, and what a shared daemon is not.
    expect(capabilities.isolation).toContain('container/shared-daemon');
    expect(capabilities.isolation).toContain('cap-drop=ALL');
    expect(capabilities.isolation).toContain('no-new-privileges');
    expect(capabilities.isolation).toMatch(/NOT a kernel, daemon or user-namespace boundary/);
  });

  it('names the pid cap only when there IS one — a diagnostic string may not claim a clamp nobody applied', () => {
    expect(makeDriver({ pidsLimit: 2048 }).capabilities().isolation).toContain('pid cap 2048');
    // Blank, zero or garbage means uncapped: `hardeningArgs` omits the flag,
    // so the sentence has to omit the claim.
    expect(makeDriver({ pidsLimit: 0 }).capabilities().isolation).not.toContain('pid cap');
  });

  it('puts --pull=never on every container it ever starts', async () => {
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId); // drives a prober run too

    const starts = fake.joined().filter((argv) => argv.startsWith('create ') || argv.startsWith('run '));
    expect(starts.length).toBeGreaterThan(1);
    for (const argv of starts) expect(argv).toContain('--pull=never');
  });

  it('refuses an absent image in seconds, naming the one command that fixes it — and allocates nothing', async () => {
    fake.images.delete(APP_STAMP.app!.image);
    const driver = makeDriver();

    await expect(driver.claim(claimedByGroup(freshKey()))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining(`docker pull ${APP_STAMP.app!.image}`),
    });
    expect(fake.networks.size).toBe(0);
    expect(fake.joined().some((argv) => argv.startsWith('network create'))).toBe(false);
  });

  it('probeImage answers the store truthfully — the one C15 question docker answers better than k8s', async () => {
    const driver = makeDriver();
    await expect(driver.probeImage(APP_STAMP.app!.image)).resolves.toBe(true);
    await expect(driver.probeImage('mirror.gcr.io/library/nothing:1')).resolves.toBe(false);
  });

  it('the readiness prober rides the ref the builtin app stamp already requires', () => {
    // Pinned so a bundle re-render that moves the alpine ref fails HERE
    // rather than at probe time on a developer's laptop: an install that can
    // claim the builtin must already be able to probe it.
    expect(DEFAULT_PROBE_IMAGE).toBe(APP_STAMP.app!.image);
  });

  it('refuses a port-bearing claim when the prober image is missing, rather than timing out its boot', async () => {
    const driver = makeDriver({ probeImage: 'mirror.gcr.io/library/absent:1' });

    await expect(driver.claim(claimedByGroup(freshKey()))).rejects.toMatchObject({
      kind: 'instantiation-failed',
      retryable: false,
      detail: expect.stringContaining('readiness prober image'),
    });
    expect(fake.networks.size).toBe(0);
  });
});

describe('readiness is a probe, never "the container is running"', () => {
  it('a started-but-silent container is provisioning, not ready', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));

    // The container is running — the daemon says so — and the port answers
    // nothing. That is the half-warm slot the one-readiness-definition rule
    // exists to prevent.
    expect(fake.workloadsOf(key.instanceId)[0].state).toBe('running');
    expect((await handle.status()).phase).toBe('provisioning');

    fake.completeBoot(key.instanceId);
    expect((await handle.status()).phase).toBe('ready');
  });

  it('the probe runs INSIDE the env network and targets the stamp container by name', async () => {
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    const probe = fake.joined().find((argv) => argv.includes('/bin/busybox nc -z'));
    expect(probe).toContain(`--network ${envNetworkName(key.instanceId)}`);
    expect(probe).toContain(`${stampContainerName(key.instanceId, 'sample-app')} ${APP_STAMP.app!.port}`);
  });

  it('a scope-only env is ready the moment its scope exists — the ONE shape that honestly needs no probe', async () => {
    const driver = makeDriver({ stamps: { scope: {} } });
    const key = freshKey();
    const handle = await driver.claim(
      claimSpec(key, {
        stampId: 'scope',
        labels: devEnvLabels(INSTALL, key, 'scope'),
        claimantSelector: claimantGroupSelector(INSTALL, GROUP),
      }),
    );

    const status = await handle.status();
    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    expect(status.endpoints).toEqual({ network: envNetworkName(key.instanceId) });
    // Nothing was probed, because the claim declared nothing to answer.
    expect(fake.joined().some((argv) => argv.includes('/bin/busybox nc -z'))).toBe(false);
  });

  it('an env whose declared workload is GONE is not ready — never-fake-success beats every shortcut', async () => {
    // The container a claim declared has been `docker rm`'d out from under
    // the host (or a dying host never created it). An empty workload list
    // makes `every()` vacuously true, and the old shortcut then answered
    // "ready" for an env with nothing in it at all. A claim that reports
    // active and answers nothing is worse than one that fails.
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    expect((await handle.status()).phase).toBe('ready');

    // A fresh host adopts it — the ever-ready latch is per-handle, so this is
    // the probe that has to be honest.
    fake.severEvents();
    fake.containers.delete(stampContainerName(key.instanceId, 'sample-app'));
    const [adopted] = await makeDriver().listInstances(INSTALL);

    expect((await adopted.status()).phase).toBe('provisioning');
  });

  it('an env that SERVED and then lost its container FAILS — the latch may not outlive the container', async () => {
    // The same vacuous-`every()` hole, one method down: `status` skipped its
    // failure branch for an empty workload list, and the ever-ready latch then
    // answered `ready` for an env with nothing in it at all. Nothing else can
    // catch this — a `docker rm` by an operator emits a destroy the driver may
    // have missed, which is exactly why the READ has to be honest on its own.
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    expect((await handle.status()).phase).toBe('ready'); // latched

    fake.containers.delete(stampContainerName(key.instanceId, 'sample-app'));

    expect(await handle.status()).toMatchObject({ phase: 'failed', failure: { kind: 'instance-died' } });
  });

  it('a workload that started and never answered its port reports "never served", not "it died"', async () => {
    // `settleReady` reaches the start event BEFORE it probes anything, so
    // recording that event as evidence the env served turned every silent boot
    // into "instance-died" — the wrong sentence for whoever has to fix it.
    // Only a probe that came back is evidence, and the claim below starts the
    // container (and fires the event) without one ever coming back.
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    fake.failBoot(key.instanceId);

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({
      kind: 'instantiation-failed',
      detail: expect.stringContaining('before it ever served'),
    });
  });

  it('a RETIRED stamp does not turn readiness into a shrug — the port is on the network, not the table', async () => {
    // Retirement's contract is that live envs keep running, so the stamp table
    // can stop resolving under a perfectly alive env. Readiness read from the
    // table would go from "probe it" to "assume it", which is the same fake
    // success by a slower road; the claim's port is written on the network at
    // create precisely so the answer survives its stamp.
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.severEvents();

    // The new host knows no stamps at all — the coldest possible registry.
    const amnesiac = makeDriver({ stamps: {} });
    const [adopted] = await amnesiac.listInstances(INSTALL);
    expect((await adopted.status()).phase).toBe('provisioning');

    fake.completeBoot(key.instanceId);
    const status = await adopted.status();
    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    // And the address it reports comes from the same declared port, so a ready
    // env's endpoints cannot change shape under its stamp's retirement.
    expect(status.endpoints.app).toBe(
      `http://${stampContainerName(key.instanceId, 'sample-app')}:${APP_STAMP.app!.port}`,
    );
  });

  it('endpoints name the network AND the app address; access is empty because nothing is minted', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    const status = await handle.status();
    if (status.phase !== 'ready') throw new Error(`expected ready, got ${status.phase}`);
    expect(status.endpoints).toEqual({
      network: envNetworkName(key.instanceId),
      app: `http://${stampContainerName(key.instanceId, 'sample-app')}:${APP_STAMP.app!.port}`,
    });
    // No child kubeconfig analogue exists that does not hand over the daemon.
    expect(status.access).toEqual({});
  });
});

describe('the claimant attach (D19), imperative dialect', () => {
  it('attaches every container wearing the claim selector, and nothing else', async () => {
    fake.seedContainer(AGENT, AGENT_LABELS);
    fake.seedContainer('other-group-agent', { ...AGENT_LABELS, 'nanoclaw-group': 'g2', 'nanoclaw-session': 's2' });
    fake.seedContainer('someones-postgres', {});
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key));

    expect([...fake.networkOf(key.instanceId)!.members]).toEqual([
      stampContainerName(key.instanceId, 'sample-app'),
      AGENT,
    ]);
  });

  it('a HOST claim attaches nobody — the sentinel ownerRef is the fail-closed direction', async () => {
    // The selector rides every claim now, so what keeps a host claim from
    // opening reachability is that `operator` is a group id no group can be
    // created under: it matches no container, anywhere.
    fake.seedContainer(AGENT, AGENT_LABELS);
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key, HOST_OWNER_REF));

    expect([...fake.networkOf(key.instanceId)!.members]).toEqual([
      stampContainerName(key.instanceId, 'sample-app'),
    ]);
  });

  it('re-attaches a RESPAWNED session — the obligation docker creates and label selectors do not', async () => {
    // A NetworkPolicy keyed on labels covers the replacement pod for free.
    // Network membership is per-container and imperative, so a respawned
    // session is a member of nothing until the driver puts it back.
    fake.seedContainer(AGENT, AGENT_LABELS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    expect(handle).toBeDefined();

    fake.containers.delete(AGENT);
    fake.networkOf(key.instanceId)!.members.delete(AGENT);
    fake.respawnContainer('ncl-docker-suite-s2', { ...AGENT_LABELS, 'nanoclaw-session': 's2' });

    expect(fake.networkOf(key.instanceId)!.members.has('ncl-docker-suite-s2')).toBe(true);
  });

  it('resume re-attaches after a HOST restart, when the events stream was not there to see it', async () => {
    fake.seedContainer(AGENT, AGENT_LABELS);
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.severEvents();

    // The session respawned while the host was down: a new container, and
    // nothing observed it.
    fake.containers.delete(AGENT);
    fake.networkOf(key.instanceId)!.members.delete(AGENT);
    fake.seedContainer('ncl-docker-suite-s3', { ...AGENT_LABELS, 'nanoclaw-session': 's3' });

    await makeDriver().resumeClaim(claimedByGroup(key));

    expect(fake.networkOf(key.instanceId)!.members.has('ncl-docker-suite-s3')).toBe(true);
  });

  it('an adopted claim re-attaches from the RUNTIME alone — the selector is on the network', async () => {
    // Nothing process-local survives a restart, so the selector has to be
    // readable off the network, which is why it is written as labels at
    // create (the only moment docker labels can be written).
    const driver = makeDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    fake.severEvents();
    fake.seedContainer(AGENT, AGENT_LABELS);

    // resumeClaim, but with a spec that carries NO selector — exactly what a
    // driver-level replay from runtime state looks like.
    await makeDriver().resumeClaim(claimSpec(key));

    expect(fake.networkOf(key.instanceId)!.members.has(AGENT)).toBe(true);
  });
});

describe('teardown (D10): a network is a name, not a containment boundary', () => {
  it('removes our containers, disconnects everyone else, THEN removes the network', async () => {
    // The daemon refuses to remove a network with active endpoints, so the
    // order is the behaviour — reversing it leaks the network forever.
    fake.seedContainer(AGENT, AGENT_LABELS);
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    const before = fake.joined().length;
    await handle.release('done');

    const network = envNetworkName(key.instanceId);
    const teardown = fake.joined().slice(before);
    expect(teardown).toContain(`rm --force ${stampContainerName(key.instanceId, 'sample-app')}`);
    expect(teardown.indexOf(`network disconnect -f ${network} ${AGENT}`)).toBeLessThan(
      teardown.indexOf(`network rm ${network}`),
    );
    // And the membership read that DECIDES the disconnects comes after our own
    // containers are gone, never from a snapshot taken before them: a member
    // this driver never saw is a member it never disconnects.
    expect(teardown.indexOf(`rm --force ${stampContainerName(key.instanceId, 'sample-app')}`)).toBeLessThan(
      teardown.indexOf(`network inspect --format {{json .}} ${network}`),
    );
    expect(fake.networks.size).toBe(0);
    expect(fake.containers.has(AGENT)).toBe(true); // the agent survives its env
  });

  it('re-reads membership when the daemon refuses, so a network cannot be leaked by a late attach', async () => {
    // The daemon refuses to remove a network with active endpoints, and a
    // refused removal is a PERMANENT leak: `reapResidue` deliberately skips an
    // env with no workloads, so nothing ever comes back for it. Its own
    // re-attach cannot cause this (`Cli.run` is synchronous, so the events
    // callback never interleaves with a teardown), but an operator's
    // `docker network connect` can — and the daemon's refusal is the only
    // honest detector, so teardown answers it with a second pass.
    fake.seedContainer(AGENT, AGENT_LABELS);
    fake.seedContainer('someones-debug-shell', {});
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    fake.attachOnNextRemove(envNetworkName(key.instanceId), 'someones-debug-shell');
    await handle.release('done');

    expect(fake.networks.size).toBe(0);
    expect(fake.containers.has('someones-debug-shell')).toBe(true); // disconnected, never removed
  });

  it('reaps a corpse env but leaves a scope-only env alone', async () => {
    const driver = makeDriver({ stamps: { 'sample-app': APP_STAMP, scope: {} } });
    const dead = freshKey();
    const bare = freshKey();
    await driver.claim(claimedByGroup(dead));
    await driver.claim(claimSpec(bare, { stampId: 'scope', labels: devEnvLabels(INSTALL, bare, 'scope') }));
    fake.failBoot(dead.instanceId);

    await makeDriver({ stamps: { 'sample-app': APP_STAMP, scope: {} } }).reapResidue(INSTALL);

    expect(fake.holds(dead.instanceId)).toBe(false);
    // Nothing died in a scope-only env because nothing was ever there to die;
    // whether that env is still wanted is the registry's question, not this
    // sweep's.
    expect(fake.holds(bare.instanceId)).toBe(true);
  });
});

describe('the C16 dev declaration — on docker it is a bind mount', () => {
  const DEV_STAMP: K8sStampConfig = {
    app: { ...APP_STAMP.app!, env: { BAKED: '1' } },
    dev: {
      mountPath: '/src',
      command: ['/bin/busybox', 'sh', '-c', 'run-from-tree'],
      env: { DEV: '1' },
      reload: { kind: 'none' },
    },
  };

  function devDriver(): DockerDevEnvDriver {
    return makeDriver({ stamps: { 'sample-app': DEV_STAMP } });
  }

  it('mounts the tree and runs as its owner — the whole of what k8s needs a static PV for', async () => {
    const driver = devDriver();
    const key = freshKey();
    await driver.claim(claimedByGroup(key, GROUP, { [DEV_TREE_OPTION]: treeDir }));

    const container = fake.containers.get(stampContainerName(key.instanceId, 'sample-app'))!;
    expect(container.binds).toEqual([{ hostPath: treeDir, containerPath: '/src' }]);
    const stat = fs.statSync(treeDir);
    expect(container.user).toBe(`${stat.uid}:${stat.gid}`);
    // The declared overrides land: run from the tree, not from the artifact.
    expect(container.command).toEqual(['/bin/busybox', 'sh', '-c', 'run-from-tree']);
    expect(container.env).toEqual({ BAKED: '1', DEV: '1' });
  });

  it('refuses a stamp with no dev block, a relative path, and a path that is not a directory', async () => {
    const plain = makeDriver();
    await expect(
      plain.claim(claimedByGroup(freshKey(), GROUP, { [DEV_TREE_OPTION]: treeDir })),
    ).rejects.toMatchObject({ kind: 'instantiation-failed', detail: expect.stringContaining('no dev block') });

    const driver = devDriver();
    await expect(
      driver.claim(claimedByGroup(freshKey(), GROUP, { [DEV_TREE_OPTION]: 'relative/tree' })),
    ).rejects.toMatchObject({ kind: 'instantiation-failed', retryable: false });

    const file = path.join(treeDir, 'a-file');
    fs.writeFileSync(file, 'x');
    await expect(
      driver.claim(claimedByGroup(freshKey(), GROUP, { [DEV_TREE_OPTION]: file })),
    ).rejects.toMatchObject({ kind: 'instantiation-failed', retryable: false });
    expect(fake.networks.size).toBe(0);
  });

  it('refuses a SECOND live claim on the same tree — one tree, one writer', async () => {
    const driver = devDriver();
    await driver.claim(claimedByGroup(freshKey(), GROUP, { [DEV_TREE_OPTION]: treeDir }));

    await expect(
      driver.claim(claimedByGroup(freshKey(), GROUP, { [DEV_TREE_OPTION]: treeDir })),
    ).rejects.toMatchObject({ kind: 'instantiation-failed', detail: expect.stringContaining('working tree') });
  });

  it('has no reachable dev.manifests path at all — the half of C16 that did NOT generalize', async () => {
    // StampDevApp generalized: mountPath/command/image/env plus the tree-owner
    // identity land here as a bind mount and a `--user`. StampDevManifests did
    // not — it is a Kubernetes stream — and TWO independent gates already make
    // it unreachable on docker, which is worth pinning rather than guessing:
    //
    // 1. The SHARED validator refuses an app-shape stamp that carries one, so
    //    the combination cannot even be constructed.
    expect(() =>
      makeDriver({
        stamps: { 'sample-app': { app: APP_STAMP.app!, dev: { manifests: '{}' } } as K8sStampConfig },
      }),
    ).toThrow(/dev\.manifests belongs to childManifests stamps/);

    // 2. The only stamp shape that MAY carry one is childManifests, and this
    //    driver refuses that shape outright — so a dev.manifests claim is
    //    refused as a manifest stream, never as a half-understood dev block.
    const driver = makeDriver({
      stamps: {
        streamed: {
          childManifests: '{"kind":"Deployment","spec":{"template":{"spec":{"containers":[]}}}}',
          readiness: { deployment: 'api', namespace: 'default' },
        },
      },
    });
    await expect(
      driver.claim(
        claimSpec(freshKey(), {
          stampId: 'streamed',
          labels: devEnvLabels(INSTALL, freshKey(), 'streamed'),
          options: { [DEV_TREE_OPTION]: treeDir },
        }),
      ),
    ).rejects.toMatchObject({ detail: expect.stringContaining('childManifests') });
  });
});

describe('failures cross the seam in taxonomy shape, never as argv', () => {
  it('an unclassified docker error becomes an opaque ref carrying no command line', async () => {
    fake.failNextWith('Error response from daemon: something nobody has classified about /host/secret/path');
    const driver = makeDriver();

    await expect(driver.claim(claimedByGroup(freshKey()))).rejects.toMatchObject({
      kind: 'unknown',
      retryable: false,
      opaqueRef: expect.stringMatching(/^docker:/),
    });
  });

  it('a classified realization failure carries a FIXED detail, not the daemon"s words', async () => {
    fake.failNextWith('Error response from daemon: invalid mount config for type "bind": /home/someone/private');
    const driver = makeDriver();

    const failure = await driver.claim(claimedByGroup(freshKey())).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'instantiation-failed', retryable: false });
    expect((failure as { detail: string }).detail).not.toContain('/home/someone/private');
  });

  it('an unreachable daemon is retryable weather, and ensureReady says so', async () => {
    fake.setDaemonDown(true);

    await expect(makeDriver().ensureReady()).rejects.toMatchObject({
      kind: 'driver-unavailable',
      retryable: true,
    });
  });

  it('never emits denied-by-policy: docker has no admission, and saying so beats inventing a mapping', async () => {
    fake.failNextWith('Error response from daemon: forbidden: admission webhook denied the request');
    const driver = makeDriver();

    await expect(driver.claim(claimedByGroup(freshKey()))).rejects.not.toMatchObject({ kind: 'denied-by-policy' });
  });
});

describe('the boot budget, without any durable driver state', () => {
  /** A claim, its budget already spent, adopted by a host that was not there for it. */
  async function adoptExpired(): Promise<{ adopted: DevEnvInstanceHandle; key: EnvKey }> {
    let t = 1_700_000_000_000;
    const now = (): number => t;
    fake = new FakeDocker(now);
    const driver = makeDriver({ now, bootTimeoutMs: 60_000 });
    const key = freshKey();
    await driver.claim(claimedByGroup(key));
    t += 120_000; // the claim outlived its budget while the host was down
    fake.severEvents();
    const [adopted] = await makeDriver({ now, bootTimeoutMs: 60_000 }).listInstances(INSTALL);
    return { adopted, key };
  }

  it('anchors on the NETWORK\'s birth, so a restarted host does not refill a wedged claim\'s budget', async () => {
    // Immutable docker labels mean there is nowhere to record "this instance
    // already failed". The answer is to re-derive: the network's `Created` is
    // the same anchor the k8s driver takes from a namespace's
    // creationTimestamp, so an adopted handle resumes the budget it spent —
    // a wedged claim fails in the re-verify window (10 × 5ms here), never
    // after a fresh 60 seconds.
    const { adopted } = await adoptExpired();
    const terminal = vi.fn();
    adopted.onTerminal(terminal);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ kind: 'instantiation-failed' });
  });

  it('an ALREADY-EXPIRED budget is a deadline, not a verdict: the env is re-verified before it is failed', async () => {
    // The bug this pins: an expired budget armed the timer at max(0, …) = 0ms
    // the instant the baseline probe failed, so re-adopting a healthy env that
    // happened to be mid-restart killed it in the same tick. The budget is
    // still the one it spent — the window is a few probe intervals, not a
    // second budget — but the verdict costs one more probe.
    const { adopted, key } = await adoptExpired();
    const terminal = vi.fn();
    const ready = vi.fn();
    adopted.onTerminal(terminal);
    adopted.onReady(ready);
    expect(terminal).not.toHaveBeenCalled(); // NOT decided at adoption

    // It was alive all along. No event says so — the events stream is severed,
    // which is the whole point: the only thing that can find it is the probe
    // the deadline takes before it fails anything.
    fake.severEvents();
    fake.workloadsOf(key.instanceId)[0].serving = true;

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminal).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce();
    expect((await adopted.status()).phase).toBe('ready');
  });
});

describe('supervision', () => {
  it('runs ONE events subscription for the whole install, not one per handle', async () => {
    const driver = makeDriver();
    await driver.claim(claimedByGroup(freshKey()));
    await driver.claim(claimedByGroup(freshKey()));

    expect(fake.joined().filter((argv) => argv.startsWith('events'))).toHaveLength(1);
  });

  it('dispose stops it — the seam grew the verb because this stream had no sanctioned stop', async () => {
    const driver = makeDriver();
    await driver.claim(claimedByGroup(freshKey()));

    driver.dispose();

    // The one observable that matters: the subscription process was killed,
    // so nothing outlives the host that started it.
    expect(fake.calls.some((call) => call.args[0] === 'events')).toBe(true);
    await driver.claim(claimedByGroup(freshKey()));
    expect(fake.joined().filter((argv) => argv.startsWith('events'))).toHaveLength(1);
  });
});

describe('exposure targets (C14): what serves this port, right now', () => {
  const PORT = APP_STAMP.app!.port;

  /** The address the daemon is handing out for this instance's workload, right now. */
  function addressOf(instanceId: string, stampId = 'sample-app'): string {
    const cidr = fake.networkOf(instanceId)!.addresses.get(stampContainerName(instanceId, stampId));
    return (cidr ?? '').split('/')[0];
  }

  it('resolves a bare port to the workload, freezes the STAMP, and answers the address of the moment', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    const target = await handle.resolveExposureTarget!({ port: PORT });
    // The frozen name is the STAMP and not the container: a container name
    // carries the INSTANCE id, and a name frozen at grant has to survive
    // supersession (D21), where the successor's workload is a new container.
    expect(target).toEqual({ service: 'sample-app', address: addressOf(key.instanceId), port: PORT });
    // An address, never the CIDR the daemon reports it in — the caller's very
    // next move is to dial this string.
    expect(target!.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // Both forms dial, like the k8s driver's `name` and `<ns>/<name>`: the
    // container name is what `endpoints.app` prints and what the env's own DNS
    // answers for, so it is the name a human has actually seen.
    expect(await handle.resolveExposureTarget!({ service: 'sample-app', port: PORT })).toEqual(target);
    expect(
      await handle.resolveExposureTarget!({ service: stampContainerName(key.instanceId, 'sample-app'), port: PORT }),
    ).toEqual(target);
    // A name that is neither MISSES rather than dialing the only thing there.
    expect(await handle.resolveExposureTarget!({ service: 'other', port: PORT })).toBeNull();
    driver.dispose();
  });

  it('nothing is written down: a re-attached workload answers its NEW address on the very next call', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    const before = await handle.resolveExposureTarget!({ port: PORT });

    // The endpoint is re-issued — what a container that was removed and
    // re-created looks like from the network's side. A driver that had written
    // the address down would now be dialing one the daemon's pool is free to
    // hand to another env's container.
    const network = envNetworkName(key.instanceId);
    const name = stampContainerName(key.instanceId, 'sample-app');
    fake.run(['network', 'disconnect', '-f', network, name]);
    fake.run(['network', 'connect', network, name]);

    const after = await handle.resolveExposureTarget!({ port: PORT });
    expect(after!.address).toBe(addressOf(key.instanceId));
    expect(after!.address).not.toBe(before!.address);
    expect(after!.service).toBe(before!.service);
    driver.dispose();
  });

  it('a miss is null on every shape: an undeclared port, a stopped workload, a detached one, a vanished env', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    const network = envNetworkName(key.instanceId);
    const name = stampContainerName(key.instanceId, 'sample-app');

    // The declared port is this instance's whole catalog: an `--internal`
    // network publishes nothing, so there is no second truthful entry, and the
    // alternative — scanning ports at dial time — is what the seam forbids.
    expect(await handle.resolveExposureTarget!({ port: PORT + 1 })).toBeNull();

    // Attached, addressed, and not running. Nothing listens in a corpse.
    fake.containers.get(name)!.state = 'exited';
    expect(await handle.resolveExposureTarget!({ port: PORT })).toBeNull();
    fake.containers.get(name)!.state = 'running';
    expect(await handle.resolveExposureTarget!({ port: PORT })).not.toBeNull();

    // Running, and off the env network — an operator's own `docker network
    // disconnect`. No endpoint, no address, nothing to dial.
    fake.run(['network', 'disconnect', '-f', network, name]);
    expect(await handle.resolveExposureTarget!({ port: PORT })).toBeNull();
    fake.run(['network', 'connect', network, name]);

    // The container gone outright, and then the whole env with it.
    fake.run(['rm', '--force', name]);
    expect(await handle.resolveExposureTarget!({ port: PORT })).toBeNull();
    fake.crash(key.instanceId);
    expect(await handle.resolveExposureTarget!({ port: PORT })).toBeNull();
    driver.dispose();
  });

  it('a scope-only env exposes nothing — no declared port is an empty catalog, not a shrug', async () => {
    const driver = makeDriver({ stamps: { scope: {} } });
    const key = freshKey();
    const handle = await driver.claim(
      claimSpec(key, { stampId: 'scope', labels: devEnvLabels(INSTALL, key, 'scope') }),
    );

    expect(await handle.resolveExposureTarget!({ port: 8080 })).toBeNull();
    driver.dispose();
  });

  it('a released env resolves nothing, without asking the daemon — the hole dies with the claim', async () => {
    const driver = makeDriver();
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);
    expect(await handle.resolveExposureTarget!({ port: PORT })).not.toBeNull();

    await handle.release('done');

    expect(await handle.resolveExposureTarget!({ port: PORT })).toBeNull();
    // The latch answers ahead of any read: "an exposed port dies with its env"
    // must not depend on how far a teardown got, nor on a dial that raced it.
    const calls = fake.calls.length;
    expect(await handle.resolveExposureTarget!({ port: PORT })).toBeNull();
    expect(fake.calls.length).toBe(calls);
    driver.dispose();
  });

  it('refuses on a host whose daemon lives in a VM, instead of minting an address nothing could dial', async () => {
    const driver = makeDriver({ hostPlatform: 'darwin' });
    const key = freshKey();
    const handle = await driver.claim(claimedByGroup(key));
    fake.completeBoot(key.instanceId);

    // NOT a miss. A miss is "not right now" and answers null; this is "never
    // from here" — the relay lives in this process, and no address on a
    // VM-held bridge is dialable from it. The grant refuses with the reason
    // rather than handing out a URL that could never serve.
    await expect(handle.resolveExposureTarget!({ port: PORT })).rejects.toThrow(
      /daemon runs inside a VM|shares its daemon's kernel/,
    );
    driver.dispose();
  });
});

/**
 * The smallest provider the grant model accepts: it keeps the binding so the
 * suite can ask the DIALER what a relay would reach, which is the only
 * question this block exists to answer about the docker driver.
 */
class RecordingProvider implements ExposureProvider {
  readonly kind = 'stub';
  readonly bindings = new Map<string, ExposureBinding>();

  reportUrl(draft: ExposureDraft): { url: string; detail: Record<string, string> } {
    return { url: `https://${draft.name}.stub.invalid/`, detail: {} };
  }

  async realize(binding: ExposureBinding): Promise<{ url: string }> {
    this.bindings.set(binding.grant.name, binding);
    return { url: binding.grant.url };
  }

  async revoke(grant: ExposureGrant): Promise<void> {
    this.bindings.delete(grant.name);
  }

  async heal(bindings: ExposureBinding[]): Promise<void> {
    for (const binding of bindings) this.bindings.set(binding.grant.name, binding);
  }
}

describe('an exposure grant, end to end, on a docker install (C14)', () => {
  let db: DbDriver | null = null;
  let driver: DockerDevEnvDriver | null = null;

  afterEach(async () => {
    driver?.dispose();
    driver = null;
    if (db) await closeDb();
    db = null;
  });

  /** The whole grant model over the real docker driver, with only the transport stubbed. */
  async function grantFixture(): Promise<{
    envs: DevEnvService;
    exposures: EnvExposureService;
    provider: RecordingProvider;
    envId: string;
    instanceId: string;
  }> {
    db = await initTestDb();
    await runMigrations(db);
    driver = makeDriver();
    const envs = new DevEnvService({ db, driver, installScope: INSTALL });
    const provider = new RecordingProvider();
    // The workload is a FakeDocker container: it has an address the driver
    // resolves and nothing listening on it, so the production probe would
    // refuse every grant below on a timeout. Plaintext is what the stamp's app
    // serves, and this suite is about the driver's resolution, not the scheme.
    const exposures = new EnvExposureService({ db, envs, provider, probeBackendTls: async () => false });
    exposures.wireLifecycle();
    const env = await envs.claim({ ownerRef: GROUP, stampId: 'sample-app', lifetime: { mode: 'pinned' } });
    fake.completeBoot(env.instanceId!);
    // Readiness reaches the registry through I/O; the number of awaits between
    // a probe that answered and an active row is an implementation detail.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await envs.status(env.envId)).state === 'active') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { envs, exposures, provider, envId: env.envId, instanceId: env.instanceId! };
  }

  it('grants against the running workload, and the relay resolves its address per connection', async () => {
    const { exposures, provider, envId, instanceId } = await grantFixture();

    const row = await exposures.expose({ envId, port: APP_STAMP.app!.port, approvedBy: 'operator' });

    expect(row).toMatchObject({ state: 'live', envId, service: 'sample-app', port: APP_STAMP.app!.port });
    expect(row.url).toBe(`https://${row.name}.stub.invalid/`);
    // What the relay would dial, asked the way a relay asks it: through the
    // binding's dialer, per connection, never from anything written down.
    const dial = provider.bindings.get(row.name)!.dial;
    const address = fake.networkOf(instanceId)!.addresses.get(stampContainerName(instanceId, 'sample-app'))!;
    expect(await dial()).toEqual({
      service: 'sample-app',
      address: address.split('/')[0],
      port: APP_STAMP.app!.port,
    });
  });

  it('refuses a port the claim never declared, and writes no row for it', async () => {
    const { exposures, envId } = await grantFixture();

    await expect(exposures.expose({ envId, port: 9999, approvedBy: 'operator' })).rejects.toThrow(
      /nothing in env .* serves port 9999/,
    );
    expect(await exposures.list()).toEqual([]);
  });

  it('the hole dies with the env: release revokes it, and the dialer misses from then on', async () => {
    const { envs, exposures, provider, envId } = await grantFixture();
    const row = await exposures.expose({ envId, port: APP_STAMP.app!.port, approvedBy: 'operator' });
    const dial = provider.bindings.get(row.name)!.dial;

    await envs.release(envId);

    expect(await exposures.liveForEnv(envId)).toEqual([]);
    expect(provider.bindings.has(row.name)).toBe(false);
    // Belt and braces, and the leg that matters if a teardown is slow: the
    // dialer already in a relay's hand answers null from here on.
    expect(await dial()).toBeNull();
  });
});
