/**
 * Docker dev-env driver — the realization that needs nothing but a daemon.
 *
 * The point of this driver is not that it is smaller than the k8s one. It is
 * that claimable environments are a GENERIC capability: a developer with
 * Docker and nothing else — no cluster, no gateway, no tenancy, no tailnet —
 * gets the same `ncl envs claim` verbs, the same durable registry, the same
 * D18 readiness push and the same D10 teardown.
 *
 * THE REALIZATION UNIT is a NETWORK plus the containers on it. One
 * `docker network` per instance (`denv-<instanceId>`), one container per
 * stamp workload (`denv-<instanceId>-<stampId>`). Names are derived from the
 * key rather than random, because docker lets the caller choose them, so the
 * k8s driver's random-name-plus-label dance has no counterpart here. Identity
 * still rides on LABELS: they are set at CREATE, which on docker is the only
 * moment labels can be set at all.
 *
 * THAT IMMUTABILITY IS THE DEEPEST ASYMMETRY WITH THE K8S DRIVER, and it is
 * answered here by keeping NO durable driver state. Everything the k8s driver
 * writes back onto a live object — the ever-ready latch, the recorded failure
 * kind, the materials-scope heal, the warm-pool ownership flip — is either
 * RE-DERIVED from container facts (`docker ps` state, the network's `Created`
 * as the boot budget's anchor) or does not exist here (this driver mints no
 * material and pools nothing). Nothing on disk shadows the daemon. The one
 * thing that cannot survive is "this instance already failed its boot
 * deadline": a restarted host re-arms the timer against the ORIGINAL
 * deadline, so it re-reaches the same verdict a moment later — a slower
 * answer, never a wrong one. That "moment later" is load-bearing and it is
 * spelled out at `DockerInstanceHandle`: an adopted instance whose budget is
 * ALREADY SPENT gets a bounded re-verify window and one last probe before the
 * verdict, because a verdict reached from a single baseline probe would kill a
 * three-day-old healthy env for the crime of being adopted while its workload
 * happened to be restarting.
 *
 * THE AGENT NEVER TOUCHES THE DAEMON. The driver runs host-side and the
 * claimant's container gets exactly one new thing: membership of the env
 * network (`docker network connect`). No socket mount, no docker binary, no
 * exec. That is the whole security posture and it is pinned by a test.
 *
 * EVERY ENV NETWORK IS `--internal`, MECHANICALLY, WITH NO WAY TO ASK
 * OTHERWISE. Attaching the claimant is an EGRESS decision: the agent already
 * sits on an internal network precisely so it cannot reach the internet, and
 * a second, routable network would hand it a default route — the host
 * performing the escape on the agent's behalf. A stamp that "needs the
 * internet" is refused, not accommodated. Note the exact scope of the
 * guarantee, measured live: this clamp means a claim can never GRANT egress.
 * It cannot REVOKE egress a claimant already had — an agent left on a
 * routable network reaches the internet before any claim and after it, and
 * that is the session driver's lockdown to own, not this one's.
 *
 * WHAT THE AGENT ACTUALLY GETS, STATED PLAINLY: full L3 reach to every
 * container on that env network, on every port. Docker networks have no
 * per-port ACL, so this is env-scoped where the k8s route is pod-and-port
 * scoped. That is a real reduction in granularity and it is declared, not
 * discovered — `capabilities().isolation` says `container/shared-daemon` for
 * the same reason.
 *
 * AND WHAT A SHARED DAEMON DOES NOT GIVE, STATED JUST AS PLAINLY: no kernel
 * boundary, no daemon boundary, no user namespace. A claimed env's containers
 * run beside the claimant's own on one kernel. What separates them is a netns
 * per env plus the ONE hardening posture this repo already applies to every
 * container on that daemon — `--cap-drop=ALL`, `no-new-privileges`, `--init`,
 * the install-wide pid cap (`hardeningArgs` in docker-daemon.ts, copied from
 * the session driver's, not invented here). The one thing that posture does
 * NOT do unchanged is serve an arbitrary stamp: a workload declaring a port
 * below 1024 gets `NET_BIND_SERVICE` back, because the agent container the
 * flags were copied from never binds one and a stamp routinely does. The
 * capability string says every half so nobody has to read this file to learn
 * them.
 *
 * AN APPROVED EXPOSURE (C14) REACHES IN FROM THE HOST, AND ONLY FROM THERE.
 * The driver answers "what serves this port right now" with the workload's
 * address on the env network, per connection, and the relay carrying the grant
 * lives in the host process — so the exposed port rides the ONE dialer that
 * was always allowed to reach a claimed env, and the network keeps no route
 * out. That address is dialable exactly where docker says it is: the host
 * whose kernel holds the bridge. A daemon in a VM has none this process can
 * reach, so an exposure there is REFUSED at grant rather than minted as a URL
 * that never serves (`exposureUnreachableReason`).
 *
 * HARD RULE, inherited from the k8s driver and learned the same expensive
 * way: nothing inside an events callback may throw. An uncaught exception
 * there is turned into process.exit by log.ts, so every callback body is
 * wrapped and a probe blip degrades to a missed event that the drop
 * reconcile and the boot timer are the backstops for.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONTAINER_PIDS_LIMIT } from '../config.js';
import { log } from '../log.js';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from '../drivers/cli.js';
import { LABELS } from '../drivers/types.js';

import {
  Docker,
  PRIVILEGED_PORT_CEILING,
  endpointAddress,
  normalizeDockerFailure,
  type DockerContainer,
  type DockerEvent,
  type DockerNetwork,
} from './docker-daemon.js';
import { DEV_TREE_OPTION, isDevManifests, type StampDevApp } from './dev-tree.js';
import { type StampSource } from './stamp-registry.js';
import { BUILTIN_STAMPS, validateStampEntry, type K8sStampConfig } from './stamps.js';
import {
  DEV_ENV_LABELS,
  asDevEnvFailureError,
  isDevEnvFailure,
  stampUnknown,
  type DevEnvDriver,
  type DevEnvDriverCapabilities,
  type DevEnvFailure,
  type DevEnvInstanceHandle,
  type DriverClaimSpec,
  type EnvKey,
  type ExposureTargetResolution,
  type InstanceStatus,
} from './types.js';

/** Every runtime object this driver creates wears it, so an operator can grep one prefix. */
const NAME_PREFIX = 'denv';

export function envNetworkName(instanceId: string): string {
  return `${NAME_PREFIX}-${instanceId}`;
}

export function stampContainerName(instanceId: string, stampId: string): string {
  return `${NAME_PREFIX}-${instanceId}-${stampId}`;
}

/**
 * Driver-private labels, all set at CREATE because docker has no way to set
 * them later. They are how a restarted host re-derives everything this driver
 * needs and nothing it does not.
 */
const ROLE_LABEL = 'nanoclaw-dev-role';
/** Claim options, readable back off the network — the k8s driver's option annotations. */
const OPTION_PREFIX = 'nanoclaw-dev-option.';
/**
 * The claimant selector (D19), one label per selector term. On the RUNTIME
 * rather than in memory for the same reason the k8s driver annotates the
 * claimant namespace: a session that respawns must be re-attached by a host
 * that may have restarted since the claim, and the only thing that survives
 * both is the network's own metadata.
 */
const CLAIMANT_PREFIX = 'nanoclaw-dev-claimant.';
/** sha256 of the dev tree path — the shared-tree refusal's index (a path is not a legal label value). */
const TREE_LABEL = 'nanoclaw-dev-tree';
/**
 * The port this claim's workload serves — WHAT READINESS MEANS for this
 * instance, written on the network at create.
 *
 * On the runtime rather than read back off the stamp table, because both of
 * the stamp table's answers can go missing while the env is perfectly alive: a
 * stamp can be RETIRED (`stampFor` stops resolving it, and the retirement
 * contract is that live envs keep running), and a registry snapshot can be
 * cold. A readiness definition that evaporates with its stamp is a readiness
 * definition that starts saying "ready" without probing, which is the one
 * answer this driver may never give. Absent = the claim declared no workload
 * at all, the only shape for which not probing IS the honest answer.
 */
const PORT_LABEL = 'nanoclaw-dev-port';

/**
 * Docker boots containers in seconds, so the budget is generous rather than
 * long: past this an env is wedged, and saying so beats a `claiming` row an
 * agent waits on forever.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PROBE_INTERVAL_MS = 1_000;
const WATCH_BACKOFF_MIN_MS = 1_000;
const WATCH_BACKOFF_MAX_MS = 30_000;
/**
 * How much re-verification an ADOPTED instance whose boot budget is already
 * spent gets before the verdict lands, MEASURED IN probe intervals so it
 * scales with whatever this deployment thinks a probe costs.
 *
 * A DURATION, NOT A COUNT, and named for what it is: nothing polls inside the
 * window. What it buys is the DISTANCE between the two probes an adopted
 * instance actually takes — the baseline one in the constructor and the one
 * `bootTimedOut` takes before it fails anything — which is what a workload
 * that was merely mid-restart at adoption needs to come back. (A `start` event
 * arriving inside the window adds the poll loop on top, and the window does
 * not depend on one arriving; a severed events stream is exactly the case this
 * exists for.)
 *
 * Bounded on purpose, and small: it is a re-verify window, not a second
 * budget, so a genuinely wedged claim still fails within seconds of adoption
 * rather than being handed a fresh five minutes on every host restart.
 */
const ADOPTION_REVERIFY_INTERVALS = 10;

/**
 * The readiness prober's image.
 *
 * READINESS ON DOCKER IS A DELIBERATE CHOICE AND THIS IS IT. There is no
 * kubelet running probes, and "the container is running" is not readiness —
 * that is exactly the half-warm slot the k8s driver's one-readiness-definition
 * rule exists to prevent. Three candidates were real: a `--health-cmd`
 * (needs a probe tool inside the STAMP's image, which an arbitrary stamp
 * cannot promise), a host-side TCP connect (works on Linux, does not cross
 * Docker Desktop's VM boundary, and `--internal` rules out published ports
 * anyway), and a throwaway prober container on the env network. The prober
 * wins because it is the only one that is portable AND makes no demand on the
 * stamp's image: it measures a TCP connect to the declared port from inside
 * the env network, which is precisely what an app stamp declares as its
 * readiness.
 *
 * Its cost is honest and named: an image-presence dependency at probe time,
 * the exact class C15 exists to make explicit. It is defaulted to the ref the
 * builtin app stamp already requires to be node-local, so an install that can
 * claim the builtin can already probe (`docker-driver.test.ts` pins that).
 */
export const DEFAULT_PROBE_IMAGE = 'mirror.gcr.io/library/alpine:3.20';

/**
 * `capabilities().isolation`, and the whole of what a shared daemon gives and
 * does not give, in the one string an operator sees in the boot log.
 *
 * Both halves, because half of it is a lie by omission either way: naming only
 * the boundary oversells a container on the claimant's own kernel, and naming
 * only the absences hides that the containers are in fact clamped.
 *
 * BUILT FROM THE POSTURE THIS INSTALL ACTUALLY APPLIES, not from the posture
 * the code hopes for. `isolation` is documented as diagnostic honesty, and a
 * string that claims a pid cap an install left blank is a diagnostic lie —
 * cheap to write, expensive to trust. The two clamps that are unconditional
 * are stated flatly; the pid cap appears only when there is one, with its
 * value; and the one capability a declaration can win back is named next to
 * the drop that would otherwise have taken it.
 */
export function dockerIsolation(pidsLimit: number | undefined): string {
  const clamps = ['cap-drop=ALL', 'no-new-privileges'];
  if (pidsLimit !== undefined) clamps.push(`pid cap ${pidsLimit}`);
  return (
    `container/shared-daemon: netns per env, ${clamps.join(' + ')} per container ` +
    `(NET_BIND_SERVICE back only for a stamp declaring a port below ${PRIVILEGED_PORT_CEILING}); ` +
    'NOT a kernel, daemon or user-namespace boundary'
  );
}

/**
 * The install-wide pid cap, read from the SAME knob the session driver's
 * hardening reads (`CONTAINER_PIDS_LIMIT`, default 2048) rather than a
 * dev-env-only one: it is one daemon, and two knobs for one posture is how
 * postures drift. Blank, zero or garbage means uncapped — the rule
 * `parsePidsLimit` applies host-side, because cgroups v2 rejects
 * `--pids-limit 0` with EINVAL.
 */
function configuredPidsLimit(): number | undefined {
  return normalizePidsLimit(Number(CONTAINER_PIDS_LIMIT));
}

/**
 * The ONE rule that decides whether a pid cap exists at all, so the argv
 * `hardeningArgs` builds and the sentence `dockerIsolation` says cannot
 * disagree. Blank, zero, negative or garbage is uncapped; anything else is the
 * floor of the number.
 */
function normalizePidsLimit(pids: number | undefined): number | undefined {
  return typeof pids === 'number' && Number.isFinite(pids) && pids > 0 ? Math.floor(pids) : undefined;
}

/**
 * `busybox nc -z` — connect, report, exit. Verified against the pinned alpine:
 * exit 0 when something is listening, exit 1 on refusal AND on an unresolvable
 * name (a container that has not started yet), which is the two-valued answer
 * a probe needs. `/bin/busybox` explicitly, the same way the builtin stamp's
 * own command reaches for it.
 */
function probeCommand(host: string, port: number): string[] {
  return ['/bin/busybox', 'nc', '-z', '-w', '2', host, String(port)];
}

/** Option keys ride label keys; keep them boring for the same reason the k8s driver does. */
const OPTION_KEY_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
/** The seam-wide label VALUE bound — the strictest surface any driver realizes onto. */
const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

/** Container states that still count as the instance being held by the runtime. */
function isLiveState(state: string): boolean {
  return state === 'running' || state === 'restarting' || state === 'paused' || state === 'created';
}

export interface DockerDevEnvDriverOptions {
  installScope: string;
  cli?: Cli;
  /** The stamps this deployment knows; an unknown stamp is a claim-time refusal. */
  stamps?: Record<string, K8sStampConfig>;
  /** The stamps registry's sync window (C12); merged under the static table, same rule as k8s. */
  stampSource?: StampSource;
  probeImage?: string;
  bootTimeoutMs?: number;
  probeIntervalMs?: number;
  /**
   * `--pids-limit` for every container this driver creates. Defaults to the
   * install-wide `CONTAINER_PIDS_LIMIT` the session driver already honours —
   * one knob, one posture, one daemon.
   */
  pidsLimit?: number;
  /**
   * Where the HOST PROCESS runs, which is the one thing that decides whether a
   * relay in it can dial a claimed env at all (see `exposureUnreachableReason`).
   * Injectable for the same reason `now` is: a suite must be able to prove both
   * verdicts on whatever machine it runs on.
   */
  hostPlatform?: NodeJS.Platform;
  now?: () => number;
}

/** What a dev-flavor claim resolved to — computed once, at claim, from the stamp and the option. */
interface DevRealization {
  treePath: string;
  mountPath: string;
  image?: string;
  command?: string[];
  env?: Record<string, string>;
  /** `uid:gid` of the tree's owner, stat'd host-side — the C16 identity clamp, docker dialect. */
  user: string;
}

export interface DockerInstanceSubscription {
  instanceId: string;
  onEvent: (event: DockerEvent) => void;
  onGap: () => void;
}

export class DockerDevEnvDriver implements DevEnvDriver {
  readonly kind = 'docker';
  private readonly docker: Docker;
  private readonly scope: string;
  private readonly stamps: Record<string, K8sStampConfig>;
  private readonly stampSource: StampSource | null;
  private readonly proberImage: string;
  /** The pid cap this install actually applies; undefined = uncapped, and the capability string says so. */
  private readonly pidsLimit: number | undefined;
  private readonly bootTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly subscriptions = new Set<DockerInstanceSubscription>();
  private events: SupervisedProcess | null = null;
  private watchBackoffMs = WATCH_BACKOFF_MIN_MS;
  private disposed = false;

  constructor(options: DockerDevEnvDriverOptions) {
    this.pidsLimit = normalizePidsLimit(options.pidsLimit ?? configuredPidsLimit());
    this.docker = new Docker(options.cli ?? realCli('docker'), { pidsLimit: this.pidsLimit });
    this.scope = options.installScope;
    this.stamps = options.stamps ?? { ...BUILTIN_STAMPS };
    // The full refusal set lives with the stamp vocabulary, so a static table
    // earns exactly the refusals the registry's write path earns.
    for (const [stampId, config] of Object.entries(this.stamps)) {
      validateStampEntry(stampId, config, { codeProvided: true });
    }
    this.stampSource = options.stampSource ?? null;
    this.proberImage = options.probeImage ?? DEFAULT_PROBE_IMAGE;
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.hostPlatform = options.hostPlatform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  capabilities(): DevEnvDriverCapabilities {
    return {
      // Said plainly because an operator reads it in the boot log: a claimed
      // env here is containers on the SAME kernel and the SAME daemon as the
      // agent that claimed it. That is a container boundary, and it is not
      // what a vcluster gives you — so the string carries BOTH halves, what
      // the boundary is made of and what it is not, rather than a token an
      // operator has to already know how to read. `isolation` is documented as
      // diagnostic honesty and never a branch, which is what makes a sentence
      // legal here — and what makes it built from THIS install's posture
      // rather than from a constant that would claim a pid cap nobody set.
      isolation: dockerIsolation(this.pidsLimit),
      // TRUE, and the seam's own comment used to predict otherwise: an
      // `--internal` network has no NAT, no route and no DNS carve-out. It is
      // a coarser seal than a NetworkPolicy (all-or-nothing per network
      // rather than per pod with exceptions) and a total one.
      sealedEgress: true,
      // FALSE, and this is the C15 decision this driver makes in the open.
      // The daemon can obviously pull, which is exactly why this is the
      // tempting flag to lie about: create-time resolution (image-resolve.ts)
      // rides mTLS to a gateway service listener, and on a laptop with
      // nothing but Docker there is no gateway to ride. Declaring true would
      // let a registry-origin stamp past the CLI's capability refusal and
      // fail at resolution instead, and realizing the pull locally would be
      // an ungoverned egress path on any install that later grows a gateway.
      // So: node-local stamps only, the operator's own `docker pull` is the
      // placement, and the #22 import race is stated rather than closed.
      imagePull: false,
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    try {
      this.docker.info();
    } catch {
      throw asDevEnvFailureError({ kind: 'driver-unavailable', retryable: true });
    }
    if (!this.docker.imagePresent(this.proberImage)) {
      // Loud, not fatal: dev-env being unable to answer readiness must not
      // take down a host whose chat surface is fine. Claims of port-bearing
      // stamps refuse in seconds with the same sentence (see claim), which is
      // the refusal shape this platform prefers over a boot timeout.
      log.warn('Dev-env docker: the readiness prober image is not in the image store; claims will refuse', {
        image: this.proberImage,
        fix: `docker pull ${this.proberImage}`,
      });
    }
  }

  /** Stop the events subscription — the seam's sanctioned stop (see DevEnvDriver.dispose). */
  dispose(): void {
    this.disposed = true;
    this.events?.kill();
    this.events = null;
    this.subscriptions.clear();
  }

  // ---------- claims ----------

  async claim(spec: DriverClaimSpec): Promise<DevEnvInstanceHandle> {
    const config = await this.requireStamp(spec.stampId);
    validateClaimSpec(spec);
    this.refuseUnrealizableShape(spec.stampId, config);
    const dev = this.devRealization(spec, config);
    this.refuseAbsentImages(spec.stampId, config, dev);
    try {
      return await this.claimInner(spec, config, dev);
    } catch (error) {
      throw isDevEnvFailure(error) ? error : normalizeDockerFailure(error);
    }
  }

  private async claimInner(
    spec: DriverClaimSpec,
    config: K8sStampConfig,
    dev: DevRealization | null,
  ): Promise<DevEnvInstanceHandle> {
    const install = spec.labels[DEV_ENV_LABELS.install];
    // Idempotent on key: a live network for this instance IS the claim — a
    // caller's replay converges it rather than duplicating it.
    const existing = this.networkFor(install, spec.key.instanceId);
    if (existing) {
      this.resumeExisting(existing, spec, config, dev);
      return this.handleFor(this.docker.inspectNetwork(existing.Name) ?? existing);
    }
    if (dev) this.refuseSharedDevTree(spec, dev.treePath, install);

    const network = envNetworkName(spec.key.instanceId);
    try {
      this.docker.createNetwork(network, this.networkLabels(spec, config, dev));
      this.realizeWorkload(spec, config, dev, network);
      // Reachability opens inside the atomic block: a claim whose claimant
      // cannot reach the env hands out an env its owner cannot use.
      this.attachClaimant(network, spec.claimantSelector);
    } catch (error) {
      // Atomic claim: allocate all or leave nothing.
      try {
        this.teardown(network, spec.key.instanceId);
      } catch {
        /* best effort; reapResidue is the backstop */
      }
      throw error;
    }
    const created = this.docker.inspectNetwork(network);
    if (!created) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: 'the env network vanished during the claim',
      });
    }
    return this.handleFor(created);
  }

  /**
   * The seam's resume (adoption's converge half): finish what a dying host
   * left half-done, WITHOUT allocating an instance. The scope IS the
   * instance here, so a vanished network is the registry's fact to settle and
   * this call answers it by doing nothing.
   */
  async resumeClaim(spec: DriverClaimSpec): Promise<void> {
    try {
      const existing = this.networkFor(spec.labels[DEV_ENV_LABELS.install], spec.key.instanceId);
      if (!existing) return;
      const config = this.stampFor(spec.stampId);
      this.resumeExisting(existing, spec, config, config ? this.devRealization(spec, config) : null);
    } catch (error) {
      throw isDevEnvFailure(error) ? error : normalizeDockerFailure(error);
    }
  }

  /**
   * Idempotent convergence of an instance that already exists — the shared
   * body of a replayed claim and of adoption's resume. Three heals, and each
   * one is a step the dying host might not have reached: the workload
   * container, its start, and the claimant attachment.
   *
   * The attachment is the heal that matters most on docker and has no k8s
   * counterpart: network membership is per-container and imperative, so it
   * does NOT survive a session respawn the way a label selector does.
   */
  private resumeExisting(
    network: DockerNetwork,
    spec: DriverClaimSpec,
    config: K8sStampConfig | undefined,
    dev: DevRealization | null,
  ): void {
    if (config?.app) {
      const workloads = this.workloadsOf(spec.key.instanceId);
      if (workloads.length === 0) {
        this.realizeWorkload(spec, config, dev, network.Name);
      } else {
        for (const workload of workloads) {
          // ONLY `created` — a container the dying host made and never
          // started. An EXITED one is a dead instance, and restarting it
          // would resurrect an env the registry may already have failed.
          if (workload.state === 'created') this.docker.startContainer(workload.name);
        }
      }
    }
    // The spec's selector when the host supplied one; otherwise the one the
    // NETWORK remembers — a driver-level replay from runtime state alone has
    // no spec to read, which is why the selector is on the labels.
    this.attachClaimant(network.Name, spec.claimantSelector ?? claimantSelectorOf(network.Labels) ?? undefined);
  }

  async listInstances(installScope: string): Promise<DevEnvInstanceHandle[]> {
    // Claimed instances only: the env label exists. Nothing else this driver
    // creates carries it, so discovery cannot over-report — and over-reporting
    // is what makes the host orphan-release live work.
    return this.envNetworks(installScope).map((network) => this.handleFor(network));
  }

  async reapResidue(installScope: string): Promise<void> {
    for (const network of this.envNetworks(installScope)) {
      const instanceId = network.Labels[DEV_ENV_LABELS.instance];
      if (!instanceId) continue;
      const workloads = this.workloadsOf(instanceId);
      // An env whose every workload is a corpse is residue. A scope-only env
      // (no workloads at all) is NOT: there is nothing to have died, and the
      // registry owns whether that env is still wanted.
      if (workloads.length === 0 || workloads.some((w) => isLiveState(w.state))) continue;
      try {
        this.teardown(network.Name, instanceId);
      } catch (error) {
        log.warn('Dev-env docker: failed-residue reap failed', { network: network.Name, error: String(error) });
      }
    }
    // Probers a dying host left mid-probe. `--rm` collects them on every live
    // path, so one still standing lost its host.
    try {
      const strays = this.docker
        .listContainers([`label=${DEV_ENV_LABELS.install}=${installScope}`, `label=${ROLE_LABEL}=probe`], [])
        .map((container) => container.name);
      this.docker.removeContainers(strays);
    } catch (error) {
      log.warn('Dev-env docker: prober sweep failed', { error: String(error) });
    }
    // Workload containers whose env network is already gone: the teardown got
    // half done, and a stopped corpse holding a derived name would collide
    // with nothing but confuse everyone.
    try {
      const live = new Set(this.envNetworks(installScope).map((n) => n.Labels[DEV_ENV_LABELS.instance]));
      const orphans = this.docker
        .listContainers([`label=${DEV_ENV_LABELS.install}=${installScope}`, `label=${ROLE_LABEL}=workload`], [
          DEV_ENV_LABELS.instance,
        ])
        .filter((container) => !live.has(container.labels[DEV_ENV_LABELS.instance] ?? ''))
        .map((container) => container.name);
      this.docker.removeContainers(orphans);
    } catch (error) {
      log.warn('Dev-env docker: orphan workload sweep failed', { error: String(error) });
    }
  }

  /**
   * Is `ref` in the store this driver's claims resolve from? (C15's re-probe.)
   * Cheap and TRUTHFUL here in a way it cannot be on k8s, which has to read a
   * possibly-truncated kubelet report and answer "present" when unsure: the
   * daemon either has the image or it does not, and it will say so.
   *
   * Implemented even though this driver declares `imagePull: false`, because
   * it is not the pull flag's dependent — it answers a question about the
   * store, and the claim path asks the same question before it refuses.
   */
  async probeImage(ref: string): Promise<boolean> {
    return this.docker.imagePresent(ref);
  }

  // ---------- realization ----------

  private networkLabels(
    spec: DriverClaimSpec,
    config: K8sStampConfig,
    dev: DevRealization | null,
  ): Record<string, string> {
    const labels: Record<string, string> = { ...spec.labels, [ROLE_LABEL]: 'scope' };
    for (const [key, value] of Object.entries(spec.options)) labels[`${OPTION_PREFIX}${key}`] = value;
    for (const [key, value] of Object.entries(spec.claimantSelector ?? {})) {
      labels[`${CLAIMANT_PREFIX}${key}`] = value;
    }
    if (dev) labels[TREE_LABEL] = treeHash(dev.treePath);
    // What readiness will MEAN for this instance, for as long as it lives —
    // see PORT_LABEL. Written here because create is the only moment a docker
    // label can be written at all.
    if (config.app) labels[PORT_LABEL] = String(config.app.port);
    return labels;
  }

  private realizeWorkload(
    spec: DriverClaimSpec,
    config: K8sStampConfig,
    dev: DevRealization | null,
    network: string,
  ): void {
    const app = config.app;
    if (!app) return; // a scope-only stamp is a legal stamp: the network IS the env
    const name = validateRuntimeName(stampContainerName(spec.key.instanceId, spec.stampId), 'container');
    this.docker.createContainer({
      name,
      network,
      // The dev variant runs from the tree instead of the baked artifact —
      // on docker that is a bind mount, an argv override and `--user`, which
      // is the whole of what the k8s side needs a static PV, a pre-bound
      // claim, a reserved storage class and a synced-name formula for.
      image: dev?.image ?? app.image,
      labels: { ...spec.labels, [ROLE_LABEL]: 'workload' },
      env: { ...app.env, ...dev?.env },
      command: dev?.command ?? app.command,
      binds: dev ? [{ hostPath: dev.treePath, containerPath: dev.mountPath }] : undefined,
      user: dev?.user,
      // The declared port, for the one decision it makes at create: a stamp
      // that serves below 1024 needs CAP_NET_BIND_SERVICE back out of
      // `--cap-drop=ALL`, or it EACCESes on its own declaration.
      port: app.port,
    });
    this.docker.startContainer(name);
  }

  /**
   * The claimant attach (D19), docker dialect: every container wearing the
   * claim's selector joins this env's network. The imperative analogue of the
   * NetworkPolicy the k8s driver authors in the claimant's namespace, with
   * the same fail-closed property — a host claim wears an ownerRef no group
   * can be created under, so its selector matches nothing and nobody is
   * attached.
   */
  private attachClaimant(network: string, selector: Record<string, string> | undefined): void {
    const terms = Object.entries(selector ?? {});
    if (terms.length === 0) return;
    const filters = terms.map(([key, value]) => `label=${key}=${value}`);
    // Repeated same-key filters OR on docker, so this reads "running or
    // created": a session prepared but not yet started must be attached too,
    // or its first start would find an env it cannot reach.
    for (const container of this.docker.listContainers([...filters, 'status=running', 'status=created'], [])) {
      this.docker.connect(network, container.name);
    }
  }

  /**
   * Full teardown (D10). A docker network is a NAME, not a containment
   * boundary — removing it does not remove its members, and it REFUSES to be
   * removed while any remain — so teardown is explicitly: our containers,
   * then everyone else's endpoints (the claimant's), then the network.
   * Every step tolerates "already gone": the reaper and an explicit release
   * will race and both must win.
   *
   * THE MEMBERSHIP READ COMES AFTER THE REMOVALS, AND AGAIN ON THE RETRY.
   * Reading it once up front would freeze a list that the daemon's own answer
   * can contradict: a member this driver never saw is a member it never
   * disconnects, the removal is refused, and the network is then LEAKED —
   * `reapResidue` deliberately skips an env with no workloads, so nothing
   * comes back for it. Nothing inside this process can attach one mid-
   * teardown (`Cli.run` is execFileSync, so the events callback that re-
   * attaches a respawned claimant cannot interleave with a synchronous
   * teardown), but an operator's own `docker network connect` can, and the
   * daemon's refusal is the only honest detector. Two passes: the second sees
   * whatever the first raced.
   */
  private teardown(network: string, instanceId: string): void {
    const ours = this.docker
      .listContainers([`label=${DEV_ENV_LABELS.instance}=${instanceId}`], [])
      .map((container) => container.name);
    this.docker.removeContainers(ours);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const members = this.docker.inspectNetwork(network);
      if (!members) return; // already gone — the desired state, whoever got there first
      for (const member of Object.values(members.Containers)) {
        if (member.Name) this.docker.disconnect(network, member.Name);
      }
      if (this.docker.removeNetwork(network) === 'removed') return;
    }
    throw asDevEnvFailureError({
      kind: 'instantiation-failed',
      retryable: true,
      detail:
        'the env network still has members this driver did not attach — release again once they are gone ' +
        '(nothing this driver creates can be one of them)',
    });
  }

  // ---------- stamps and refusals ----------

  private stampFor(stampId: string): K8sStampConfig | undefined {
    const fromRegistry = this.stampSource?.getStamp(stampId);
    if (fromRegistry && !(stampId in this.stamps)) {
      try {
        validateStampEntry(stampId, fromRegistry);
        return fromRegistry;
      } catch (error) {
        log.warn('Dev-env docker: registered stamp failed validation; ignoring', {
          stamp: stampId,
          error: String(error),
        });
        return undefined;
      }
    }
    return this.stamps[stampId];
  }

  /** One guarded refresh before refusing — a cold snapshot must not fail a claim of a known stamp. */
  private async requireStamp(stampId: string): Promise<K8sStampConfig> {
    if (!this.stampFor(stampId)) {
      try {
        await this.stampSource?.refresh();
      } catch (error) {
        log.warn('Dev-env docker: stamp registry refresh failed at claim', { error: String(error) });
      }
    }
    const config = this.stampFor(stampId);
    if (config) return config;
    if (this.stampSource?.retiredStamp?.(stampId)) {
      throw stampUnknown(
        `stamp '${stampId}' is retired on this deployment — live envs keep running, but new claims need a fresh registration`,
      );
    }
    throw stampUnknown(`no stamp '${stampId}' in this deployment`);
  }

  /**
   * The vocabulary refusal, and it is a finding as much as a check: the stamp
   * type every driver shares is called `K8sStampConfig` and half of it — a
   * Kubernetes manifest stream plus a `{deployment, namespace}` readiness gate
   * — is structurally unrealizable on a docker daemon. There is nothing here
   * to apply a manifest to, so the honest answer is a NAMED refusal in
   * seconds rather than a boot that polls out its budget.
   *
   * It lands at CLAIM, which is the expensive place: the service persists
   * intent BEFORE asking the driver, so every attempt leaves a `failed` env
   * row. The cheaper home is a per-driver refusal at REGISTRATION — the
   * machinery already exists (the CLI refuses a pull-origin stamp when
   * `imagePull` is false) and it is one capability field away. It would not
   * make this refusal redundant either way: `BUILTIN_STAMPS.nanoclaw` is
   * code-provided, bypasses the registry entirely, and would still arrive
   * here.
   */
  private refuseUnrealizableShape(stampId: string, config: K8sStampConfig): void {
    if (config.childManifests === undefined) return;
    throw asDevEnvFailureError({
      kind: 'instantiation-failed',
      retryable: false,
      detail:
        `stamp '${stampId}' deploys a Kubernetes manifest stream (childManifests) and this driver realizes ` +
        `containers on a docker daemon — there is nothing here to apply it to. Author an app-shape stamp ` +
        `({app: {image, port, …}}) for this deployment.`,
    });
  }

  /**
   * The C15 gate, docker dialect: PLACED means present in the daemon's image
   * store, and a claim NEVER pulls. `--pull=never` on every create is the
   * mechanical half; this is the readable half — an absent image answers in
   * seconds with the one command that fixes it, instead of as a create error
   * an agent has to interpret.
   */
  private refuseAbsentImages(stampId: string, config: K8sStampConfig, dev: DevRealization | null): void {
    const image = dev?.image ?? config.app?.image;
    if (image && !this.docker.imagePresent(image)) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail:
          `stamp '${stampId}' resolves image '${image}', which is not in this daemon's image store, and a claim ` +
          `never pulls — run: docker pull ${image}`,
      });
    }
    // A port-bearing stamp cannot be declared ready without the prober, so a
    // missing prober is a claim-time refusal too, not a boot timeout.
    if (config.app && !this.docker.imagePresent(this.proberImage)) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail:
          `the readiness prober image '${this.proberImage}' is not in this daemon's image store, so no port-bearing ` +
          `stamp could be declared ready — run: docker pull ${this.proberImage}`,
      });
    }
  }

  /**
   * The dev flavor (C16), resolved once at claim. Two refusals, both cheaper
   * here than as a boot that polls out its budget, and one FINDING: the
   * generalized declaration generalized by HALVES. `StampDevApp` — mountPath,
   * command, image, env — and the tree-owner identity are genuinely
   * driver-neutral and land here as `-v` and `--user`. `StampDevManifests` is
   * a Kubernetes stream and does not generalize at all; it is refused by the
   * same refusal that rejects `childManifests`, which is the only consistent
   * place for it.
   */
  private devRealization(spec: DriverClaimSpec, config: K8sStampConfig): DevRealization | null {
    const treePath = spec.options[DEV_TREE_OPTION];
    if (treePath === undefined) return null;
    const dev = config.dev;
    if (!dev) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail:
          `stamp '${spec.stampId}' declares no dev block — the working-tree flavor exists only for stamps that ` +
          `opt in (stamps update adds dev to the approved config)`,
      });
    }
    if (isDevManifests(dev)) {
      // Unreachable through the registry (a dev.manifests block only ever
      // rides a childManifests stamp, refused above) and reachable through a
      // hand-configured static table, which is exactly why it is checked.
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `stamp '${spec.stampId}' declares a dev.manifests stream, which has no meaning on a docker daemon`,
      });
    }
    if (!path.isAbsolute(treePath)) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `${DEV_TREE_OPTION} must be host-absolute (resolved above the seam), got: ${treePath}`,
      });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(treePath);
    } catch {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `dev tree not readable at ${treePath}`,
      });
    }
    if (!stat.isDirectory()) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `dev tree is not a directory: ${treePath}`,
      });
    }
    const app = dev as StampDevApp;
    return {
      treePath,
      mountPath: app.mountPath,
      image: app.image,
      command: app.command,
      env: app.env,
      // The consuming container runs as the OWNER OF THE MOUNTED TREE,
      // stat'd host-side — the same clamp the k8s render applies through its
      // identity tokens, and for the same reason: a fixed image uid would
      // EACCES on a developer's tree, and a root default would write
      // root-owned files into the claimant's workspace.
      user: `${stat.uid}:${stat.gid}`,
    };
  }

  /**
   * One RW tree, one consumer. Two live instances bind-mounting one path
   * would have two workloads writing the same working tree — a
   * corruption-shaped collision no lock exists for. Same-instance replays are
   * never a conflict (that is how claims heal), and the hash is on the
   * network's labels because a path is not a legal label value.
   */
  private refuseSharedDevTree(spec: DriverClaimSpec, treePath: string, install: string): void {
    const holder = this.docker
      .listNetworks([`label=${DEV_ENV_LABELS.install}=${install}`, `label=${TREE_LABEL}=${treeHash(treePath)}`])
      .find((network) => network.Labels[DEV_ENV_LABELS.instance] !== spec.key.instanceId);
    if (!holder) return;
    throw asDevEnvFailureError({
      kind: 'instantiation-failed',
      retryable: false,
      detail:
        `env ${holder.Labels[DEV_ENV_LABELS.env]} already runs from this working tree — one tree has one live ` +
        `consumer; release it or claim from a different checkout`,
    });
  }

  // ---------- discovery ----------

  private envNetworks(installScope: string): DockerNetwork[] {
    return this.docker.listNetworks([
      `label=${DEV_ENV_LABELS.install}=${installScope}`,
      `label=${DEV_ENV_LABELS.env}`,
    ]);
  }

  private networkFor(installScope: string, instanceId: string): DockerNetwork | null {
    return (
      this.docker
        .listNetworks([
          `label=${DEV_ENV_LABELS.install}=${installScope}`,
          `label=${DEV_ENV_LABELS.instance}=${instanceId}`,
        ])
        .at(0) ?? null
    );
  }

  /** @internal handle back-channel */
  workloadsOf(instanceId: string): DockerContainer[] {
    return this.docker.listContainers(
      [`label=${DEV_ENV_LABELS.instance}=${instanceId}`, `label=${ROLE_LABEL}=workload`],
      [],
    );
  }

  /** @internal handle back-channel */
  inspectNetwork(name: string): DockerNetwork | null {
    return this.docker.inspectNetwork(name);
  }

  /** @internal handle back-channel */
  releaseInstance(network: string, instanceId: string): void {
    this.teardown(network, instanceId);
  }

  /**
   * THE readiness definition, in one place, so the answer a handle gives and
   * the answer any future warm gate would give cannot drift apart: every
   * workload is live, and — for a claim that DECLARED a port — something
   * answers that port from inside the env network.
   *
   * `declaredPort` is what the CLAIM declared, read off the network's
   * immutable labels (`declaredPortOf`) rather than off the stamp table, and
   * null means the claim declared no workload at all. That null is the one
   * and only shape for which not probing is honest — a scope-only env IS its
   * scope, so there is nothing to answer and nothing to wait for.
   *
   * EVERY OTHER SHAPE PROBES, INCLUDING THE ONE WITH NO WORKLOAD CONTAINER.
   * Both of the previous non-probing answers were reachable and both reported
   * an env as serving when nothing was: an unresolvable stamp (retired, or a
   * cold registry snapshot) made the port vanish, and a declared workload
   * that had been `docker rm`'d — or that a dying host never created — left
   * an empty list that `every()` waved through. A claim that says active and
   * answers nothing is worse than one that fails.
   *
   * @internal handle back-channel
   */
  probeInstance(network: string, instanceId: string, stampId: string, declaredPort: number | null): boolean {
    const workloads = this.workloadsOf(instanceId);
    if (!workloads.every((workload) => isLiveState(workload.state))) return false;
    // Scope-only: the scope IS the instance. An env that declared nothing and
    // nonetheless HAS containers is not one this driver can vouch for.
    if (declaredPort === null) return workloads.length === 0;
    // Declared a workload and has none. Nothing is serving; the boot deadline
    // turns this into the honest "nothing this stamp declared is running".
    if (workloads.length === 0) return false;
    return this.docker.probeRun(
      network,
      this.proberImage,
      {
        [DEV_ENV_LABELS.install]: this.scope,
        [DEV_ENV_LABELS.instance]: instanceId,
        [ROLE_LABEL]: 'probe',
      },
      probeCommand(stampContainerName(instanceId, stampId), declaredPort),
    );
  }

  /** @internal handle back-channel */
  endpointsFor(instanceId: string, stampId: string, declaredPort: number | null): Record<string, string> {
    // The network name is a real, non-secret, named address SPACE — but not
    // an address. A scope-only env has nothing else to report, which is worth
    // saying out loud: the conformance floor asks every realization for at
    // least one endpoint, and a docker scope is a namespace, not a host.
    //
    // The address comes from the same declared port readiness does, so a ready
    // env's endpoints cannot change shape under the stamp's retirement.
    const endpoints: Record<string, string> = { network: envNetworkName(instanceId) };
    if (declaredPort !== null) {
      endpoints.app = `http://${stampContainerName(instanceId, stampId)}:${declaredPort}`;
    }
    return endpoints;
  }

  // ---------- exposure targets (C14) ----------

  /**
   * What serves this port in this instance RIGHT NOW (@internal handle
   * back-channel) — the seam's optional C14 answer, docker dialect.
   *
   * THE TARGET IS A CONTAINER, WHERE K8S RESOLVES A SERVICE. There is no
   * indirection to read here: a claim realizes one workload container per stamp
   * on the env network, so the target's identity is the STAMP and its address
   * is that container's IP on this network. Both halves are read from the
   * daemon on every call and neither is ever written down — a workload that was
   * removed and re-created comes back on a fresh endpoint, and the daemon's
   * pool may already have handed its old address to another env's container.
   *
   * THE FROZEN NAME IS THE STAMP, NOT THE CONTAINER NAME, and that is the one
   * place the obvious answer was wrong. A container name carries the INSTANCE
   * id, while a name frozen at grant has to outlive instances: supersession
   * (D21) parks a live env's exposure and re-arms it against the SUCCESSOR,
   * whose workload is a new container with a new name. The k8s driver freezes a
   * child-side `<ns>/<name>` for exactly this reason. `--service` still accepts
   * the container name too, because that is what `endpoints.app` prints and
   * what the env's own DNS answers for.
   *
   * THE CLAIM'S DECLARED PORT IS THE WHOLE CATALOG. An `--internal` network
   * publishes nothing, so the only truthful statement this driver holds about
   * which port a workload serves is the one the stamp declared, read off the
   * network's labels — the same source readiness and `endpointsFor` read, so an
   * env's ready address and its exposable target cannot drift apart. Any other
   * port MISSES: the alternative is the dial-time port scan the seam forbids,
   * which here would be a prober container per connection.
   *
   * FAIL CLOSED, ON TWO SEPARATE FACTS: the workload must be RUNNING (a
   * created, paused, restarting or exited container answers nothing) and it
   * must still hold an endpoint on THIS env's network. Either one missing is a
   * miss, and a miss is null — never the address it had a moment ago.
   *
   * NEITHER CAPABILITY MOVES, and the question is worth answering in writing:
   * an exposure is INGRESS, carried by a relay in the host process that dials
   * in, so the env network still has no route out and `sealedEgress` stays
   * true; the isolation string describes what the CLAIMANT reaches, which this
   * does not widen by a byte. And the agent still never touches the daemon —
   * every read below is the host's, on the host's socket, exactly like every
   * other verb in this file.
   */
  resolveExposureTarget(
    network: string,
    instanceId: string,
    declaredPort: number | null,
    request: { service?: string; port: number },
  ): ExposureTargetResolution | null {
    const unreachable = this.exposureUnreachableReason();
    if (unreachable) throw new Error(`this deployment cannot carry an exposure into a claimed env: ${unreachable}`);
    if (declaredPort === null || request.port !== declaredPort) return null;
    const scope = this.docker.inspectNetwork(network);
    if (!scope) return null; // the env is gone; there is nothing to dial
    const addresses = new Map<string, string>();
    for (const member of Object.values(scope.Containers)) {
      const address = endpointAddress(member);
      if (member.Name && address) addresses.set(member.Name, address);
    }
    const candidates: ExposureTargetResolution[] = [];
    for (const workload of this.workloadsOf(instanceId)) {
      // RUNNING, not merely live: `isLiveState` answers "the runtime still
      // holds this instance", which is a different question from "something is
      // listening in there", and only the second one may mint an address.
      if (workload.state !== 'running') continue;
      const service = workloadServiceName(instanceId, workload.name);
      if (!service) continue;
      if (request.service && request.service !== service && request.service !== workload.name) continue;
      const address = addresses.get(workload.name);
      if (!address) continue;
      candidates.push({ service, address, port: request.port });
    }
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      // Unreachable while a claim realizes exactly one workload per stamp, and
      // written anyway because the RULE is the driver's to hold: ambiguity is a
      // grant-time question a human answers with --service, and a driver that
      // grew a second workload would otherwise start picking one silently.
      throw new Error(
        `${candidates.length} workloads serve port ${request.port} in this env ` +
          `(${candidates.map((candidate) => candidate.service).join(', ')}) — ` +
          'name the one to expose with --service',
      );
    }
    return candidates[0];
  }

  /**
   * Why a relay in THIS host process could not reach a claimed env at all, or
   * null when it can. Asked before any address is minted, because the one thing
   * an exposure may never do is hand out a URL that cannot serve.
   *
   * The address this driver resolves is a container IP on a bridge the DAEMON
   * owns, and the only machine that can dial one is the machine whose kernel
   * holds that bridge. `--internal` does not take that away — docker's own
   * `network create` reference says an internal network's containers reach
   * nothing else, while "the host may communicate with any container IP
   * directly" — which is the same asymmetry the file header records for a
   * host-side probe.
   *
   * WHAT THIS REFUSES IS THE CERTAIN CASE, and it is certain by construction: a
   * host process that is not on Linux is talking to a daemon inside a VM
   * (Docker Desktop, colima, Rancher), whose bridge has never been reachable
   * from the outside — "I cannot ping my containers" is a documented Desktop
   * limitation, not a setting. The other shapes of the same problem — a
   * rootless daemon holding its bridge in its own netns, a remote `DOCKER_HOST`
   * — are NOT decidable without interrogating the daemon in ways this driver
   * otherwise never does, so they are named in the skill's troubleshooting
   * instead of guessed at: a wrong "you are fine" is a silent black hole, and a
   * wrong "you are broken" refuses an install that works.
   */
  private exposureUnreachableReason(): string | null {
    if (this.hostPlatform === 'linux') return null;
    return (
      `this host runs ${this.hostPlatform}, so its docker daemon runs inside a VM and no address on an env ` +
      `network is dialable from the host process that would relay the exposure — grant it from a host that ` +
      `shares its daemon's kernel (native Linux docker), or from a driver whose targets this box can route to`
    );
  }

  // ---------- supervision ----------

  private handleFor(network: DockerNetwork): DevEnvInstanceHandle {
    return new DockerInstanceHandle(this, network, {
      bootTimeoutMs: this.bootTimeoutMs,
      probeIntervalMs: this.probeIntervalMs,
      now: this.now,
    });
  }

  /**
   * @internal handle back-channel: subscribe to the ONE install-wide events
   * stream. One subscription fanned out, not a watch per handle like the k8s
   * driver — docker events are a single daemon-wide firehose and N processes
   * would be N readers of the same bytes.
   */
  subscribe(subscription: DockerInstanceSubscription): () => void {
    this.subscriptions.add(subscription);
    this.armWatch();
    return () => this.subscriptions.delete(subscription);
  }

  private armWatch(): void {
    if (this.events || this.disposed) return;
    this.events = this.docker.watchEvents(
      (event) => this.onEvent(event),
      () => this.onWatchDrop(),
    );
  }

  /** Nothing in here may throw: this runs inside the events process's stdout handler. */
  private onEvent(event: DockerEvent): void {
    this.watchBackoffMs = WATCH_BACKOFF_MIN_MS;
    const instanceId = event.Attributes[DEV_ENV_LABELS.instance];
    for (const subscription of [...this.subscriptions]) {
      if (subscription.instanceId !== instanceId) continue;
      try {
        subscription.onEvent(event);
      } catch (error) {
        log.warn('Dev-env docker: event handler failed', { instance: instanceId, error: String(error) });
      }
    }
    try {
      this.reattachClaimant(event);
    } catch (error) {
      log.warn('Dev-env docker: claimant re-attach failed', { error: String(error) });
    }
  }

  /**
   * The obligation docker's imperative networking creates and k8s's label
   * selectors do not: a respawned session is a NEW container, and it is not a
   * member of anything. Every start of one of this install's agent containers
   * re-attaches it to every live claim whose selector it matches.
   *
   * There is a window — between the respawn and this landing — in which a
   * perfectly healthy env reads to the agent as broken. It is small (the
   * event arrives in milliseconds) and it is real, and `resumeClaim` is the
   * second, slower cover for the case where the host itself was down.
   */
  private reattachClaimant(event: DockerEvent): void {
    if (event.Action !== 'start') return;
    const name = event.Attributes.name;
    // Cheap pre-filter so an unrelated container start on a shared daemon
    // costs nothing. The AUTHORITATIVE match is the selector on the network
    // below; this only avoids listing networks for every `docker run` on the
    // machine.
    if (!name || event.Attributes[LABELS.install] !== this.scope) return;
    if (event.Attributes[DEV_ENV_LABELS.install]) return; // one of ours, not a claimant
    for (const network of this.envNetworks(this.scope)) {
      const selector = claimantSelectorOf(network.Labels);
      if (!selector) continue;
      if (!Object.entries(selector).every(([key, value]) => event.Attributes[key] === value)) continue;
      if (Object.values(network.Containers).some((member) => member.Name === name)) continue;
      this.docker.connect(network.Name, name);
    }
  }

  /**
   * A dropped subscription is a GAP: the fresh stream starts from now, so
   * every transition that happened while it was down was never emitted.
   * Re-arm on bounded backoff — never give up, because an unrecovered drop
   * ends supervision for every env of the install at once — and tell every
   * subscriber to reconcile what it missed.
   */
  private onWatchDrop(): void {
    this.events = null;
    if (this.disposed) return;
    const delay = this.watchBackoffMs;
    this.watchBackoffMs = Math.min(this.watchBackoffMs * 2, WATCH_BACKOFF_MAX_MS);
    const timer = setTimeout(() => {
      if (this.disposed) return;
      this.armWatch();
      for (const subscription of [...this.subscriptions]) {
        try {
          subscription.onGap();
        } catch (error) {
          log.warn('Dev-env docker: gap reconcile failed', { instance: subscription.instanceId, error: String(error) });
        }
      }
    }, delay);
    timer.unref?.();
  }
}

interface HandleContext {
  bootTimeoutMs: number;
  probeIntervalMs: number;
  now: () => number;
}

/**
 * One instance's supervision, rebuilt from the network alone.
 *
 * THE BOOT BUDGET'S TWO HONEST SEMANTICS, because they are not the same
 * question and reading them as one is what produced the bug this comment
 * replaces:
 *
 * - WHOSE budget is it? The instance's, anchored on the network's birth
 *   (#215's contract, which the k8s driver takes from a namespace's
 *   creationTimestamp). A restarted host resumes the budget the instance
 *   already spent and never refills it.
 * - When the budget is ALREADY SPENT at adoption, is that the verdict? No. It
 *   is the deadline, and a deadline is when a verdict LANDS, not when its
 *   evidence was gathered. An expired budget plus one failed baseline probe
 *   used to arm the timer at zero, so re-adopting a healthy env that happened
 *   to be mid-restart killed it in the same tick. So an adopted instance whose
 *   budget is spent gets a bounded re-verify window
 *   (`ADOPTION_REVERIFY_INTERVALS` probe intervals of DURATION, never more
 *   than the budget itself) and `bootTimedOut` probes ONE more time before it
 *   fails anything: two probes that far apart, not a poll loop. A wedged claim
 *   still dies within seconds of adoption; a live one resumes.
 */
class DockerInstanceHandle implements DevEnvInstanceHandle {
  readonly key: EnvKey;
  readonly stampId: string;
  /** The env NETWORK's name — the stable runtime name for logs and operator commands. */
  readonly name: string;

  #driver: DockerDevEnvDriver;
  #ctx: HandleContext;
  #releaseRequested = false;
  #readyFired = false;
  #terminalFired = false;
  #everReady = false;
  #polling = false;
  #baselineReady: boolean;
  #failure: DevEnvFailure | null = null;
  #readyCbs: Array<() => void> = [];
  #terminalCbs: Array<(failure?: DevEnvFailure) => void> = [];
  #unsubscribe: (() => void) | null = null;
  #bootTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #bootDeadline: number;
  /** What readiness MEANS here, off the network's immutable labels. See PORT_LABEL. */
  readonly #declaredPort: number | null;

  constructor(driver: DockerDevEnvDriver, network: DockerNetwork, ctx: HandleContext) {
    const labels = network.Labels;
    this.key = { envId: labels[DEV_ENV_LABELS.env], instanceId: labels[DEV_ENV_LABELS.instance] };
    this.stampId = labels[DEV_ENV_LABELS.stamp];
    this.name = network.Name;
    this.#driver = driver;
    this.#ctx = ctx;
    this.#declaredPort = declaredPortOf(labels);
    // The budget anchors on the NETWORK's birth, which the daemon remembers
    // and this process may not: a re-adopted in-flight claim resumes the
    // budget it already spent instead of earning a fresh one per restart. It
    // is the exact role the k8s driver gives a namespace's creationTimestamp,
    // and it is why this driver needs no durable state of its own for it.
    const born = Math.min(Date.parse(network.Created) || ctx.now(), ctx.now());
    const spent = born + ctx.bootTimeoutMs;
    // ...and a budget that ran out while the host was DOWN buys a bounded
    // re-verify window instead of an immediate verdict — see the class
    // comment. Never applies to a budget that is still running (a fresh claim
    // always takes `spent`), and never longer than the budget itself.
    this.#bootDeadline = spent > ctx.now() ? spent : ctx.now() + reverifyWindowMs(ctx);
    this.#baselineReady = this.probe();
    this.#everReady = this.#baselineReady;
    this.#unsubscribe = driver.subscribe({
      instanceId: this.key.instanceId,
      onEvent: (event) => this.onDockerEvent(event),
      onGap: () => this.onGap(),
    });
    if (!this.#baselineReady) {
      this.#bootTimer = setTimeout(() => this.bootTimedOut(), Math.max(0, this.#bootDeadline - ctx.now()));
      this.#bootTimer.unref?.();
    }
  }

  /** The one readiness question this handle ever asks, with its one answer's inputs. */
  private probe(): boolean {
    return this.#driver.probeInstance(this.name, this.key.instanceId, this.stampId, this.#declaredPort);
  }

  async status(): Promise<InstanceStatus> {
    try {
      return this.statusInner();
    } catch (error) {
      throw isDevEnvFailure(error) ? error : normalizeDockerFailure(error);
    }
  }

  private statusInner(): InstanceStatus {
    const network = this.#driver.inspectNetwork(this.name);
    if (!network) {
      if (this.#releaseRequested) return { phase: 'released' };
      return { phase: 'failed', failure: this.#failure ?? { kind: 'instance-died', retryable: false } };
    }
    const workloads = this.#driver.workloadsOf(this.key.instanceId);
    const exited = workloads.some((workload) => !isLiveState(workload.state));
    // THE SAME DECLARED-PORT RULE `probeInstance` APPLIES, applied to the
    // failure question too. `every()` is vacuously true over an empty list, so
    // a claim whose declared container had been `docker rm`'d fell straight
    // past this branch — and the ever-ready latch below then reported READY
    // for an env with nothing in it at all. A gone container is only a VERDICT
    // once the instance has served, though: one that never has is still inside
    // its boot budget, which is the deadline's job to end (`boot timeout:
    // nothing this stamp declared is running`) and not this read's.
    const declaredButAbsent = this.#declaredPort !== null && workloads.length === 0;
    if (exited || (declaredButAbsent && this.readyObserved())) {
      // A server that exits is dead however it exited; the split is only over
      // whether it ever served, which is the retryable/permanent distinction
      // the taxonomy asks for.
      return {
        phase: 'failed',
        failure: this.readyObserved()
          ? { kind: 'instance-died', retryable: false }
          : {
              kind: 'instantiation-failed',
              retryable: false,
              detail: "the stamp's container exited before it ever served",
            },
      };
    }
    // Once ready, the env belongs to the agent: re-probing would report their
    // own restart as a broken env, exactly as the k8s driver's ever-ready
    // latch refuses to re-run a first boot over a live instance. The
    // difference is that this latch is per-HANDLE, because docker labels are
    // immutable and there is nowhere on the runtime to write it — so a
    // restarted host re-probes once and then latches again. It latches over a
    // container that is RESTARTING, never over one that is gone: that case is
    // the branch above.
    if (this.#everReady) return this.ready();
    if (this.probe()) {
      this.#everReady = true;
      return this.ready();
    }
    return { phase: 'provisioning' };
  }

  private ready(): InstanceStatus {
    return {
      phase: 'ready',
      endpoints: this.#driver.endpointsFor(this.key.instanceId, this.stampId, this.#declaredPort),
      // This driver mints nothing. There is no docker analogue of a child
      // kubeconfig an agent could use WITHOUT the socket, and handing one over
      // would be handing over the daemon — see the file header's clamp.
      access: {},
    };
  }

  async release(reason: string): Promise<void> {
    this.#releaseRequested = true;
    this.settle();
    this.#driver.releaseInstance(this.name, this.key.instanceId);
    log.info('Dev-env docker: instance released', { network: this.name, reason });
  }

  onReady(cb: () => void): void {
    if (this.#baselineReady) return; // already ready when obtained — never fires (contract)
    this.#readyCbs.push(cb);
  }

  onTerminal(cb: (failure?: DevEnvFailure) => void): void {
    this.#terminalCbs.push(cb);
  }

  /**
   * The C14 exposure capability (seam, optional): the frozen target name at
   * grant, the address to dial per connection, and null the moment either
   * stops being true. Everything it decides from is read at call time; see the
   * driver's `resolveExposureTarget` for why nothing here may be cached.
   *
   * A RELEASED HANDLE RESOLVES NOTHING, ahead of any daemon read. Teardown
   * removes the workload, so the read would answer null a moment later anyway
   * — the latch is here because "an exposed port dies with its env" must not
   * depend on a teardown having got far enough, and a dial that races a release
   * is precisely the window it must not depend on.
   */
  async resolveExposureTarget(request: { service?: string; port: number }): Promise<ExposureTargetResolution | null> {
    if (this.#releaseRequested) return null;
    return this.#driver.resolveExposureTarget(this.name, this.key.instanceId, this.#declaredPort, request);
  }

  // ---------- internals ----------

  private onDockerEvent(event: DockerEvent): void {
    if (this.#releaseRequested || this.#terminalFired) return;
    if (event.Attributes[ROLE_LABEL] === 'probe') return; // our own prober is not the instance
    try {
      if (event.Action === 'die' || event.Action === 'destroy') {
        this.fireTerminal(
          this.readyObserved()
            ? { kind: 'instance-died', retryable: false }
            : {
                kind: 'instantiation-failed',
                retryable: false,
                detail: "the stamp's container exited before it ever served",
              },
        );
        return;
      }
      if (event.Action === 'start' || event.Action === 'health_status: healthy') this.settleReady();
    } catch (error) {
      // A probe blip degrades to a missed event; the gap reconcile and the
      // boot timer are the backstops.
      log.warn('Dev-env docker: event probe failed', { network: this.name, error: String(error) });
    }
  }

  /**
   * Did this instance EVER serve? Exactly one thing answers that: a probe that
   * came back. `#everReady` is latched by every path that gets one (the
   * baseline in the constructor, `fireReady`, `statusInner`), so it is the
   * whole answer.
   *
   * A container `start` event used to count here too, and it is not evidence
   * of anything: `settleReady` records it BEFORE probing, so an env that
   * started and never answered its port reported "it died" instead of "it
   * never served" — the wrong sentence for the operator who has to fix it.
   */
  private readyObserved(): boolean {
    return this.#everReady;
  }

  /**
   * A container `start` is necessary, not sufficient: the process inside is
   * rarely listening yet. Probe once synchronously — which is what lets a
   * runtime that IS ready at the event fire readiness in the same tick — and
   * fall back to polling the instance's own boot budget.
   */
  private settleReady(): void {
    if (this.#baselineReady || this.#readyFired || this.#terminalFired || this.#releaseRequested) return;
    if (this.probe()) {
      this.fireReady();
      return;
    }
    if (this.#polling) return;
    this.#polling = true;
    void this.pollThenFire().finally(() => {
      this.#polling = false;
    });
  }

  private async pollThenFire(): Promise<void> {
    while (this.#ctx.now() <= this.#bootDeadline) {
      await sleep(this.#ctx.probeIntervalMs);
      if (this.#readyFired || this.#terminalFired || this.#releaseRequested) return;
      try {
        if (this.probe()) {
          this.fireReady();
          return;
        }
      } catch (error) {
        log.warn('Dev-env docker: readiness poll failed; will retry', { network: this.name, error: String(error) });
      }
    }
  }

  private fireReady(): void {
    if (this.#readyFired) return;
    this.#readyFired = true;
    this.#everReady = true;
    this.clearBootTimer();
    for (const cb of this.#readyCbs.splice(0)) cb();
  }

  private fireTerminal(failure: DevEnvFailure): void {
    if (this.#terminalFired || this.#releaseRequested) return;
    this.#terminalFired = true;
    this.#failure = failure;
    this.settle();
    for (const cb of this.#terminalCbs.splice(0)) cb(failure);
  }

  /**
   * The one deadline for a first boot, and it also decides WHICH failure this
   * is: a workload still running but never answering its port is a deadline
   * the same claim could beat next time (retryable), while one that never ran
   * is not.
   *
   * ONE LAST PROBE FIRST, because the deadline is when the verdict lands and
   * not when its evidence was gathered. On a fresh claim that probe is nearly
   * free and closes the race where an env answers between the final poll and
   * the timer. On an ADOPTED instance whose budget expired while the host was
   * down it is the whole difference between resuming a live env and failing
   * it on one baseline blip — see the class comment.
   */
  private bootTimedOut(): void {
    if (this.#readyFired || this.#terminalFired || this.#releaseRequested) return;
    try {
      if (this.probe()) {
        this.fireReady();
        return;
      }
    } catch (error) {
      log.warn('Dev-env docker: boot-deadline probe failed', { network: this.name, error: String(error) });
    }
    let running = false;
    try {
      running = this.#driver.workloadsOf(this.key.instanceId).some((w) => w.state === 'running');
    } catch (error) {
      log.warn('Dev-env docker: boot-deadline workload read failed', { network: this.name, error: String(error) });
    }
    this.fireTerminal({
      kind: 'instantiation-failed',
      retryable: running,
      detail: running
        ? `stamp '${this.stampId}' never answered its port inside the boot budget`
        : 'boot timeout: nothing this stamp declared is running',
    });
  }

  /** The events stream dropped and re-armed: settle whatever transition it swallowed. */
  private onGap(): void {
    if (this.#releaseRequested || this.#terminalFired) return;
    void this.status().then(
      (status) => {
        if (this.#releaseRequested || this.#terminalFired) return;
        if (status.phase === 'failed') this.fireTerminal(status.failure);
        else if (status.phase === 'released') this.fireTerminal({ kind: 'instance-died', retryable: false });
        else if (status.phase === 'ready') this.settleReady();
      },
      (error) => {
        // A failed reconcile is itself a drop; the next one covers it, and the
        // boot timer covers a first boot regardless.
        log.warn('Dev-env docker: gap reconcile failed', { network: this.name, error: String(error) });
      },
    );
  }

  private settle(): void {
    this.clearBootTimer();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  private clearBootTimer(): void {
    if (this.#bootTimer) clearTimeout(this.#bootTimer);
    this.#bootTimer = null;
  }
}

// ---------- helpers ----------

/** The claim's selector, read back off the network's labels. Empty = no claimant was named. */
function claimantSelectorOf(labels: Record<string, string>): Record<string, string> | null {
  const selector: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key.startsWith(CLAIMANT_PREFIX)) selector[key.slice(CLAIMANT_PREFIX.length)] = value;
  }
  return Object.keys(selector).length > 0 ? selector : null;
}

/**
 * The port this claim declared, read back off the network's labels (see
 * PORT_LABEL). Null means the claim declared no workload — the ONE shape a
 * handle may call ready without probing anything.
 *
 * A malformed value reads as null the same way an absent one does, because
 * the alternative is probing a port nobody is listening on and calling the
 * refusal a verdict. Nothing in-tree can write one: the driver formats it from
 * a validated stamp's `app.port`.
 */
function declaredPortOf(labels: Record<string, string>): number | null {
  const raw = labels[PORT_LABEL];
  if (raw === undefined) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * One workload container's EXPOSURE identity: its derived name with the
 * instance stripped back off, which is the whole trick that lets a name frozen
 * at grant survive its instance (see `resolveExposureTarget`). Null for a name
 * this driver did not derive — `stampContainerName` is the only writer, so a
 * name that does not decompose is not a target this driver can freeze.
 */
function workloadServiceName(instanceId: string, containerName: string): string | null {
  const prefix = `${NAME_PREFIX}-${instanceId}-`;
  return containerName.startsWith(prefix) ? containerName.slice(prefix.length) : null;
}

/**
 * The re-verify window an adopted instance gets when its boot budget is
 * already spent: a few probe intervals of DURATION, so it scales with what
 * this deployment thinks a probe costs, and never longer than the budget
 * itself. See `ADOPTION_REVERIFY_INTERVALS` for what those intervals buy —
 * the gap between two probes, not ten of them.
 */
function reverifyWindowMs(ctx: HandleContext): number {
  return Math.min(ADOPTION_REVERIFY_INTERVALS * ctx.probeIntervalMs, ctx.bootTimeoutMs);
}

function treeHash(treePath: string): string {
  return createHash('sha256').update(treePath).digest('hex').slice(0, 32);
}

function validateClaimSpec(spec: DriverClaimSpec): void {
  for (const [key, value] of Object.entries(spec.labels)) {
    if (!LABEL_VALUE_RE.test(value)) {
      // The label bound is seam-wide and deliberately the strictest surface
      // any driver realizes onto, so a spec composed for one driver stays
      // realizable on another. Refused, never mangled.
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `label ${key} is not label-value legal`,
      });
    }
  }
  for (const key of Object.keys(spec.options)) {
    if (!OPTION_KEY_RE.test(key)) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `option key is not label-key legal: ${key}`,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export type { K8sStampConfig };
