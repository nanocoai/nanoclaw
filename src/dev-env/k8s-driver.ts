/**
 * K8s dev-env driver — vcluster per instance, warm pool, on the deployment's
 * own cluster (D3–D6, D18–D19).
 *
 * The realization unit is a NAMESPACE running one vcluster (rendered manifests
 * checked in — no helm at runtime). The namespace name is allocated once and
 * never changes: vcluster bakes its identity (cert SANs, exported kubeconfig
 * server) at apply time, so a pooled instance cannot be renamed at claim.
 * Identity therefore rides entirely on LABELS — a warm slot becomes a claimed
 * instance by a CAS label flip (`--resource-version` guarded), which is also
 * what keeps two concurrent claimers from splitting one slot.
 *
 * Pooling is driver-private (D5): nothing above the seam sees a pool. Pool
 * slots carry install/stamp/pool/slot labels but NO env/instance labels, which
 * is exactly what keeps discovery (`listInstances`) blind to them — adoption
 * must never orphan-release a warm slot. Private is not invisible, though:
 * `observePools` answers what this driver is holding per stamp (counts, never
 * identities), off the same labels, so a `set-pool` author can SEE the fill
 * instead of probing for it with a claim (#21).
 *
 * Supervision is one label-scoped pod watch per live handle (the session pod
 * driver's proven shape). A selector watch on a namespace never NotFound-exits
 * the way a named watch does, so it is safe to arm while the vcluster pod does
 * not exist yet. Drops re-arm via reconciliation with backoff and report the
 * end they missed — never give up, never double-fire. HARD RULE, learned the
 * expensive way on the session driver: no unguarded kubectl call may run
 * inside a watch callback or a fire-and-forget promise — a probe blip must
 * degrade to a missed event, never to an uncaught exception (log.ts turns
 * those into process.exit).
 *
 * Tenant containment: synced tenant pods share the namespace with the
 * control-plane pod, and PLAIN labels sync verbatim — a tenant pod can wear
 * `app=vcluster`. Everything that must distinguish our infrastructure from
 * tenant code (the pod probes, the watch, the netpol egress exception) keys on
 * `vcluster.loft.sh/managed-by` being ABSENT: the syncer stamps it on every
 * synced pod and a tenant cannot shed it. Instance namespaces also carry
 * PodSecurity baseline enforcement — a child cluster-admin must not translate
 * into privileged/hostPath pods on the parent's node.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';

import { realCli, type Cli, type SupervisedProcess } from '../drivers/cli.js';

import { buildClaimRoute, claimRouteName } from './claim-route.js';
import {
  Kube,
  deploymentAvailable,
  isAlreadyExists,
  isConflict,
  normalizeK8sFailure,
  podIsReady,
  withKubectlFlags,
  type KubeObject,
  type WatchEvent,
} from './k8s-kube.js';
import {
  PLACEMENT_LABEL,
  buildPlacementJob,
  buildPlacementNamespace,
  buildPlacementNetpol,
  placementJobName,
  placementNamespaceName,
  type PlacementEgress,
} from './k8s-place.js';
import { placeRef } from './stamp-images.js';
import {
  DEV_TREE_OPTION,
  DEV_TREE_PVC,
  DEV_TREE_STORAGE_CLASS,
  isDevManifests,
  renderDevTreePvc,
  substituteDevTreeIdentity,
  type DevTreeIdentity,
  type StampDevApp,
} from './dev-tree.js';
import { UNSCOPED_MATERIALS, devEnvMaterialsRoot, materialsPath, materialsScopeSlug } from './materials.js';
import { type PoolObservation, type PoolObserver, type StampSource } from './stamp-registry.js';
import {
  APP_STAMP_NAMESPACE,
  BUILTIN_STAMPS,
  devConsumerGate,
  readinessGates,
  renderAppManifests,
  renderDevAppManifests,
  stampImageOrigin,
  substituteInstance,
  validateStampEntry,
  type AppStampSpec,
  type K8sStampConfig,
  type StampReadiness,
} from './stamps.js';
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
  type DriverPlaceSpec,
  type EnvKey,
  type ExposureTargetResolution,
  type InstanceStatus,
} from './types.js';
import {
  VCLUSTER_CONFIG_SECRET,
  VCLUSTER_CONFIG_YAML,
  VCLUSTER_KUBECONFIG_SECRET,
  VCLUSTER_MANIFESTS,
  VCLUSTER_NAME,
  VCLUSTER_NS_TOKEN,
  applyVclusterRuntimeClass,
} from './vcluster-manifests.js';

/**
 * The reserved dev-tree claim option now lives with the rest of the C16
 * vocabulary (dev-tree.ts); re-exported here because this driver's suite and
 * the k8s-side helpers below have always read it from this module. On this
 * driver the option additionally forces the cold path past the pool, so a dev
 * claim can never land on a baked warm slot.
 */
export { DEV_TREE_OPTION };

/**
 * The parent-side static PV realizing one dev claim's tree. Named from the
 * instance NAMESPACE so every teardown path can derive it from runtime state
 * alone — a PV is cluster-scoped and does not die with the namespace, which
 * is exactly why it needs explicit deletes plus an orphan sweep (the same
 * pattern as the per-claim routes).
 */
export function devTreePvName(namespaceName: string): string {
  return `nanoclaw-dev-tree-${namespaceName}`;
}

/**
 * The parent-side name the vcluster syncer gives the child's dev PVC:
 * `<name>-x-<child-ns>-x-<vcluster-name>` — deterministic (verified live on
 * the synced baked claim), which is what makes claimRef pre-binding possible
 * at all: the PV exists before the syncer ever creates the claim it binds.
 * A pure formula since C16: the PVC name is the platform constant and the
 * namespace is the stamp's CONSUMER namespace (`default` for the app shape,
 * the readiness namespace for childManifests).
 */
export function syncedDevTreePvcName(consumerNamespace: string): string {
  return `${DEV_TREE_PVC}-x-${consumerNamespace}-x-${VCLUSTER_NAME}`;
}

/**
 * The syncer's own statement of what a parent object came from. Preferred over
 * the name formula wherever it is present: the formula is deterministic in the
 * direction we WRITE (child → parent) and only mostly invertible in the
 * direction we READ, because a child namespace containing `-x-` splits
 * ambiguously. The annotations are the runtime saying it outright.
 */
const SYNCED_NAME_ANNOTATION = 'vcluster.loft.sh/object-name';
const SYNCED_NAMESPACE_ANNOTATION = 'vcluster.loft.sh/object-namespace';
/** Syncer-stamped on every synced object — what tells a tenant's Service from our control plane's. */
const SYNCED_BY_LABEL = 'vcluster.loft.sh/managed-by';

/**
 * The child-side identity of a parent object the syncer materialized, or null
 * when the name is not one of ours. Annotations first, then the inverse of
 * `<name>-x-<child-ns>-x-<vcluster>` — split at the LAST `-x-` before the
 * suffix, which is exact for every namespace that does not itself contain
 * `-x-` (and such a namespace simply reads as a different, still-consistent
 * identity, since the same reading is used on both the freeze and the dial).
 */
export function childObjectIdentity(object: KubeObject): { namespace: string; name: string } | null {
  const annotated = object.metadata?.annotations;
  const name = annotated?.[SYNCED_NAME_ANNOTATION];
  const namespace = annotated?.[SYNCED_NAMESPACE_ANNOTATION];
  if (name && namespace) return { namespace, name };
  const parent = object.metadata?.name ?? '';
  const suffix = `-x-${VCLUSTER_NAME}`;
  if (!parent.endsWith(suffix)) return null;
  const head = parent.slice(0, -suffix.length);
  const split = head.lastIndexOf('-x-');
  if (split <= 0) return null;
  return { namespace: head.slice(split + 3), name: head.slice(0, split) };
}

/** Driver-private namespace labels — the pool machinery, invisible to the seam. */
const POOL_LABEL = 'nanoclaw-dev-pool';
const SLOT_LABEL = 'nanoclaw-dev-slot';
/**
 * WHICH approved definition a warm slot was filled from — the hot loop's
 * missing fact, and the reason `stamps update` used to be a lie.
 *
 * `update()` bumps the registry version and the next reconcile picks the new
 * config up, but a slot filled at v(n−1) carried no version at all: it counted
 * as capacity so no replacement booted, it survived the reap (which only ever
 * looked for a removed POOL id), and `claimFromPool`'s selector had no version
 * term — so the first claims after every fix ran the PREVIOUS artifact while
 * `dev_envs.stamp_version` recorded the new one, silently. That is not
 * staleness; it is a provenance lie in the one table the whole chain exists to
 * make truthful.
 *
 * With the label written at fill and read in all three places, the recorded
 * version is true BY CONSTRUCTION — the pool can only ever hand out a
 * current-version slot — so nothing above the seam needs a new verb.
 *
 * ABSENT is meaningful: a code-provided stamp has no version (its definition
 * updates with the code that renders it), so its slots carry no label and the
 * selector asks for the label's ABSENCE. Which also means a slot filled before
 * this label existed reads as stale for a registered stamp and is drained —
 * conservative, and correct: nothing can say what it was filled from.
 */
const STAMP_VERSION_LABEL = 'nanoclaw-dev-stamp-version';
/**
 * The claim's opaque materials scope, slugged. On the runtime because the
 * materials path must be derivable from runtime-visible state alone: adoption
 * rebuilds handles from labels, and a handle that could not find its own
 * minted kubeconfig would re-mint it somewhere the agent is not looking.
 */
const SCOPE_LABEL = 'nanoclaw-dev-scope';
/** Driver-private annotations. */
const STATE_ANNOTATION = 'nanoclaw-dev/state';
/**
 * The pod that WAS the instance when it first became ready. Persisted for the
 * same reason readiness is: the frozen-instance rule (a replacement pod means
 * the world we handed over is gone) has to survive a host restart, or a
 * rediscovered handle silently accepts a fresh empty vcluster in its place.
 */
const READY_POD_ANNOTATION = 'nanoclaw-dev/ready-pod';
const FAILURE_ANNOTATION = 'nanoclaw-dev/failure';
const OPTION_PREFIX = 'nanoclaw-dev/option.';
const FILL_STARTED_ANNOTATION = 'nanoclaw-dev/fill-started';
/**
 * WHEN a pool fill died. Nothing reaps a pool corpse, so the count of them is
 * cumulative for the life of the pool — and a number that only ever grows is
 * read as a live state and trusted as one. The time is what makes it history
 * an author can judge: `2 dead fills, last 3m ago` is a broken stamp, the same
 * two words with `last 3h ago` beside a warm slot are a pool that recovered.
 */
const FAILED_AT_ANNOTATION = 'nanoclaw-dev/failed-at';
/**
 * Where this claim's per-claim route (D19) lives. On the runtime because every
 * CLOSE path must find the route from runtime state alone: the NetworkPolicy
 * is authored in the CLAIMANT'S namespace and does not die with the child's,
 * and a restarted host rebuilds handles from the instance namespace — which is
 * therefore where the pointer back to the route has to be.
 */
const CLAIMANT_NS_ANNOTATION = 'nanoclaw-dev/claimant-ns';

/**
 * Selects the control-plane pod and ONLY it: `app` alone is tenant-forgeable
 * (labels sync verbatim); managed-by is syncer-stamped on every synced pod.
 */
const VCLUSTER_POD_SELECTOR = 'app=vcluster,!vcluster.loft.sh/managed-by';
/**
 * Containment floor for tenant workloads on the parent node. `baseline` blocks
 * privileged/hostPath/hostNetwork (the node-escape vectors) while admitting
 * the syncer (root, but no escalation) — `restricted` would reject it.
 */
const NAMESPACE_SAFETY_LABELS = {
  'pod-security.kubernetes.io/enforce': 'baseline',
  'pod-security.kubernetes.io/warn': 'baseline',
};

const DEFAULT_BOOT_TIMEOUT_MS = 10 * 60_000;
const RBAC_PROPAGATION_RETRY_MS = 500;
const POOL_RECONCILE_INTERVAL_MS = 60_000;
const SECRET_POLL_INTERVAL_MS = 2_000;
const SECRET_POLL_ATTEMPTS = 45;
/**
 * Per-call budget for the probe path. Readiness probing runs inside watch
 * callbacks and poll loops and costs several execs; at kubectl's default 30s
 * each, one unreachable apiserver turns a probe into a minutes-long stall of
 * whatever called it. An app that cannot answer in five seconds is not ready.
 */
const PROBE_TIMEOUT_MS = 5_000;
const WATCH_BACKOFF_MIN_MS = 1_000;
const WATCH_BACKOFF_MAX_MS = 30_000;
/** kubelet's default nodeStatusMaxImages — at or past it the image report may be truncated (see probeImage). */
const NODE_IMAGE_REPORT_CAP = 50;
/**
 * kubelet's `MaxNamesPerImageInNodeStatus` — a SECOND truncation, on a
 * different axis, and the one that actually fired.
 *
 * The entry cap above drops whole images. This one drops NAMES from an image
 * that IS reported: five per entry, the rest silently gone. Rebuild one
 * repository often enough and a single entry accumulates more than five refs,
 * at which point kubelet publishes some and the gate reads the others as
 * absent.
 *
 * MEASURED on a live runc cluster, 2026-08-26. containerd held 94 refs;
 * node.status carried 52 names across 32 entries — comfortably under the
 * 50-entry cap, so the clamp above never fired. One entry was the agent image
 * with exactly five names, ALL of them digests, every tag dropped — including
 * `nanoclaw-agent-v2-43600d9b:runc-1`, which the stamp names. The gate closed
 * the claim path and drained the warm pool over an image sitting on the node.
 *
 * Same clamp, same direction: at the cap, absence is unprovable.
 */
const NODE_IMAGE_NAMES_CAP = 5;

/**
 * `kubectl apply` phrasings that are the manifests' own fault. Deterministic:
 * re-applying the same stream gets the same rejection, so polling it to the
 * boot deadline — and then calling the timeout retryable — would burn a whole
 * boot budget per attempt, forever, with the cause living only in warn lines.
 * childManifests is operator-suppliable raw text, so this is an expected
 * config error, not an exotic one. Unreachability phrasings stay out:
 * weather reads as "not ready yet".
 */
const STAMP_REJECTION_RE =
  /is invalid|Invalid value|error validating|unknown field|unable to recognize|no matches for kind|unable to decode|BadRequest/i;
const RELAY_ADOPTION_RETRY_RE = /ECONNREFUSED|connection refused|timed out|timeout|temporarily unavailable|transient/i;
const RELAY_ADOPTION_RETRY_MS = 5_000;

const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const NS_PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,53}$/;
const OPTION_KEY_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,54}[A-Za-z0-9])?$/;

/** Driver-private corner of the materials tree: the kubeconfigs the DRIVER uses to reach children. */
const CHILD_ACCESS_DIR = '.child-access';

// The stamp vocabulary lives with the stamps; re-exported because this is the
// driver's configuration surface and its importers should not need to know
// where the type moved.
export type { K8sStampConfig, StampReadiness };

/** The stamps a deployment knows when its configuration names none. */
function defaultStamps(): Record<string, K8sStampConfig> {
  return { ...BUILTIN_STAMPS };
}

/**
 * The subject that gets per-namespace access minted at instance creation.
 * The deployment posture that wants this: the host holds only a narrow
 * cluster-scoped grant (namespaces CRUD + roles/rolebindings create with
 * escalate/bind, admission-pinned to dev namespaces), and every object-level
 * permission — including reading the child kubeconfig secret — exists only
 * inside namespaces the driver itself created. Reads stay namespace-scoped.
 * Unset = the driver assumes its kubeconfig already reaches (local k3s,
 * operator kubeconfig, CI).
 */
export interface K8sAccessSubject {
  kind: 'ServiceAccount' | 'User' | 'Group';
  name: string;
  namespace?: string;
}

export interface K8sDevEnvDriverOptions {
  installScope: string;
  cli?: Cli;
  /** Namespace name prefix for every instance this driver creates. */
  namespacePrefix?: string;
  /** The stamps this deployment knows; an unknown stamp is a claim-time refusal. */
  stamps?: Record<string, K8sStampConfig>;
  /** Warm slots to keep per stamp. Empty = every claim boots cold. */
  pools?: Record<string, number>;
  /**
   * The stamps registry's sync window (C12): registered stamps join the
   * static table above, which WINS on an id collision — code-provided
   * definitions must update with the code that renders them, never drift
   * behind a frozen row. Registry pool sizes merge the same way. Refreshed
   * on the async edges (claim, pool reconcile); probe paths read the
   * snapshot synchronously.
   */
  stampSource?: StampSource;
  /** Where minted child kubeconfigs live; handed out by path, never by value. */
  materialsDir?: string;
  /** When set, a Role+RoleBinding for this subject is minted into every instance namespace. */
  hostAccessSubject?: K8sAccessSubject;
  /**
   * The C15 placement wiring: the gateway proxy the pull rides (ruling 1)
   * and the node-present placer image. UNSET on a deployment whose gateway
   * has no registry-egress catalog entry yet — placeImage then refuses with
   * that reason on every attempt, recorded on the row, and nothing pulls
   * around the gateway (see gatewayImageResolver's TODO for the same leg).
   */
  placement?: PlacementEgress;
  /** Optional parent-owned transport projected into claimed instances. The
   * driver supplies only lifecycle and its existing kubectl boundary; identity
   * minting and rendered child changes remain owned by the transport. */
  instanceRelay?: K8sInstanceRelay;
  bootTimeoutMs?: number;
  now?: () => number;
}

export interface K8sInstanceRelayContext {
  envId: string;
  instanceId: string;
  ownerRef: string;
  stampId: string;
  namespace: string;
}

export interface K8sInstanceRelayCluster {
  apply(docs: string): void;
  serviceIp(namespace: string, name: string): string | null;
  /** Delete a relay-owned companion namespace. The instance namespace remains
   * owned by the driver and is never deleted through this seam. */
  deleteNamespace?(namespace: string): void;
  /** Public trust material projected by the child; absent while a cold child
   * is still minting. Optional for non-Kubernetes test adapters. */
  secretData?(namespace: string, name: string, key: string): string | null;
  /** Re-apply the already-selected child stamp after relay-owned render
   * values exist. False means the child API is not ready yet. */
  renderChild?(): boolean;
}

export interface K8sInstanceRelay {
  ensure(context: K8sInstanceRelayContext, cluster: K8sInstanceRelayCluster): Promise<void>;
  renderChild(namespace: string, manifests: string): string;
  /**
   * Tear down what the relay owns for this instance.
   *
   * The cluster seam is handed to RELEASE as well as to `ensure` because a
   * release must not depend on this process having served the claim. Relay
   * state is process memory; a host restart between claim and release empties
   * it, and a teardown that can only run from memory silently orphans whatever
   * the relay created. Everything relay-owned is derivable from the instance
   * namespace, so it is reachable with or without that memory.
   *
   * Optional so an existing implementer stays type-compatible.
   */
  release(namespace: string, cluster?: K8sInstanceRelayCluster): Promise<void>;
}

interface ChildAccess {
  /** Path to the driver's own copy of the exported child kubeconfig. */
  kubeconfig: string;
  /** The kubectl flags that make that kubeconfig usable from off-cluster. */
  flags: string[];
}

export class K8sDevEnvDriver implements DevEnvDriver, PoolObserver {
  readonly kind = 'k8s';
  private readonly cli: Cli;
  private readonly kube: Kube;
  private readonly scope: string;
  private readonly prefix: string;
  private readonly stamps: Record<string, K8sStampConfig>;
  private readonly stampSource: StampSource | null;
  private readonly pools: Record<string, number>;
  private readonly materialsDir: string;
  private readonly hostAccessSubject: K8sAccessSubject | null;
  private readonly placement: PlacementEgress | null;
  private readonly instanceRelay: K8sInstanceRelay | null;
  /** One warn per process for a netpol residual — the message repeats nothing new per placement. */
  private placementResidualWarned = false;
  private readonly bootTimeoutMs: number;
  private readonly now: () => number;
  private fillInFlight = false;
  private disposed = false;
  private reconciler: ReturnType<typeof setInterval> | null = null;
  private readonly relayAdoptionRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-namespace child API access, resolved once: the clusterIP and the minted file both outlive the boot. */
  private readonly childAccessCache = new Map<string, ChildAccess>();
  /**
   * Stamp applies the child apiserver rejected deterministically, by
   * namespace. In-memory ONLY, and deliberately: the rejection re-observes on
   * the first probe of any process, so it needs no persistence — and writing
   * the failed annotation here, before a boot path owns the verdict, would
   * hand the instance to the residue reaper mid-boot and turn the specific
   * failure into a generic instance-died. The failure paths that consume this
   * (markSlotFailed, markBootFailed) persist it exactly as they do every
   * other boot failure.
   */
  private readonly stampRejections = new Map<string, string>();
  /**
   * Which readiness gates were still not Available the last time each
   * namespace was probed — the one sentence a boot timeout could not say.
   *
   * A stamp that never converges dies as `stamp '<id>' never became ready
   * inside its instance`, which names the stamp and nothing else: every gate
   * failure, from a missing image to a seed script that cannot run, arrives
   * as that same sentence ten minutes late. The gate names are already
   * computed on every probe, so remembering the last set costs one map write
   * and turns the verdict into somewhere to look. Same shape, same lifetime
   * and same cleanup as `stampRejections` above.
   */
  private readonly stampUnreadyGates = new Map<string, string>();
  /** One-shot latch for the node-image blindness warning below. */
  private nodeImageBlindWarned = false;
  /**
   * Claimant namespaces this PROCESS has opened routes in. The orphan sweep's
   * second source: annotations alone go blind the moment the last live
   * instance is gone (release blips its close, namespace delete succeeds → no
   * annotation names the namespace, and the leaked route would sit until a
   * future claim re-taught it). Process-lifetime memory covers exactly that
   * window — the blip and the sweep usually share a process.
   */
  private readonly seenClaimantNamespaces = new Set<string>();
  /**
   * Dev-tree paths by instance namespace. A CACHE of the runtime, never the
   * truth: the path persists as the option annotation, and every path that
   * can reach a dev instance re-teaches this map first (claim, heal, handle
   * construction/adoption) — probe paths then read it without a kubectl get
   * per 2s poll.
   */
  private readonly devTrees = new Map<string, string>();
  /** Resolved once per process — single-node substrate; see claimantNodeName. */
  private nodeName: string | null = null;

  constructor(options: K8sDevEnvDriverOptions) {
    this.cli = options.cli ?? realCli('kubectl');
    this.kube = new Kube(this.cli);
    this.scope = options.installScope;
    this.prefix = options.namespacePrefix ?? 'nanoclaw-dev';
    if (!NS_PREFIX_RE.test(this.prefix)) throw new Error(`invalid dev-env namespace prefix: ${this.prefix}`);
    this.stamps = options.stamps ?? defaultStamps();
    // Refuse at construction, per entry — the full refusal set lives with the
    // stamp vocabulary (stamps.ts) because the registry's create path must
    // earn the SAME refusals at registration time, in front of the approver.
    // codeProvided: a static table cannot carry a registry-origin image —
    // no row means nothing ever places for it (C15).
    for (const [stampId, config] of Object.entries(this.stamps)) {
      validateStampEntry(stampId, config, { codeProvided: true });
    }
    this.stampSource = options.stampSource ?? null;
    // A POOL MAY NAME ANY STAMP, and this deliberately does not check which.
    //
    // It used to: `if (!(stampId in this.stamps)) throw`. `this.stamps` is the
    // CODE-PROVIDED table, so that validated a pool against the builtins and
    // never against the registry — which meant a pool for a REGISTERED stamp,
    // the ordinary case, was fatal. Fatal literally: the driver is constructed
    // inside `onHostStart` and `startHostModules` rethrows ("A failed start
    // aborts host startup"), so a deployment profile naming a registered stamp
    // here produced a host unit that would not start, on every deploy, with a
    // message that named a stamp and never mentioned the profile field that
    // caused it. Measured on the composed runc tree: `{"governed-child": 1}`
    // threw, and so did `{"governed-child": 0}` — it did not even skip a
    // zero-slot entry.
    //
    // The check could not be repaired in place, only moved: at CONSTRUCTION the
    // registry is not loaded, so the set of legitimate ids is not yet knowable
    // here. And the builtin table is transitional — it is expected to empty
    // out — so validating against it was aiming at a shrinking target.
    //
    // Nothing is lost by dropping it, because a pool that cannot fill is
    // ALREADY visible, and better: `poolTargets()` merges this map with the
    // registry's own `pool_size` rows, a fill for an unresolvable stamp fails,
    // and `renderPool`/`renderDeadFills` show it on `ncl stamps get` as dated
    // dead fills — "pool=1 (warm 0, filling 1) — 2 dead fills, last 20s ago",
    // which is the reading that tells an operator to stop waiting. A refusal
    // that kills the host is a wildly disproportionate answer to a
    // misconfigured warm slot.
    this.pools = options.pools ?? {};
    this.materialsDir = options.materialsDir ?? devEnvMaterialsRoot();
    this.hostAccessSubject = options.hostAccessSubject ?? null;
    this.placement = options.placement ?? null;
    this.instanceRelay = options.instanceRelay ?? null;
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  capabilities(): DevEnvDriverCapabilities {
    // sealedEgress is honest: the rendered bundle carries the D19 default-deny
    // NetworkPolicies; the deployment's CNI is expected to enforce them (k3s
    // does, via its embedded controller).
    // imagePull is a DRIVER property — the realization exists (placeImage);
    // whether this deployment's gateway egress is wired is configuration,
    // answered per placement with the reason on the row, not a capability lie
    // that would refuse registration of stamps the driver can realize.
    return { isolation: 'vcluster', sealedEgress: true, imagePull: true, imageBuild: false };
  }

  private relayContext(namespace: string, spec: DriverClaimSpec): K8sInstanceRelayContext {
    return {
      envId: spec.key.envId,
      instanceId: spec.key.instanceId,
      ownerRef: spec.materialsScope ?? UNSCOPED_MATERIALS,
      stampId: spec.stampId,
      namespace,
    };
  }

  private async ensureInstanceRelay(namespace: string, spec: DriverClaimSpec): Promise<void> {
    if (!this.instanceRelay) return;
    await this.ensureRelayContext(this.relayContext(namespace, spec));
  }

  private async ensureRelayContext(context: K8sInstanceRelayContext): Promise<void> {
    if (!this.instanceRelay) return;
    await this.instanceRelay.ensure(context, {
      ...this.relayCluster(),
      renderChild: () => this.stampReady(context.namespace, context.stampId, true),
    });
    this.cancelRelayAdoptionRetry(context.namespace);
  }

  /**
   * The cluster operations the relay is allowed to reach the parent through.
   *
   * Context-free on purpose: everything here is addressed by explicit
   * namespace, which is what lets RELEASE use the same seam as `ensure`
   * without a claim's context to rebuild.
   */
  private relayCluster(): K8sInstanceRelayCluster {
    return {
      apply: (docs) => this.kube.apply(docs),
      deleteNamespace: (companionNamespace) => this.kube.deleteNamespace(companionNamespace),
      serviceIp: (serviceNamespace, name) => {
        const value = this.kube.getJson(['service', name, '-n', serviceNamespace])?.spec?.clusterIP;
        return value && value !== 'None' ? value : null;
      },
      secretData: (secretNamespace, name, key) => {
        try {
          return this.kube.getSecretData(secretNamespace, name, key, { timeoutMs: PROBE_TIMEOUT_MS });
        } catch {
          return null;
        }
      },
    };
  }

  private cancelRelayAdoptionRetry(namespace: string): void {
    const timer = this.relayAdoptionRetries.get(namespace);
    if (timer) clearTimeout(timer);
    this.relayAdoptionRetries.delete(namespace);
  }

  /** A parent Gateway rollout is weather, not a terminal child verdict. The
   * Host commonly starts before Gateway is ready, so one-shot adoption leaves
   * every active child discoverable but permanently unreconciled. Retry only
   * transport-shaped failures; manifest/RBAC refusals stay deterministic. */
  private scheduleRelayAdoption(context: K8sInstanceRelayContext): void {
    if (this.disposed || this.relayAdoptionRetries.has(context.namespace)) return;
    const timer = setTimeout(() => {
      this.relayAdoptionRetries.delete(context.namespace);
      if (this.disposed || !this.kube.getNamespace(context.namespace)) return;
      void this.ensureRelayContext(context).then(
        () => log.info('Dev-env k8s: parent relay adoption recovered', { namespace: context.namespace }),
        (error) => {
          if (RELAY_ADOPTION_RETRY_RE.test(String(error))) this.scheduleRelayAdoption(context);
          else log.warn('Dev-env k8s: parent relay adoption retry refused', {
            namespace: context.namespace,
            error: String(error),
          });
        },
      );
    }, RELAY_ADOPTION_RETRY_MS);
    timer.unref?.();
    this.relayAdoptionRetries.set(context.namespace, timer);
  }

  /** Called by the instance handle before namespace deletion. Channel
   * revocation is best-effort here: deleting the namespace removes the key and
   * the short lease is the fail-closed backstop if the control plane is down. */
  async releaseInstanceRelay(namespace: string): Promise<void> {
    if (!this.instanceRelay) return;
    this.cancelRelayAdoptionRetry(namespace);
    try {
      await this.instanceRelay.release(namespace, this.relayCluster());
    } catch (error) {
      log.warn('Dev-env k8s: parent relay release failed; namespace teardown continues', {
        namespace,
        error: String(error),
      });
    }
  }

  async ensureReady(): Promise<void> {
    try {
      this.kube.version();
    } catch {
      throw asDevEnvFailureError({ kind: 'driver-unavailable', retryable: true });
    }
    this.startPoolReconciler();
    this.scheduleReconcile();
  }

  /** Stop background pool work — tests and host shutdown. */
  dispose(): void {
    this.disposed = true;
    if (this.reconciler) clearInterval(this.reconciler);
    this.reconciler = null;
    for (const timer of this.relayAdoptionRetries.values()) clearTimeout(timer);
    this.relayAdoptionRetries.clear();
  }

  async claim(spec: DriverClaimSpec): Promise<DevEnvInstanceHandle> {
    if (!this.stampFor(spec.stampId)) {
      // The registry is async and the snapshot may be cold — one guarded
      // refresh before refusing. A registry read blip must not take down a
      // claim of a stamp the snapshot (or the static table) already knows.
      try {
        await this.stampSource?.refresh();
      } catch (error) {
        log.warn('Dev-env k8s: stamp registry refresh failed at claim', { error: String(error) });
      }
    }
    if (!this.stampFor(spec.stampId)) {
      // The refusal says WHY when it can (#21): a claim that raced a
      // retirement gets 'retired', not a bare 'no such stamp' — the id
      // resolved minutes ago, and the honest cause is what tells the agent
      // re-registration (not a typo hunt) is the way forward.
      if (this.stampSource?.retiredStamp?.(spec.stampId)) {
        throw stampUnknown(
          `stamp '${spec.stampId}' is retired on this deployment — live envs keep running, but new claims need a fresh registration`,
        );
      }
      throw stampUnknown(`no stamp '${spec.stampId}' in this deployment`);
    }
    validateClaimSpec(spec);
    this.validateDevTreeOption(spec);

    try {
      return await this.claimInner(spec);
    } catch (error) {
      // Whatever path threw — discovery, flip, cold boot — only taxonomy
      // shapes cross the seam.
      throw isDevEnvFailure(error) ? error : normalizeK8sFailure(error);
    }
  }

  private async claimInner(spec: DriverClaimSpec): Promise<DevEnvInstanceHandle> {
    // Idempotent on key: a live namespace for this instance IS the claim — a
    // caller's replay converges it (resumeExisting) rather than duplicating it.
    const install = spec.labels[DEV_ENV_LABELS.install];
    // Runs inside the taxonomy envelope (a PV list blip must cross the seam
    // normalized); same-instance replays pass through it untouched.
    const devTree = spec.options[DEV_TREE_OPTION];
    if (devTree) this.refuseSharedDevTree(spec, devTree);
    const existing = this.liveNamespaces(
      `${DEV_ENV_LABELS.install}=${install},${DEV_ENV_LABELS.instance}=${spec.key.instanceId}`,
    )[0];
    if (existing) {
      const name = existing.metadata!.name!;
      await this.resumeExisting(existing, spec);
      return this.handleFor(this.kube.getNamespace(name) ?? existing);
    }

    const fromPool = this.claimFromPool(spec, install);
    if (fromPool) {
      const name = fromPool.metadata!.name!;
      try {
        await this.ensureInstanceRelay(name, spec);
      } catch (error) {
        // The slot has already been claimed by CAS and must never be handed to
        // another owner. Retain it for operator inspection/recovery; the
        // default-deny namespace keeps it quarantined while the registry marks
        // this claim failed.
        log.warn('Dev-env k8s: claimed slot relay setup failed; instance retained', {
          namespace: name,
          error: String(error),
        });
        throw error;
      }
      this.scheduleReconcile();
      return this.handleFor(fromPool);
    }

    const namespaceName = `${this.prefix}-${randomBytes(4).toString('hex')}`;
    try {
      this.createInstanceNamespace(namespaceName, {
        labels: { ...spec.labels, [POOL_LABEL]: spec.stampId, [SCOPE_LABEL]: claimScope(spec) },
        annotations: optionAnnotations(spec.options),
      });
      // The dev tree's PV rides the atomic block, right after the namespace:
      // it must exist before the syncer ever creates the child's claim (the
      // pre-bind beats the provisioner race only when the PV is first), and
      // a claim that cannot author it must leave nothing behind.
      if (spec.options[DEV_TREE_OPTION]) {
        this.devTrees.set(namespaceName, spec.options[DEV_TREE_OPTION]);
        this.ensureDevTreePv(namespaceName, spec);
      }
      await this.applyInstanceBundle(namespaceName);
      await this.ensureInstanceRelay(namespaceName, spec);
      // Ownership settled at create (the labels ARE the claim); the route
      // opens inside the atomic block because a claim whose route cannot open
      // hands out an env its owner cannot reach — allocate all or nothing.
      this.openClaimRoute(namespaceName, spec);
    } catch (error) {
      // Atomic claim: allocate all or leave nothing.
      try {
        this.closeClaimRoute(spec.claimantNamespace, spec.key.instanceId);
        if (spec.options[DEV_TREE_OPTION]) this.deleteDevTreePv(namespaceName);
        this.kube.deleteNamespace(namespaceName);
        this.forgetChild(namespaceName);
      } catch {
        /* best effort; the residue sweep is the backstop */
      }
      throw error;
    }
    const created = this.kube.getNamespace(namespaceName);
    if (!created) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: 'namespace vanished during claim',
      });
    }
    this.scheduleReconcile();
    return this.handleFor(created);
  }

  /**
   * The seam's resume (adoption's converge half): finish whatever a dying
   * host left half-done for an in-flight claim, WITHOUT minting anything.
   * Exactly the heals a replayed claim gets — and none of its allocation
   * paths (pool flip, cold boot): an instance the runtime no longer holds is
   * the registry's fact to settle, and this call answers it by doing nothing.
   * Claim-time refusals (tree validation, the shared-tree guard) do not
   * re-run either — the claim already earned them, and post-hoc verdicts on
   * a tree that changed belong to the probe path (see stampReady).
   */
  async resumeClaim(spec: DriverClaimSpec): Promise<void> {
    const install = spec.labels[DEV_ENV_LABELS.install];
    try {
      const existing = this.liveNamespaces(
        `${DEV_ENV_LABELS.install}=${install},${DEV_ENV_LABELS.instance}=${spec.key.instanceId}`,
      )[0];
      if (!existing) return;
      await this.resumeExisting(existing, spec);
    } catch (error) {
      // Only taxonomy shapes cross the seam — same envelope as claim.
      throw isDevEnvFailure(error) ? error : normalizeK8sFailure(error);
    }
  }

  /**
   * Idempotent convergence of an instance that already exists — the shared
   * body of a replayed claim and of adoption's resume.
   */
  private async resumeExisting(existing: KubeObject, spec: DriverClaimSpec): Promise<void> {
    const name = existing.metadata!.name!;
    // An instance realized before the per-owner layout existed carries no
    // scope, so its re-mint would land in a directory no sandbox mounts —
    // a path `envs get` prints and the agent cannot open. Asserting the
    // claim is where that gets healed, and only when absent: ownership of
    // an instance id never changes hands.
    this.healScopeLabel(existing, claimScope(spec));
    // Dev claims converge through here too: re-teach the probe paths where
    // the tree lives, and heal a PV that died between namespace-create and
    // PV-create (create is AlreadyExists-tolerant, so intact = no-op).
    this.rememberDevTree(existing);
    if (spec.options[DEV_TREE_OPTION]) this.ensureDevTreePv(name, spec);
    // The claim may have died between create and apply; apply is idempotent,
    // so healing is just doing the apply again. Warm-origin and already-ready
    // instances pass through it as a no-op. For an instance that has never
    // been ready the readiness probe is also the stamp's heal (see
    // stampReady); for one that has, the stamp is the agent's business.
    if (!nsFailed(existing) && !this.instanceReady(name, spec.stampId, nsEverReady(existing))) {
      await this.applyInstanceBundle(name);
    }
    await this.ensureInstanceRelay(name, spec);
    // The route heals here too: create is AlreadyExists-tolerant, so an
    // intact route is a no-op and a missing one — died between open and here,
    // or deleted by hand — comes back. Ownership of an instance id never
    // changes hands, so re-opening for the same spec is re-opening for the
    // same group.
    this.openClaimRoute(name, spec);
  }

  async listInstances(installScope: string): Promise<DevEnvInstanceHandle[]> {
    // Claimed instances only: the env label exists. Pool slots carry no env
    // label and must stay invisible — adoption would orphan-release them.
    const namespaces = this.liveNamespaces(`${DEV_ENV_LABELS.install}=${installScope},${DEV_ENV_LABELS.env}`);
    if (this.instanceRelay) {
      for (const ns of namespaces) {
        const labels = ns.metadata?.labels ?? {};
        const envId = labels[DEV_ENV_LABELS.env];
        const instanceId = labels[DEV_ENV_LABELS.instance];
        const stampId = labels[DEV_ENV_LABELS.stamp] ?? labels[POOL_LABEL];
        const ownerRef = labels[SCOPE_LABEL];
        const namespace = ns.metadata?.name;
        if (!envId || !instanceId || !stampId || !ownerRef || !namespace) continue;
        try {
          await this.ensureRelayContext({ envId, instanceId, ownerRef, stampId, namespace });
        } catch (error) {
          // Relay recovery is fail-closed at its short Gateway lease, but a
          // relay outage must not make discovery return zero and cause the
          // service to declare every surviving environment dead.
          log.warn('Dev-env k8s: parent relay adoption failed; instance remains discoverable', {
            namespace,
            error: String(error),
          });
          if (RELAY_ADOPTION_RETRY_RE.test(String(error))) {
            this.scheduleRelayAdoption({ envId, instanceId, ownerRef, stampId, namespace });
          }
        }
      }
    }
    return namespaces.map((ns) => this.handleFor(ns));
  }

  async reapResidue(installScope: string): Promise<void> {
    for (const ns of this.liveNamespaces(`${DEV_ENV_LABELS.install}=${installScope},${DEV_ENV_LABELS.env}`)) {
      const name = ns.metadata!.name!;
      try {
        if (nsFailed(ns) || this.podsAllFailed(name)) {
          // Route first: the namespace's own deletion cannot take the route
          // with it (it lives in the claimant's namespace), and once the
          // namespace is gone so is the annotation that says where to look.
          this.closeClaimRoute(
            ns.metadata?.annotations?.[CLAIMANT_NS_ANNOTATION],
            ns.metadata?.labels?.[DEV_ENV_LABELS.instance],
          );
          // The dev-tree PV is cluster-scoped for the same reason the route
          // is namespaced-elsewhere: the namespace delete cannot take it.
          if (ns.metadata?.annotations?.[`${OPTION_PREFIX}${DEV_TREE_OPTION}`]) this.deleteDevTreePv(name);
          this.kube.deleteNamespace(name);
          this.removeMaterials(ns);
        }
      } catch (error) {
        log.warn('Dev-env k8s: failed-residue reap failed', { namespace: name, error: String(error) });
      }
    }
    this.sweepOrphanRoutes(installScope);
    this.sweepOrphanDevTreePvs(installScope);
    this.sweepPlacementJobs(installScope);
    // Failed pool fills remain observable while the pool is broken. Once a
    // current-version warm replacement exists, its proof supersedes those
    // corpses and they are reaped; keeping every failed vcluster after recovery
    // consumed the single-node Kata budget until parent workloads stalled.
    // Removing the target also reaps them, as before. Claimed envs are excluded
    // by the env label; live warm/filling slots are owned by
    // reapSurplusSlots/drainMidFill instead.
    const poolTargets = this.poolTargets();
    const poolNamespaces = this.liveNamespaces(`${DEV_ENV_LABELS.install}=${installScope},${POOL_LABEL}`);
    const recoveredPools = new Set(
      poolNamespaces
        .filter((ns) => {
          const labels = ns.metadata?.labels ?? {};
          const stampId = labels[POOL_LABEL];
          return !!stampId && !labels[DEV_ENV_LABELS.env] && !nsFailed(ns) &&
            labels[SLOT_LABEL] === 'warm' && this.versionMatches(ns, stampId);
        })
        .map((ns) => ns.metadata!.labels![POOL_LABEL]!),
    );
    for (const ns of poolNamespaces) {
      const labels = ns.metadata?.labels ?? {};
      const name = ns.metadata?.name;
      const stampId = labels[POOL_LABEL];
      if (!name || labels[DEV_ENV_LABELS.env] || !stampId || !nsFailed(ns)) continue;
      if (stampId in poolTargets && !recoveredPools.has(stampId)) continue;
      try {
        this.kube.deleteNamespace(name);
        this.forgetChild(name);
        log.info('Dev-env k8s: reaped superseded failed pool residue', {
          namespace: name,
          stamp: stampId,
          reason: recoveredPools.has(stampId) ? 'warm replacement ready' : 'target removed',
        });
      } catch (error) {
        log.warn('Dev-env k8s: failed pool residue reap failed', { namespace: name, stamp: stampId, error: String(error) });
      }
    }
    // Fill attempts a dead host never finished: filling slots past twice the
    // boot budget are corpses, not pool members.
    for (const ns of this.liveNamespaces(`${DEV_ENV_LABELS.install}=${installScope},${SLOT_LABEL}=filling`)) {
      const started = Number(ns.metadata?.annotations?.[FILL_STARTED_ANNOTATION] ?? 0);
      if (this.now() - started > this.bootTimeoutMs * 2) {
        try {
          this.kube.deleteNamespace(ns.metadata!.name!);
          this.forgetChild(ns.metadata?.name);
        } catch (error) {
          log.warn('Dev-env k8s: stale fill reap failed', { namespace: ns.metadata?.name, error: String(error) });
        }
      }
    }
  }

  // ---------- placement (C15) ----------

  /**
   * The seam's placement verb, realized as a disposable Job in the
   * driver-owned placement namespace (k8s-place.ts owns the objects and the
   * posture honesty; this method owns WHEN). Runs from the host-side
   * placement reconciler — never a watch callback — so blocking polls are
   * legal here the way they are in fillSlot.
   *
   * A deployment without placement wiring refuses EVERY attempt with the
   * gateway-egress reason (ruling 1: nothing pulls around the gateway), so
   * the row records exactly why the pull path is not live rather than a
   * timeout that looks like weather.
   */
  async placeImage(spec: DriverPlaceSpec): Promise<{ storeId: string }> {
    if (spec.origin.kind !== 'pull') {
      throw new Error(`k8s driver realizes only the pull origin (imageBuild: false), got '${spec.origin.kind}'`);
    }
    if (!this.placement) {
      throw new Error(
        'placement egress rides the gateway (ruling 1) and this deployment has none wired — ' +
          'NANOCLAW_DEV_ENV_K8S_PLACEMENT_PROXY / NANOCLAW_DEV_ENV_K8S_PLACER_IMAGE are unset; ' +
          'the gateway-registry-egress catalog work is the missing plumbing',
      );
    }
    const namespaceName = placementNamespaceName(this.prefix);
    this.ensurePlacementNamespace(namespaceName);
    const jobName = placementJobName(spec.stampId, spec.version);
    const job = buildPlacementJob({ namespaceName, installScope: this.scope, spec, egress: this.placement });
    // Re-places reuse the name; a terminal predecessor must not shadow this
    // attempt's verdict. Deletion is teardown-race-tolerant.
    this.kube.deleteObject('job', jobName, namespaceName);
    this.kube.createRaw(job);
    const deadline = this.now() + this.bootTimeoutMs;
    try {
      while (this.now() < deadline) {
        const state = this.kube.getJson(['job', jobName, '-n', namespaceName], { timeoutMs: PROBE_TIMEOUT_MS });
        if ((state?.status?.succeeded ?? 0) >= 1) {
          // A digest-pinned pull is content-addressed: containerd landing
          // bits other than the signed digest is not a thing it can do, so
          // Job success IS the digest verification and the digest IS the
          // store identity.
          return { storeId: spec.origin.digest };
        }
        if ((state?.status?.failed ?? 0) >= 1) {
          // The registry's own words ride the row (#20); an unreadable log
          // degrades to the bare verdict, never fails the failure.
          let tail = '';
          try {
            tail = this.kube.logs(namespaceName, `job/${jobName}`, 20, { timeoutMs: PROBE_TIMEOUT_MS }).trim();
          } catch (error) {
            log.warn('Dev-env k8s: placement job logs unreadable', { job: jobName, error: String(error) });
          }
          throw new Error(`placement job failed${tail ? `: ${tail.slice(0, 400)}` : ''}`);
        }
        await sleep(SECRET_POLL_INTERVAL_MS);
      }
      throw new Error(`placement job did not finish inside ${this.bootTimeoutMs}ms`);
    } finally {
      // Disposable by contract: the Job dies with its verdict either way;
      // reapResidue collects what a dying host leaves behind.
      this.kube.deleteObject('job', jobName, namespaceName);
    }
  }

  /**
   * Is the derived ref still in the node's store? Answered from what kubelet
   * itself reports (`node.status.images`) — no socket, no pod, one bounded
   * read. Honesty clamp: kubelet caps that report (nodeStatusMaxImages,
   * default 50), so an absence from a FULL report proves nothing — those
   * answer "present", because a guessed eviction would close the claim gate
   * over a live image and re-place through an egress path that may not be
   * wired. Only an absence from a report that is READ, non-empty and
   * untruncated flips a row; `missingNodeImages` below is the whole rule.
   */
  async probeImage(ref: string): Promise<boolean> {
    return (await this.missingNodeImages([ref])).length === 0;
  }

  /**
   * The bulk form, and the same answer: which of these refs the node's store
   * does NOT hold, in ONE node read for the whole set — because a stamp that
   * declares the seven or eight images a whole deployment needs must not cost
   * seven or eight kubectl calls per claim.
   *
   * The honesty clamp above is inherited whole, and it is why a possibly
   * truncated report answers "nothing is missing": a guessed absence would
   * refuse a claim over an image that is right there, and refusing is the
   * expensive direction here.
   *
   * And it is inherited with BOTH its open ends closed, because absence is what
   * closes the claim gate and DRAINS WARM CAPACITY (the pool omits the stamp and
   * the reap collects its slots). A report at kubelet's cap may be truncated; a
   * node list that came back empty, or a node that has not published
   * `status.images` at all, is not an empty store but NO REPORT. All three are
   * "cannot prove absence" and all three answer the same way: nothing is
   * missing, ask again next cycle.
   */
  async missingNodeImages(refs: string[]): Promise<string[]> {
    if (refs.length === 0) return [];
    const nodes = this.kube.getJson(['nodes'], { timeoutMs: PROBE_TIMEOUT_MS })?.items ?? [];
    // no node answered — that is not an empty store
    if (nodes.length === 0) { this.warnNodeImageBlind('no node answered'); return []; }
    const present = new Set<string>();
    for (const node of nodes) {
      const images = node.status?.images;
      // Unreported, empty, or possibly truncated — one unreadable node makes
      // absence unprovable for the whole set, since a ref could be on it.
      if (!Array.isArray(images) || images.length === 0) { this.warnNodeImageBlind('a node publishes no images'); return []; }
      if (images.length >= NODE_IMAGE_REPORT_CAP) { this.warnNodeImageBlind('report at the entry cap'); return []; }
      for (const image of images) {
        const names = image.names ?? [];
        // The per-image name cap, clamped exactly like the entry cap: an entry
        // AT the cap may have had names dropped, so no absence is provable
        // anywhere in this report. Not just for this entry — the ref we are
        // asked about could be one of the dropped names.
        if (names.length >= NODE_IMAGE_NAMES_CAP) { this.warnNodeImageBlind('an entry at the name cap'); return []; }
        for (const name of names) present.add(name);
      }
    }
    return refs.filter((ref) => !present.has(ref));
  }

  /**
   * The clamps above, SAID OUT LOUD once per process.
   *
   * Every clamp answers "nothing is missing", which is the right answer — a
   * guessed absence would refuse a claim over an image that is right there. But
   * it makes a gate that PASSED and a gate that was BLIND indistinguishable,
   * and on any node with a busy store the report is permanently at kubelet's
   * cap, so the gate is permanently blind. Measured on omri-test: 50 entries
   * (the cap) with a 5-name entry (also the cap), so `missingNodeImages`
   * returned `[]` unconditionally.
   *
   * The cost lands much later and somewhere else. A stamp naming an image the
   * node does not hold sails past the fast, named refusal and dies ten minutes
   * on as `stamp '...' never became ready inside its instance`, with the real
   * cause an ImagePullBackOff buried inside a child cluster. Saying it once
   * turns a silent no-op into something an operator can find.
   *
   * Once per process, not per call: this runs on every pool reconcile, and a
   * standing condition must not become a standing log.
   */
  private warnNodeImageBlind(reason: string): void {
    if (this.nodeImageBlindWarned) return;
    this.nodeImageBlindWarned = true;
    log.warn('Dev-env k8s: cannot prove image absence from the node report; the image gate is passing blind', {
      reason,
      consequence: 'a stamp naming an absent image fails as a boot timeout, not as a named refusal',
    });
  }

  /**
   * Placement jobs a dying host orphaned (the brief: `reapResidue` deletes
   * the orphaned Job by label; `place` recovers). Terminal jobs are residue
   * outright — placeImage deletes its own on every live path, so one still
   * standing lost its reconciler. A RUNNING job is touched only past twice
   * the boot budget: the in-flight placement this process may hold ticks the
   * pool reconciler (which calls this sweep) concurrently, and reaping live
   * work out from under it would fail placements that were about to land.
   */
  private sweepPlacementJobs(installScope: string): void {
    const namespaceName = placementNamespaceName(this.prefix);
    let jobs: KubeObject[];
    try {
      jobs =
        this.kube.getJson(['jobs', '-n', namespaceName, '-l', `${PLACEMENT_LABEL}=job,${DEV_ENV_LABELS.install}=${installScope}`])
          ?.items ?? [];
    } catch (error) {
      log.warn('Dev-env k8s: placement job sweep failed', { error: String(error) });
      return;
    }
    for (const job of jobs) {
      const terminal = (job.status?.succeeded ?? 0) >= 1 || (job.status?.failed ?? 0) >= 1;
      const born = Date.parse(job.metadata?.creationTimestamp ?? '') || 0;
      if (!terminal && this.now() - born <= this.bootTimeoutMs * 2) continue;
      try {
        this.kube.deleteObject('job', job.metadata!.name!, namespaceName);
      } catch (error) {
        log.warn('Dev-env k8s: orphan placement job delete failed', { job: job.metadata?.name, error: String(error) });
      }
    }
  }

  /** Namespace + egress posture, AlreadyExists-tolerant — the heal on every placement. */
  private ensurePlacementNamespace(namespaceName: string): void {
    try {
      this.kube.createRaw(buildPlacementNamespace(namespaceName, this.scope));
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const { policy, residual } = buildPlacementNetpol(namespaceName, this.scope, this.placement!.proxyUrl);
    if (residual && !this.placementResidualWarned) {
      this.placementResidualWarned = true;
      log.warn('Dev-env k8s: placement egress residual', { residual });
    }
    try {
      this.kube.createRaw(policy);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  // ---------- claim internals ----------

  /**
   * One stamp id, resolved: the static table first (code-provided definitions
   * update with the code that renders them), then the registry snapshot.
   * Registered configs are re-validated here defensively — a row may predate
   * a validation rule, and a bad one must read as unknown, never crash a
   * probe path.
   */
  private stampFor(stampId: string): K8sStampConfig | undefined {
    const fromStatic = this.stamps[stampId];
    if (fromStatic) return fromStatic;
    const fromRegistry = this.stampSource?.getStamp(stampId);
    if (!fromRegistry) return undefined;
    try {
      validateStampEntry(stampId, fromRegistry);
      return fromRegistry;
    } catch (error) {
      log.warn('Dev-env k8s: registered stamp failed validation; treating as unknown', {
        stamp: stampId,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Warm-slot targets: static pool config with the registry's rows winning per
   * id — a `set-pool` an approver signed must beat a boot-time number,
   * INCLUDING at zero. A plain spread could not do that: `poolSizes()` reports
   * "no pool" as an OMISSION, and an omission cannot shadow a number, so a
   * stamp named by both config and registry kept its static target forever and
   * the registry had no way to turn it off. So a row takes the id WHOLE — its
   * size while it wants slots, nothing when it does not.
   *
   * (Definitions shadow the other way: the static table wins `stampFor`,
   * because code-provided manifests must update with the code that renders
   * them. Pools are not definitions — they are a live knob whose whole point
   * is taking effect within one reconcile.)
   */
  private poolTargets(): Record<string, number> {
    const registered = this.stampSource?.poolSizes() ?? {};
    const targets: Record<string, number> = {};
    for (const [stampId, size] of Object.entries(this.pools)) {
      if (this.stampSource?.getStamp(stampId) === undefined) targets[stampId] = size;
    }
    return { ...targets, ...registered };
  }

  /**
   * The version a slot filled RIGHT NOW would realize, as a label value — null
   * for a code-provided stamp, which has none (the static table wins an id
   * collision, so a registry row's version could not describe what such a slot
   * runs). Read off the same snapshot the fill itself reads, so a fill and its
   * label can never disagree.
   */
  private currentStampVersion(stampId: string): string | null {
    if (this.stamps[stampId]) return null;
    const version = this.stampSource?.stampVersion(stampId);
    return version === undefined ? null : String(version);
  }

  /** The selector term that matches only slots of the current version — absence included. */
  private versionSelector(stampId: string): string {
    const version = this.currentStampVersion(stampId);
    return version === null ? `!${STAMP_VERSION_LABEL}` : `${STAMP_VERSION_LABEL}=${version}`;
  }

  private versionMatches(ns: KubeObject, stampId: string): boolean {
    return (ns.metadata?.labels?.[STAMP_VERSION_LABEL] ?? null) === this.currentStampVersion(stampId);
  }

  private claimFromPool(spec: DriverClaimSpec, install: string): KubeObject | null {
    if (!(spec.stampId in this.poolTargets())) return null;
    // Pools key on (stamp + shape-changing options). v0 declares no shape
    // options, so a claim carrying ANY option must not land on a pooled slot
    // that never realized it — conservative, correct, and cheap: cold-boot it.
    if (Object.keys(spec.options).length > 0) return null;
    // The version term is what makes `dev_envs.stamp_version` true by
    // construction: the claim records the registry's CURRENT version, so a
    // slot filled from an older definition must not be selectable. A stale
    // slot is not skipped-and-left either — the reap drains it (see
    // reapSurplusSlots), so the pool refills at the new version.
    const candidates = this.liveNamespaces(
      `${DEV_ENV_LABELS.install}=${install},${POOL_LABEL}=${spec.stampId},${SLOT_LABEL}=warm,${this.versionSelector(spec.stampId)}`,
    );
    for (const candidate of candidates) {
      const name = candidate.metadata!.name!;
      // A warm label is a promise; verify the instance is actually ready —
      // kubeconfig exported AND the stamp's readiness Deployments up — before handing
      // the slot out. A half-warm slot is a cold claim wearing the wrong label.
      if (!this.instanceReady(name, spec.stampId, nsEverReady(candidate))) continue;
      try {
        this.kube.labelCas(
          name,
          candidate.metadata!.resourceVersion!,
          {
            [DEV_ENV_LABELS.env]: spec.key.envId,
            [DEV_ENV_LABELS.instance]: spec.key.instanceId,
            // Ownership is what the flip takes, and the materials scope is part
            // of it: a slot filled for nobody becomes this owner's instance.
            [SCOPE_LABEL]: claimScope(spec),
            ...extraLabels(spec.labels),
          },
          [SLOT_LABEL],
        );
      } catch (error) {
        if (isConflict(error)) continue; // another claimer won this slot
        throw error;
      }
      // The slot was verified ready a moment ago and is now this owner's
      // instance: that is the first observed readiness, and recording it is
      // what stops a later adoption from re-running first-boot semantics
      // (stamp gate, boot timer) over a live env.
      this.markEverReady(name);
      // Warm parity with the cold path: the route opens the moment ownership
      // settles (the CAS flip is the settling). The flip cannot be undone —
      // a slot filled for nobody became this owner's instance — so a route
      // that will not open turns the instance into residue rather than
      // handing out an env its owner cannot reach.
      try {
        this.openClaimRoute(name, spec);
      } catch (error) {
        try {
          this.kube.annotate(name, { [STATE_ANNOTATION]: 'failed', [FAILURE_ANNOTATION]: 'instantiation-failed' });
        } catch (annotateError) {
          log.warn('Dev-env k8s: could not mark route-less claim failed', {
            namespace: name,
            error: String(annotateError),
          });
        }
        throw error;
      }
      return this.kube.getNamespace(name);
    }
    return null;
  }

  /**
   * Open this claim's per-claim route (D19): a NetworkPolicy in the CLAIMANT'S
   * namespace admitting the group's pods to this child's apiserver, 8443 only.
   * No claimant placement on the spec = no route — the fail-closed direction
   * (docker-session hosts, the conformance mock). `create`, never `apply`:
   * apply needs the patch verb the host's RBAC deliberately does not hold, and
   * AlreadyExists IS the desired state — which is what makes this call the
   * heal on replayed claims. The claimant-ns annotation lands FIRST: a route
   * that exists without its pointer cannot be closed by a restarted host.
   */
  private openClaimRoute(namespaceName: string, spec: DriverClaimSpec): void {
    // A NetworkPolicy lives in a namespace, so no namespace is no route: this
    // driver on a host whose sessions are not netpol-governed pods authors
    // nothing, which is exactly where the fail-closed direction always
    // pointed. The WHO half arrives on every claim now (a flat runtime has a
    // claimant and no scope to name it in); the refusal for the OTHER
    // half-specified pair — a scope with no selector — stays inside
    // buildClaimRoute, which never guesses one side.
    if (!spec.claimantNamespace) return;
    const route = buildClaimRoute({
      installScope: spec.labels[DEV_ENV_LABELS.install],
      instanceId: spec.key.instanceId,
      // buildClaimRoute refuses a half-specified pair — never guesses one side.
      claimantNamespace: spec.claimantNamespace ?? '',
      claimantPodSelector: spec.claimantSelector ?? {},
      childNamespace: namespaceName,
    });
    this.kube.annotate(namespaceName, { [CLAIMANT_NS_ANNOTATION]: spec.claimantNamespace! });
    this.seenClaimantNamespaces.add(spec.claimantNamespace!);
    try {
      this.kube.createRaw(route);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  /**
   * Explicitly delete a claim's route. Guarded — every caller is a teardown
   * path (release, terminal, residue) where a blip must degrade to a leaked
   * route the orphan sweep collects, never to a failed teardown.
   * @internal handle back-channel too.
   */
  closeClaimRoute(claimantNamespace: string | null | undefined, instanceId: string | null | undefined): void {
    if (!claimantNamespace || !instanceId) return;
    try {
      this.kube.deleteObject('networkpolicy', claimRouteName(instanceId), claimantNamespace);
    } catch (error) {
      log.warn('Dev-env k8s: could not close per-claim route', {
        claimantNamespace,
        instance: instanceId,
        error: String(error),
      });
    }
  }

  /**
   * Routes whose instance no longer exists — a close path that blipped, or a
   * namespace torn down externally. Once the child namespace is gone the route
   * admits nothing (its namespaceSelector matches nothing), but instance
   * namespace NAMES are random and reusable, so a stale route must not sit
   * where a future namespace could give it meaning again. Claimant namespaces
   * are learned from live instances' annotations UNION the process's own
   * open-route memory (`seenClaimantNamespaces`) — annotations alone cannot
   * name a namespace whose last instance is already gone — and only routes
   * wearing BOTH our labels are touched: this sweep deletes nothing it cannot
   * attribute.
   *
   * KNOWN GAPS, accepted: a leak that crosses a host restart on an idle
   * install waits for the next claim to re-teach its namespace, and a route
   * stranded in a PREVIOUS claimant namespace after a NANOCLAW_POD_NAMESPACE
   * change is never re-taught at all. Both need durable claimant-namespace
   * history to close; both are operator-driven and the stranded route only
   * ever admits pods wearing the same install+group+role labels in the
   * abandoned namespace.
   */
  private sweepOrphanRoutes(installScope: string): void {
    const live = this.liveNamespaces(`${DEV_ENV_LABELS.install}=${installScope}`);
    const claimantNamespaces = new Set<string>(this.seenClaimantNamespaces);
    const liveInstances = new Set<string>();
    for (const ns of live) {
      const claimant = ns.metadata?.annotations?.[CLAIMANT_NS_ANNOTATION];
      if (claimant) claimantNamespaces.add(claimant);
      const instance = ns.metadata?.labels?.[DEV_ENV_LABELS.instance];
      if (instance && !nsFailed(ns)) liveInstances.add(instance);
    }
    for (const claimant of claimantNamespaces) {
      let routes: KubeObject[];
      try {
        routes =
          this.kube.getJson(['networkpolicies', '-n', claimant, '-l', `${DEV_ENV_LABELS.install}=${installScope}`])
            ?.items ?? [];
      } catch (error) {
        log.warn('Dev-env k8s: orphan-route sweep failed', { claimantNamespace: claimant, error: String(error) });
        continue;
      }
      for (const route of routes) {
        const instance = route.metadata?.labels?.[DEV_ENV_LABELS.instance];
        if (!instance || liveInstances.has(instance)) continue;
        this.closeClaimRoute(claimant, instance);
      }
    }
  }

  // ---------- the dev-tree flavor (hot loop) ----------

  /**
   * Claim-time honesty for the reserved option. Two refusals, both cheaper
   * here than as a boot that polls out its budget: the option applies only
   * to a stamp that DECLARES a dev block (C16 — opting in is the stamp
   * author's registered, approved act), and the path must be an absolute
   * directory this host can already see.
   */
  private validateDevTreeOption(spec: DriverClaimSpec): void {
    const devTree = spec.options[DEV_TREE_OPTION];
    if (devTree === undefined) return;
    if (!this.stampFor(spec.stampId)?.dev) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail:
          `stamp '${spec.stampId}' declares no dev block — the working-tree flavor exists only for stamps that ` +
          `opt in (stamps update adds dev to the approved config)`,
      });
    }
    if (!path.isAbsolute(devTree)) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `${DEV_TREE_OPTION} must be node-absolute (resolved above the seam), got: ${devTree}`,
      });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(devTree);
    } catch {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `dev tree not readable at ${devTree}`,
      });
    }
    if (!stat.isDirectory()) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `dev tree is not a directory: ${devTree}`,
      });
    }
  }

  /**
   * One RW tree, one child. Every dev claim's PV mounts the tree read-write
   * and the child writes data/ (SQLite) and groups/ into it; two live
   * children over one path would write those concurrently — a
   * corruption-shaped collision no lock exists for. PV names derive from the
   * instance namespace, not the path, so duplicate-path PVs coexist happily
   * at the k8s layer; this claim-time check is the only guard. Same-instance
   * replays are never a conflict (that is how claims heal), and a leaked PV
   * whose holder is dead does not block the tree — the guard mirrors the
   * orphan sweep's liveness attribution, and the sweep collects the corpse.
   * Exact-path equality only: the option arrives realpath-canonical from the
   * CLI seam, and nesting (one tree inside another) is out of scope.
   */
  private refuseSharedDevTree(spec: DriverClaimSpec, devTree: string): void {
    const install = spec.labels[DEV_ENV_LABELS.install];
    const pvs = this.kube.getJson(['persistentvolumes', '-l', `${DEV_ENV_LABELS.install}=${install}`])?.items ?? [];
    const rivals = pvs.filter(
      (pv) =>
        pv.spec?.local?.path === devTree && pv.metadata?.labels?.[DEV_ENV_LABELS.instance] !== spec.key.instanceId,
    );
    if (rivals.length === 0) return;
    const liveInstances = new Set<string>();
    for (const ns of this.liveNamespaces(`${DEV_ENV_LABELS.install}=${install}`)) {
      const instance = ns.metadata?.labels?.[DEV_ENV_LABELS.instance];
      if (instance && !nsFailed(ns)) liveInstances.add(instance);
    }
    const holder = rivals.find((pv) => liveInstances.has(pv.metadata?.labels?.[DEV_ENV_LABELS.instance] ?? ''));
    if (holder) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail:
          `dev tree ${devTree} is already mounted read-write by live instance ` +
          `'${holder.metadata?.labels?.[DEV_ENV_LABELS.instance]}' — two children over one tree would ` +
          `both write its data/ and groups/; release that claim first`,
      });
    }
  }

  /** Re-teach the probe-path cache from the runtime — every path that can reach a dev instance calls this. */
  private rememberDevTree(ns: KubeObject): void {
    const name = ns.metadata?.name;
    const devTree = ns.metadata?.annotations?.[`${OPTION_PREFIX}${DEV_TREE_OPTION}`];
    if (name && devTree) this.devTrees.set(name, devTree);
  }

  /**
   * The static parent-side PV realizing one dev claim's tree: the exact
   * `local`-type shape local-path provisions (verified live), path = the
   * sandbox working tree on the node, nodeAffinity = the one node everything
   * shares today (also the mechanical form of the accepted co-location
   * constraint), claimRef PRE-BOUND to the deterministic synced name of the
   * child's dev PVC so no provisioner can win the claim. Retain, not Delete:
   * no reclaimer may ever act on a path that is somebody's working tree —
   * the driver deletes the PV OBJECT itself on every teardown path.
   * AlreadyExists-tolerant, which is what makes replayed claims heal.
   */
  private ensureDevTreePv(namespaceName: string, spec: DriverClaimSpec): void {
    const devTree = spec.options[DEV_TREE_OPTION];
    if (!devTree) return;
    // The pre-bind names the syncer's derived form of the CONSUMER-namespace
    // claim (a pure formula since C16). The claim path validated the dev
    // block moments ago; a resume whose config dropped it mid-flight has no
    // consumer namespace to derive — skip the heal and let the probe path
    // record the mismatch (its verdict, not a teardown's).
    const config = this.stampFor(spec.stampId);
    if (!config?.dev) {
      log.warn('Dev-env k8s: dev claim resumed but the stamp no longer declares dev; PV heal skipped', {
        namespace: namespaceName,
        stamp: spec.stampId,
      });
      return;
    }
    const pv = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: {
        name: devTreePvName(namespaceName),
        labels: {
          [DEV_ENV_LABELS.install]: spec.labels[DEV_ENV_LABELS.install],
          [DEV_ENV_LABELS.instance]: spec.key.instanceId,
        },
      },
      spec: {
        capacity: { storage: '10Gi' },
        accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: DEV_TREE_STORAGE_CLASS,
        claimRef: {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          namespace: namespaceName,
          name: syncedDevTreePvcName(devConsumerGate(spec.stampId, config).namespace),
        },
        local: { path: devTree },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  { key: 'kubernetes.io/hostname', operator: 'In', values: [this.claimantNodeName()] },
                ],
              },
            ],
          },
        },
      },
    };
    try {
      this.kube.createRaw(pv);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  /**
   * Where the tree physically is. Single-node substrate today; the moment a
   * second node exists this must become the CLAIMANT POD'S node (the brief's
   * open question) — warn rather than guess silently.
   */
  private claimantNodeName(): string {
    if (this.nodeName) return this.nodeName;
    const nodes = this.kube.getJson(['nodes'])?.items ?? [];
    const name = nodes[0]?.metadata?.name;
    if (!name) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: true,
        detail: 'no node visible to pin the dev-tree PV nodeAffinity to',
      });
    }
    if (nodes.length > 1) {
      log.warn(
        'Dev-env k8s: multiple nodes; dev-tree PV pins the first — co-location with the sandbox is NOT guaranteed',
        {
          chosen: name,
          nodes: nodes.length,
        },
      );
    }
    this.nodeName = name;
    return name;
  }

  /**
   * Explicitly delete a dev claim's PV. Guarded like closeClaimRoute and for
   * the same reason: every caller is a teardown path where a blip must
   * degrade to a leaked PV the orphan sweep collects, never a failed
   * teardown. @internal handle back-channel too.
   */
  deleteDevTreePv(namespaceName: string): void {
    try {
      this.kube.deleteClusterObject('persistentvolume', devTreePvName(namespaceName));
    } catch (error) {
      log.warn('Dev-env k8s: could not delete dev-tree PV', { namespace: namespaceName, error: String(error) });
    }
  }

  /**
   * Dev-tree PVs whose instance no longer exists — a delete path that
   * blipped, or a namespace torn down externally. Cluster-scoped objects
   * referencing node paths must not outlive their claim: a released PV still
   * names a directory in some group's workspace, and instance namespace
   * names are random and reusable. Only PVs wearing BOTH our labels are
   * touched — the sweep deletes nothing it cannot attribute (the
   * sweepOrphanRoutes posture, verbatim).
   */
  private sweepOrphanDevTreePvs(installScope: string): void {
    let pvs: KubeObject[];
    try {
      pvs = this.kube.getJson(['persistentvolumes', '-l', `${DEV_ENV_LABELS.install}=${installScope}`])?.items ?? [];
    } catch (error) {
      log.warn('Dev-env k8s: orphan dev-tree PV sweep failed', { error: String(error) });
      return;
    }
    if (pvs.length === 0) return;
    const liveInstances = new Set<string>();
    for (const ns of this.liveNamespaces(`${DEV_ENV_LABELS.install}=${installScope}`)) {
      const instance = ns.metadata?.labels?.[DEV_ENV_LABELS.instance];
      if (instance && !nsFailed(ns)) liveInstances.add(instance);
    }
    for (const pv of pvs) {
      const instance = pv.metadata?.labels?.[DEV_ENV_LABELS.instance];
      if (!instance || liveInstances.has(instance)) continue;
      try {
        this.kube.deleteClusterObject('persistentvolume', pv.metadata!.name!);
      } catch (error) {
        log.warn('Dev-env k8s: orphan dev-tree PV delete failed', { pv: pv.metadata?.name, error: String(error) });
      }
    }
  }

  /** A claim asserts ownership; an instance missing its scope gets it here, never overwritten. */
  private healScopeLabel(ns: KubeObject, scope: string): void {
    if (ns.metadata?.labels?.[SCOPE_LABEL]) return;
    try {
      this.kube.label(ns.metadata!.name!, { [SCOPE_LABEL]: scope });
    } catch (error) {
      log.warn('Dev-env k8s: could not heal materials scope label', {
        namespace: ns.metadata?.name,
        error: String(error),
      });
    }
  }

  private createInstanceNamespace(
    name: string,
    metadata: { labels: Record<string, string>; annotations: Record<string, string> },
  ): void {
    try {
      this.kube.createRaw({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name,
          labels: { ...metadata.labels, ...NAMESPACE_SAFETY_LABELS },
          annotations: metadata.annotations,
        },
      });
    } catch (error) {
      if (isAlreadyExists(error)) {
        // Names are random and replay heals via the label lookup before any
        // create — an AlreadyExists here is a collision with a FOREIGN
        // namespace. Proceeding would apply our bundle into (and later
        // delete) someone else's namespace.
        throw asDevEnvFailureError({
          kind: 'instantiation-failed',
          retryable: false,
          detail: `namespace name collision: ${name}`,
        });
      }
      throw error;
    }
  }

  /**
   * Mint the host's own per-namespace access (Role + RoleBinding) — the grant
   * that makes every object-level permission namespace-scoped. Applied FIRST:
   * everything else the driver does in this namespace flows through it.
   */
  private applyHostAccess(namespaceName: string): void {
    if (!this.hostAccessSubject) return;
    this.kube.apply(
      JSON.stringify({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: 'dev-env-host-access', namespace: namespaceName },
        rules: [
          {
            apiGroups: [''],
            resources: ['serviceaccounts', 'services', 'configmaps', 'secrets'],
            verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'],
          },
          { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
          {
            apiGroups: ['apps'],
            resources: ['deployments'],
            verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'],
          },
          {
            apiGroups: ['networking.k8s.io'],
            resources: ['networkpolicies'],
            verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'],
          },
          {
            apiGroups: ['rbac.authorization.k8s.io'],
            resources: ['roles', 'rolebindings'],
            verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'],
          },
        ],
      }),
    );
    this.kube.apply(
      JSON.stringify({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: 'dev-env-host-access', namespace: namespaceName },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'dev-env-host-access' },
        subjects: [this.hostAccessSubject],
      }),
    );
  }

  /** The rendered vcluster bundle + regenerated config secret, idempotently applied. */
  private async applyInstanceBundle(namespaceName: string): Promise<void> {
    this.applyHostAccess(namespaceName);
    const namespace = this.kube.getNamespace(namespaceName);
    const stampId = namespace?.metadata?.labels?.[POOL_LABEL] ?? '';
    const stamp = stampId ? this.stampFor(stampId) : null;
    if (!stamp) throw new Error(`cannot resolve stamp for instance namespace ${namespaceName}`);
    const runtimeClass = stamp.runtimeClassName ?? '';
    if (runtimeClass) this.kube.getJson(['runtimeclass', runtimeClass]);
    const manifests = applyVclusterRuntimeClass(
      VCLUSTER_MANIFESTS.replaceAll(VCLUSTER_NS_TOKEN, namespaceName),
      runtimeClass,
    );
    try {
      this.kube.apply(manifests);
    } catch (error) {
      // A just-minted grant can lose a race with RBAC propagation; one short
      // retry separates that from a real denial.
      if (!/is forbidden/i.test(String(error))) throw error;
      await sleep(RBAC_PROPAGATION_RETRY_MS);
      this.kube.apply(manifests);
    }
    // The config secret is rebuilt per instance rather than rendered: its
    // content embeds the namespace (cert SANs, exported server URL), which
    // text substitution of a base64 blob cannot reach.
    const config = applyVclusterRuntimeClass(
      VCLUSTER_CONFIG_YAML.replaceAll(VCLUSTER_NS_TOKEN, namespaceName),
      runtimeClass,
    );
    this.kube.apply(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: VCLUSTER_CONFIG_SECRET, namespace: namespaceName },
        type: 'Opaque',
        stringData: { 'config.yaml': config },
      }),
    );
  }

  // ---------- pool ----------

  private startPoolReconciler(): void {
    // With a registry attached the reconciler always runs: pool sizes are rows
    // now, and a set-pool must take effect within one interval, not after the
    // restart that a boot-time emptiness check would demand.
    if (this.reconciler || this.disposed || (!this.stampSource && Object.keys(this.pools).length === 0)) return;
    this.reconciler = setInterval(() => void this.reconcilePool(), POOL_RECONCILE_INTERVAL_MS);
    this.reconciler.unref?.();
  }

  /**
   * Never inline pool work into a claim's synchronous path — a warm hit must
   * return in flip-time, not in flip-plus-the-next-boot.
   */
  private scheduleReconcile(): void {
    const timer = setTimeout(() => void this.reconcilePool(), 0);
    timer.unref?.();
  }

  /** Keep each pool at size; one fill at a time — pool refill must never stampede the node. */
  private async reconcilePool(): Promise<void> {
    if (this.fillInFlight || this.disposed) return;
    this.fillInFlight = true;
    try {
      // The registry snapshot refreshes at the top of every cycle — this is
      // the edge that makes `stamps set-pool` land within one interval.
      await this.stampSource?.refresh();
      // Corpses and orphans first, so they neither count toward size nor
      // linger until the next host restart (adopt() is not the only sweeper).
      await this.reapResidue(this.scope);
      this.reapSurplusSlots();
      for (const [stampId, size] of Object.entries(this.poolTargets())) {
        while (!this.disposed && this.poolCount(stampId) < size) {
          // A failed fill must not hot-loop into another attempt — a
          // persistently failing boot would spin the event loop dry. The
          // interval (and the next claim) retries.
          if (!(await this.fillSlot(stampId))) break;
        }
      }
    } catch (error) {
      log.warn('Dev-env k8s: pool reconcile failed', { error: String(error) });
    } finally {
      this.fillInFlight = false;
    }
  }

  /**
   * Slots the pool is not keeping — deleted, so a pool CONVERGES downward the
   * way `reconcilePool` converges it upward, and so a slot no claim could ever
   * take stops counting as capacity and blocking its own replacement.
   *
   * Three shapes, one rule ("keep `size` slots of the CURRENT version, reap
   * the rest"):
   * - a pool whose target left the config keeps none;
   * - a pool cut from 3 to 1 keeps one. That one used to be a gap — the
   *   reconciler only ever FILLED, so `set-pool 1` over three warm slots held
   *   three of them forever and the row's desired half disagreed with the
   *   runtime for good;
   * - a slot of a stamp VERSION that is no longer current keeps none whatever
   *   the budget — the drain half of a hot update. `partitionSlots` never
   *   spends budget on one, so the replacement at the new version boots in the
   *   same cycle that drains it.
   *
   * LIVE CLAIMS ARE UNTOUCHED, and that is load-bearing: a claimed instance
   * keeps its pool label as provenance but loses its slot label at the CAS
   * flip, so the `isSlot` filter below is what makes a hot update invisible to
   * every running child. The frozen-instance rule holds through an update.
   *
   * EVERY DELETION SAYS WHY. A pool leaves `poolTargets()` for two very
   * different reasons — an operator set its size to 0, or a CLAIM GATE closed
   * over it (an unplaced image, a declared node image the store does not hold)
   * — and the second spends warm capacity on a condition the operator did not
   * ask for. Draining it wordlessly is how a gate that flickers reads as a pool
   * that will not fill; `ncl stamps list` carries the standing state, this line
   * carries the moment. A shrink and a stale version each say so by name too.
   *
   * The listing and the deletes are ONE synchronous sweep — no await between
   * them — so no claim can flip a slot underneath it: the host is single
   * threaded and the CAS flip runs in this same process. A re-read per reaped
   * slot would buy nothing here and cost a blocking apiserver call.
   */
  private reapSurplusSlots(): void {
    const targets = this.poolTargets();
    const slots = this.liveNamespaces(`${DEV_ENV_LABELS.install}=${this.scope},${POOL_LABEL}`).filter((ns) =>
      isSlot(ns.metadata?.labels?.[SLOT_LABEL]),
    );
    for (const ns of this.partitionSlots(slots).surplus) {
      const name = ns.metadata!.name!;
      const labels = ns.metadata!.labels!;
      const stampId = labels[POOL_LABEL]!;
      try {
        this.kube.deleteNamespace(name);
        this.forgetChild(name);
        if (!this.versionMatches(ns, stampId)) {
          log.info('Dev-env k8s: draining a stale-version pool slot', {
            namespace: name,
            stamp: stampId,
            slot: labels[SLOT_LABEL],
            was: labels[STAMP_VERSION_LABEL] ?? '(none)',
            now: this.currentStampVersion(stampId) ?? '(code-provided)',
          });
        } else if (!(stampId in targets)) {
          log.info('Dev-env k8s: draining a pool slot no claim can take', {
            namespace: name,
            stamp: stampId,
            slot: labels[SLOT_LABEL],
            // Which of the two it is: config, or a gate that closed under it.
            reason: 'the stamp has no warm pool target now — pool size 0, retired, or its claim gate is closed',
          });
        } else {
          log.info('Dev-env k8s: draining a pool slot past its size', {
            namespace: name,
            stamp: stampId,
            slot: labels[SLOT_LABEL],
            size: targets[stampId],
          });
        }
      } catch (error) {
        log.warn('Dev-env k8s: surplus pool slot reap failed', { namespace: name, error: String(error) });
      }
    }
  }

  /**
   * The pool's budget rule, in ONE place: keep `size` slots per stamp, warm
   * before filling — the surviving budget belongs to capacity a claim can use
   * NOW, so a shrink spends it on warm slots and gives up the boots — and
   * everything past the budget is surplus.
   *
   * Both halves of the pool read it: `reapSurplusSlots` DELETES what comes
   * back as surplus, `observePools` RENDERS it as draining. Shared on purpose
   * — a row that counted a doomed slot as warm would promise a claim exactly
   * the capacity the next cycle is about to take away.
   *
   * A slot of a stamp VERSION that is no longer current is surplus before the
   * budget is consulted, never capacity: claims cannot resolve to it, so
   * spending a slot of the budget on it would leave the pool one short at the
   * new version until it went. That is the same rule `poolCount` applies, and
   * it is what makes a hot update drain-and-refill in ONE cycle.
   *
   * Claimed instances keep their pool label as provenance and are not slots (a
   * shrink must never reach somebody's env), so callers pass SLOTS only.
   */
  private partitionSlots(slots: KubeObject[]): { keep: KubeObject[]; surplus: KubeObject[] } {
    const remaining = { ...this.poolTargets() };
    const keep: KubeObject[] = [];
    const surplus: KubeObject[] = [];
    for (const ns of [...slots.filter(isWarmSlot), ...slots.filter((s) => !isWarmSlot(s))]) {
      const stampId = ns.metadata!.labels![POOL_LABEL]!;
      if (!this.versionMatches(ns, stampId)) {
        surplus.push(ns);
        continue;
      }
      const left = remaining[stampId] ?? 0;
      if (left > 0) {
        remaining[stampId] = left - 1;
        keep.push(ns);
      } else {
        surplus.push(ns);
      }
    }
    return { keep, surplus };
  }

  /**
   * What this driver is HOLDING, per stamp (the `PoolObserver` question) —
   * read off the runtime the reconciler acts on, never off a second ledger,
   * so the answer cannot drift from what the next fill or reap will do.
   *
   * ONE bounded call (`PROBE_TIMEOUT_MS`): this runs synchronously inside the
   * host on every `stamps get/list`, so an apiserver that has stopped
   * answering must cost that read five seconds and a rendered "unreadable" —
   * never the 30-second default exec budget, and never the host with it.
   *
   * Never counts an ENV: a claimed instance keeps its pool label as provenance
   * and is excluded by the label it gained, not by the one it lost. And no env
   * is ever NAMED here, which is what makes the answer safe to hand an agent
   * whole.
   *
   * The three LIVE states are the three things an author can be waiting on:
   * - `warm` — a claim lands instantly.
   * - `filling` — a slot is booting toward warm.
   * - `draining` — the namespace is terminating, or the slot is past its
   *   pool's budget (`set-pool 0`, a retire, a shrink) or built from a stamp
   *   version claims no longer resolve to, and `partitionSlots` has already
   *   named it surplus for the next reap. All of them are visible the moment
   *   the mutation lands, which is what turns a retire, a shrink, or a hot
   *   update from a silent flip into a drain an author can watch.
   *
   * And one HISTORICAL: `failed` counts corpses of fills that died, with
   * `lastFailureAgeMs` saying when the most recent of them did. Dropping them
   * before recovery is what made a broken pool render exactly like a slow one
   * (both hold `warm 0`, and only this says which wait is pointless). Once a
   * current warm replacement exists, the successful slot is stronger evidence
   * and `reapResidue` deletes the superseded vclusters so failures do not
   * accumulate into node pressure. Removing the target does the same.
   */
  observePools(): Record<string, PoolObservation> {
    const observed: Record<string, PoolObservation> = {};
    // Every targeted stamp answers, even at zero: "asked for one, holding none
    // yet" is exactly what a set-pool author needs the moment approval lands,
    // and an absent key would read as "this driver knows nothing about it".
    for (const stampId of Object.keys(this.poolTargets())) observed[stampId] = emptyObservation();
    const poolOf = (stampId: string): PoolObservation => (observed[stampId] ??= emptyObservation());
    const selector = `${DEV_ENV_LABELS.install}=${this.scope},${POOL_LABEL}`;
    const slots: KubeObject[] = [];
    const diedAt: Record<string, number> = {};
    for (const ns of this.kube.listNamespaces(selector, { timeoutMs: PROBE_TIMEOUT_MS })) {
      const labels = ns.metadata?.labels ?? {};
      if (labels[DEV_ENV_LABELS.env]) continue; // somebody's env, not a slot
      const stampId = labels[POOL_LABEL]!;
      if (ns.metadata?.deletionTimestamp) {
        poolOf(stampId).draining += 1;
        continue;
      }
      if (nsFailed(ns)) {
        poolOf(stampId).failed += 1;
        const at = Number(ns.metadata?.annotations?.[FAILED_AT_ANNOTATION]);
        // Undated corpses (a fill whose annotate lost its race, or one that
        // predates the timestamp) still COUNT — they just carry no age.
        if (Number.isFinite(at) && at > 0) diedAt[stampId] = Math.max(diedAt[stampId] ?? 0, at);
        continue;
      }
      if (!isSlot(labels[SLOT_LABEL])) continue; // mid-flip residue: neither capacity nor corpse
      slots.push(ns);
    }
    // The reaper's own rule decides which of these the pool is KEEPING, so the
    // row can never count a slot the next cycle is about to delete as capacity.
    const { keep, surplus } = this.partitionSlots(slots);
    for (const ns of keep) {
      const labels = ns.metadata!.labels!;
      // `isSlot` narrowed the label above; the partition only hands back what it was given.
      poolOf(labels[POOL_LABEL]!)[labels[SLOT_LABEL] as 'warm' | 'filling'] += 1;
    }
    for (const ns of surplus) poolOf(ns.metadata!.labels![POOL_LABEL]!).draining += 1;
    for (const [stampId, at] of Object.entries(diedAt)) {
      poolOf(stampId).lastFailureAgeMs = Math.max(0, this.now() - at);
    }
    return observed;
  }

  private poolCount(stampId: string): number {
    return this.liveNamespaces(`${DEV_ENV_LABELS.install}=${this.scope},${POOL_LABEL}=${stampId}`).filter((ns) => {
      if (nsFailed(ns)) return false; // corpses are not capacity
      // Nor is a slot built from a definition claims no longer resolve to: it
      // is on its way out (the reap above), and counting it would leave the
      // pool one short of its size at the new version until it went.
      if (!this.versionMatches(ns, stampId)) return false;
      return isSlot(ns.metadata?.labels?.[SLOT_LABEL]);
    }).length;
  }

  /** @returns true when a warm slot landed; false when the fill failed or was cut short. */
  private async fillSlot(stampId: string): Promise<boolean> {
    const name = `${this.prefix}-${randomBytes(4).toString('hex')}`;
    const version = this.currentStampVersion(stampId);
    this.createInstanceNamespace(name, {
      labels: {
        [DEV_ENV_LABELS.install]: this.scope,
        [DEV_ENV_LABELS.stamp]: stampId,
        [POOL_LABEL]: stampId,
        [SLOT_LABEL]: 'filling',
        // Written from the first line of the fill, before anything is applied:
        // the slot must be identifiable as v(n) even if it dies half-built, or
        // the reap could not tell a stale corpse from a current one.
        ...(version === null ? {} : { [STAMP_VERSION_LABEL]: version }),
      },
      annotations: { [FILL_STARTED_ANNOTATION]: String(this.now()) },
    });
    try {
      await this.applyInstanceBundle(name);
      const deadline = this.now() + this.bootTimeoutMs;
      while (this.now() < deadline) {
        if (this.disposed) return false; // stale-fill reap collects the remainder
        // A retire or a `set-pool 0` landing mid-boot DRAINS this slot; it did
        // not fail. Checked every pass because the wait is a boot budget long
        // and the mutation refreshes the snapshot the instant it is approved
        // (ISSUES #21: the reason-less failed row was this fill, timing out
        // against a stamp the registry had already retired underneath it).
        if (this.drainMidFill(name, stampId)) return false;
        // The probe is also what applies the stamp (see stampReady), so this one
        // loop boots the vcluster AND its stamp — and the warm label is only ever
        // written over an instance a claim could use immediately.
        if (this.instanceReady(name, stampId)) {
          this.kube.label(name, { [SLOT_LABEL]: 'warm' });
          log.info('Dev-env k8s: pool slot warm', { namespace: name, stamp: stampId });
          return true;
        }
        // A rejected stamp cannot converge — waiting out the deadline on it
        // would cost the pool a boot budget per fill, forever.
        const rejected = this.stampRejections.get(name);
        if (rejected) {
          this.endFailedFill(name, stampId, rejected);
          return false;
        }
        await sleep(SECRET_POLL_INTERVAL_MS);
      }
      this.endFailedFill(name, stampId, 'boot timeout');
    } catch (error) {
      this.endFailedFill(name, stampId, String(error));
    }
    return false;
  }

  /**
   * Did this fill's pool stop wanting it? Then reap the slot and say so — the
   * fill was cut short, and a corpse annotated `failed` would blame the stamp
   * for a mutation the author made on purpose (ISSUES #21).
   *
   * @returns true when the slot was drained and the fill must stop.
   */
  private drainMidFill(name: string, stampId: string): boolean {
    if (stampId in this.poolTargets()) return false;
    try {
      this.kube.deleteNamespace(name);
      this.forgetChild(name);
    } catch (error) {
      log.warn('Dev-env k8s: mid-fill drain reap failed', { namespace: name, error: String(error) });
    }
    log.info('Dev-env k8s: pool fill drained mid-boot', { namespace: name, stamp: stampId });
    return true;
  }

  /**
   * A fill that really did die. It must stop counting as capacity IMMEDIATELY
   * — dropping the slot label is what lets the reconciler boot a replacement;
   * the failed annotation is what the pool observation counts, so an author
   * reading `stamps get` sees `failed n` instead of a pool that looks merely
   * slow. A drain reaches here only if it landed after the loop gave up, and
   * it is answered as the drain it is, not as a failure.
   */
  private endFailedFill(name: string, stampId: string, detail: string): void {
    if (this.drainMidFill(name, stampId)) return;
    this.markSlotFailed(name, stampId, detail);
  }

  /**
   * Record the corpse the observation counts, then drop the slot label so it
   * stops counting as capacity and the reconciler boots a replacement.
   *
   * ANNOTATE FIRST, always. The other order has a hole: a label drop that
   * lands while the annotate throws leaves a namespace wearing neither a slot
   * label nor a failure — an invisible corpse, residue to the observation and
   * to every reaper, holding a vcluster nobody will ever look for. This way
   * the partial state is a namespace that is already annotated `failed`, which
   * `poolCount` refuses as capacity and `observePools` counts as the corpse it
   * is; the next reconcile's fill covers the label the write did not land.
   */
  private markSlotFailed(name: string, stampId: string, detail: string): void {
    try {
      this.kube.annotate(name, {
        [STATE_ANNOTATION]: 'failed',
        [FAILURE_ANNOTATION]: 'instantiation-failed',
        [FAILED_AT_ANNOTATION]: String(this.now()),
      });
      this.kube.label(name, {}, [SLOT_LABEL]);
    } catch (error) {
      log.warn('Dev-env k8s: could not mark failed fill', { namespace: name, error: String(error) });
    }
    log.warn('Dev-env k8s: pool fill failed; slot left as residue', {
      namespace: name,
      stamp: stampId,
      detail: detail.slice(0, 200),
    });
  }

  // ---------- shared probes ----------

  private liveNamespaces(selector: string): KubeObject[] {
    return this.kube.listNamespaces(selector).filter((ns) => !ns.metadata?.deletionTimestamp);
  }

  /** Live control-plane pods only — tenant pods cannot enter this selector. */
  private vclusterPods(namespaceName: string): KubeObject[] {
    const pods = this.kube.getJson(['pods', '-n', namespaceName, '-l', VCLUSTER_POD_SELECTOR]);
    return (pods?.items ?? []).filter((p) => !p.metadata?.deletionTimestamp);
  }

  /**
   * The pod that represents the instance right now: a ready one wins, then any
   * non-failed one; an eviction corpse (phase Failed, replacement pending)
   * must never shadow a live pod — that mistake fails healthy boots and lets
   * the residue sweep delete live namespaces.
   */
  private currentPod(namespaceName: string): KubeObject | null {
    const pods = this.vclusterPods(namespaceName);
    return pods.find(podIsReady) ?? pods.find((p) => p.status?.phase !== 'Failed') ?? pods[0] ?? null;
  }

  private podsAllFailed(namespaceName: string): boolean {
    const pods = this.vclusterPods(namespaceName);
    return pods.length > 0 && pods.every((p) => p.status?.phase === 'Failed');
  }

  /**
   * Ready = the vcluster pod passes its probes, the syncer has exported the
   * kubeconfig, AND — while the instance has never yet been ready — the stamp
   * itself is up. One definition, used by every readiness path there is
   * (pool fill, claim, adoption, the handle's status), because the moment
   * "warm" and "ready" answer differently a claim hands out a slot whose
   * stamp nobody ever waited for.
   *
   * `everReady` is the frozen-instance rule (D21's "never mutated"): once an
   * instance has been handed over, the child is the AGENT'S world. An agent who
   * deletes the sample app has changed their own cluster, not broken their env,
   * and the driver must neither say so nor put it back.
   */
  private instanceReady(namespaceName: string, stampId: string, everReady = false): boolean {
    if (!this.vclusterReady(namespaceName)) return false;
    return everReady || this.stampReady(namespaceName, stampId);
  }

  /** The T3 definition, and the whole definition for an instance that has already been ready. */
  private vclusterReady(namespaceName: string): boolean {
    const pod = this.currentPod(namespaceName);
    if (!pod || !podIsReady(pod)) return false;
    return (
      this.kube.getSecretData(namespaceName, VCLUSTER_KUBECONFIG_SECRET, 'config', {
        timeoutMs: PROBE_TIMEOUT_MS,
      }) !== null
    );
  }

  /**
   * Record that this instance HAS been ready, on the runtime, where a restarted
   * host can still see it. Without it, adoption re-arms first-boot semantics on
   * a live instance: the stamp gate would demand a stamp the agent may have
   * replaced, and the boot timer would eventually call a working env failed.
   * Guarded — a missed annotation costs a re-probe, never a claim.
   */
  markEverReady(namespaceName: string, podUid?: string | null): void {
    const uid = podUid ?? this.currentPod(namespaceName)?.metadata?.uid ?? null;
    const annotations: Record<string, string> = { [STATE_ANNOTATION]: 'ready' };
    if (uid) annotations[READY_POD_ANNOTATION] = uid;
    try {
      this.kube.annotate(namespaceName, annotations);
    } catch (error) {
      log.warn('Dev-env k8s: could not persist ready state', { namespace: namespaceName, error: String(error) });
    }
  }

  /**
   * The stamp half of readiness — and the stamp's instantiation, in the same
   * call.
   *
   * A bare stamp is ready with its vcluster. A stamp that deploys something is
   * ready when its readiness Deployment(s) are Available — the stampId-named
   * Deployment for `app`, the DECLARED one for `childManifests` (the stream
   * carries its own names; the declaration is the only definition of "up" the
   * driver has) — and when a gate is ABSENT, this APPLIES the manifests before
   * answering false. Converge-then-probe is deliberate: every readiness path
   * already polls, `kubectl apply` is idempotent, and folding the two together
   * is what makes it structurally impossible for one path to wait for a stamp
   * that no path ever asked for. It also heals — a bundle deleted inside the
   * child converges on the next probe. It converges only on absence, and only
   * while the stamp is not ready: a gate that exists but has not rolled out
   * yet cannot be hastened by re-applying, and nanoclaw's not-ready window is
   * minutes — a whole-bundle apply per 2s poll for that long is pure event-loop
   * tax on the host. Post-first-ready the child is the agent's own world, and
   * a bundle they changed and kept healthy is theirs to keep.
   *
   * Never throws. This runs under watch callbacks and interval timers, where an
   * escape is an uncaught exception that takes the host with it; an unreachable
   * child API is exactly as much information as "not ready yet". The one
   * failure that is MORE information — the child apiserver deterministically
   * rejecting the manifests themselves — is recorded so the boot paths can
   * fail the instance instead of polling the budget out.
   */
  private stampReady(namespaceName: string, stampId: string, forceApply = false): boolean {
    this.healChildServicePolicies(namespaceName, stampId);
    let config = this.stampFor(stampId);
    // The dev-flavor substitution: a dev instance's stamp IS the dev variant
    // (C16 — any stamp's declared one, the builtin's included). Rendered per
    // probe because the tree owner's uid/gid ride the pod spec and only a
    // stat can say them; apply is idempotent, so a re-render converges
    // exactly like the baked stream. A tree that has vanished is
    // DETERMINISTIC (the claim named one path, forever) — recorded as a
    // rejection so boot paths fail now instead of polling the budget out.
    const devTree = this.devTrees.get(namespaceName);
    if (devTree) {
      if (!config?.dev) {
        // ARMED by the claim, answered for by nobody: the config was updated
        // to drop the block — or retired outright — mid-boot. The claim's
        // flavor can no longer be realized; a bare-vcluster or baked verdict
        // here would be the silent-bake lie with a registry-shaped cause.
        this.markStampRejected(namespaceName, stampId, devClaimUnanswered(stampId));
        return false;
      }
      let identity: DevTreeIdentity;
      try {
        const stat = fs.statSync(devTree);
        identity = { runAsUser: stat.uid, runAsGroup: stat.gid };
      } catch (error) {
        this.markStampRejected(namespaceName, stampId, `dev tree unreadable at ${devTree}: ${String(error)}`);
        return false;
      }
      const realized = this.devRealizedConfig(namespaceName, stampId, config, identity);
      if (!realized) return false; // unplaced pull origin — rejection recorded
      config = realized;
    }
    // A stamp the tables no longer answer for (a registered one retired
    // mid-boot): the bare vcluster is the only readiness left to measure —
    // the same verdict the empty gate list below always gave this case.
    // UNLESS the claim is dev-armed on the runtime (the cache is a cache;
    // the annotation is the truth): armed must never read as bare-ready.
    if (!config) return this.refuseIfDevArmed(namespaceName, stampId);
    const gates = readinessDeployments(stampId, config);
    if (gates.length === 0) return this.refuseIfDevArmed(namespaceName, stampId);
    try {
      const child = this.childKube(namespaceName);
      if (!child) return false; // no child API to talk to yet
      if (forceApply) {
        this.ensureStamped(child, namespaceName, stampId, config);
        return true;
      }
      const states = gates.map((gate) =>
        child.getJson(['deployment', gate.deployment, '-n', gate.namespace], { timeoutMs: PROBE_TIMEOUT_MS }),
      );
      if (states.every(deploymentAvailable)) {
        this.stampUnreadyGates.delete(namespaceName);
        // A green gate proves A child is up, not WHICH: both flavors name the
        // same readiness Deployment, which is exactly what let the 08-22
        // silent bake report a baked child active under a dev claim's env id.
        return this.devFlavorRealized(namespaceName, stampId, child);
      }
      this.stampUnreadyGates.set(
        namespaceName,
        gates
          .filter((_gate, index) => !deploymentAvailable(states[index]))
          .map((gate) => `${gate.namespace}/${gate.deployment}`)
          .join(', '),
      );
      if (states.some((state) => state === null)) this.ensureStamped(child, namespaceName, stampId, config);
      return false;
    } catch (error) {
      if (STAMP_REJECTION_RE.test(String(error))) {
        this.markStampRejected(namespaceName, stampId, error);
        return false;
      }
      // The child's PKI is regenerated when its control plane restarts, so a
      // failure here may mean the cached credential is simply stale. Drop the
      // CREDENTIAL and nothing else: a cache that survives its own cluster
      // poisons every later probe, and re-minting from the parent's secret
      // costs two gets. The full forget — which also evicts the dev-tree
      // memory — was the 08-22 silent-bake bug: one connection-refused blip
      // against a just-born child apiserver un-taught the tree, and the next
      // probe applied the BAKED bundle into a dev claim's namespace. Weather
      // may cost a re-mint, never the claim's identity.
      this.dropChildAccess(namespaceName);
      log.warn('Dev-env k8s: child stamp probe failed; treating as not ready', {
        namespace: namespaceName,
        stamp: stampId,
        error: String(error),
      });
      return false;
    }
  }

  /** NetworkPolicy implementations differ on whether Service DNAT happens
   * before selector evaluation. Bind the child DNS and API Services by their
   * exact current ClusterIPs so boot never depends on that ordering, without
   * granting a broad CIDR escape. Re-applied during readiness, so Service
   * recreation heals before the instance can be handed out. */
  private healChildServicePolicies(namespaceName: string, stampId: string): void {
    try {
      const services = this.kube.listServices(namespaceName, SYNCED_BY_LABEL, { timeoutMs: PROBE_TIMEOUT_MS });
      const serviceIp = (childNamespace: string, name: string): string | null => {
        const service = services.find((candidate) => {
          const identity = childObjectIdentity(candidate);
          return identity?.namespace === childNamespace && identity.name === name;
        });
        const value = service?.spec?.clusterIP;
        return typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ? value : null;
      };
      const dnsIp = serviceIp('kube-system', 'kube-dns');
      const podIp = (selector: string): string | null => {
        const status = this.kube.getJson(['pods', '-n', namespaceName, '-l', selector], {
          timeoutMs: PROBE_TIMEOUT_MS,
        })?.items?.[0]?.status as { podIP?: string } | undefined;
        const value = status?.podIP;
        return typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ? value : null;
      };
      const dnsPodIp = podIp('k8s-app=vcluster-kube-dns');
      if (dnsIp) {
        this.kube.apply(JSON.stringify({
          apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
          metadata: { name: 'dev-env-child-dns', namespace: namespaceName },
          spec: {
            podSelector: {}, policyTypes: ['Egress'],
            egress: [
              {
                to: [{ ipBlock: { cidr: `${dnsIp}/32` } }],
                ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
              },
              ...(dnsPodIp
                ? [{
                    to: [{ ipBlock: { cidr: `${dnsPodIp}/32` } }],
                    ports: [{ protocol: 'UDP', port: 1053 }, { protocol: 'TCP', port: 1053 }],
                  }]
                : []),
            ],
          },
        }));
      }
      if (stampId !== 'governed-child-kata') return;
      const apiIp = this.kube.getJson(['service', VCLUSTER_NAME, '-n', namespaceName], {
        timeoutMs: PROBE_TIMEOUT_MS,
      })?.spec?.clusterIP;
      if (typeof apiIp !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(apiIp)) return;
      const apiPodIp = podIp('app=vcluster');
      for (const [name, selector] of [
        ['governed-host-vcluster-api', { app: 'nanoclaw-host', 'nanoco.dev/trust-boundary': 'control' }],
        ['governed-coredns-vcluster-api', { 'k8s-app': 'vcluster-kube-dns' }],
      ] as const) {
        this.kube.apply(JSON.stringify({
          apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
          metadata: { name, namespace: namespaceName },
          spec: {
            podSelector: { matchLabels: selector }, policyTypes: ['Egress'],
            egress: [
              {
                to: [{ ipBlock: { cidr: `${apiIp}/32` } }],
                ports: [{ protocol: 'TCP', port: 443 }],
              },
              ...(apiPodIp
                ? [{
                    to: [{ ipBlock: { cidr: `${apiPodIp}/32` } }],
                    ports: [{ protocol: 'TCP', port: 8443 }],
                  }]
                : []),
            ],
          },
        }));
      }
    } catch (error) {
      log.warn('Dev-env k8s: child Service NetworkPolicy heal failed; treating as not yet ready', {
        namespace: namespaceName,
        error: String(error),
      });
    }
  }

  /**
   * The claim's dev arming, read from CLUSTER STATE: the cache when taught,
   * the option annotation on the instance namespace when not — never cache
   * silence alone. The devTrees map is a cache, and the 08-22 incident was a
   * probe path trusting its silence: the entry evicted mid-boot, the baked
   * bundle applied, the shared-name readiness gate went green, and the claim
   * reported active over the wrong child. Re-teaches the cache so later
   * renders substitute again.
   */
  private devClaimArmed(namespaceName: string): string | null {
    const cached = this.devTrees.get(namespaceName);
    if (cached) return cached;
    const ns = this.kube.getNamespace(namespaceName);
    const fromRuntime = ns?.metadata?.annotations?.[`${OPTION_PREFIX}${DEV_TREE_OPTION}`];
    if (!fromRuntime) return null;
    this.devTrees.set(namespaceName, fromRuntime);
    return fromRuntime;
  }

  /** The no-gates verdicts' honesty clamp: true (ready) only when the claim is not dev-armed. */
  private refuseIfDevArmed(namespaceName: string, stampId: string): boolean {
    if (!this.devClaimArmed(namespaceName)) return true;
    this.markStampRejected(namespaceName, stampId, devClaimUnanswered(stampId));
    return false;
  }

  /**
   * The claim's realized dev config (C16): the stamp becomes its declared dev
   * variant, plus the PLATFORM-AUTHORED tree claim appended after the
   * author's documents (whose stream may create the consumer namespace the
   * claim lands in). App shape: the driver renders the variant — mount,
   * overrides, and the tree-owner securityContext clamp — around the same
   * resolved image rules the baked render obeys (an unplaced pull origin is
   * the same recorded rejection). childManifests shape: the author's declared
   * stream with the identity tokens substituted off the stat. Both realize as
   * one childManifests stream gating on the CONSUMER — the same Deployment
   * the baked flavor gates on, which is exactly why devFlavorRealized exists.
   */
  private devRealizedConfig(
    namespaceName: string,
    stampId: string,
    config: K8sStampConfig,
    identity: DevTreeIdentity,
  ): K8sStampConfig | null {
    const gate = devConsumerGate(stampId, config);
    const dev = config.dev!;
    let variant: string;
    if (config.app) {
      const app = this.placedAppSpec(namespaceName, stampId, config);
      if (!app) return null;
      variant = renderDevAppManifests(stampId, app, dev as StampDevApp, identity);
    } else {
      variant = substituteDevTreeIdentity(isDevManifests(dev) ? dev.manifests : '', identity);
    }
    return {
      // The tree claim lands in the CONSUMER's namespace — that is what the
      // consumer gate is for here.
      childManifests: `${variant}\n---\n${renderDevTreePvc(gate.namespace)}`,
      // …but readiness stays EVERY declared gate, never the consumer alone.
      // The app shape has exactly one either way; the childManifests shape may
      // now have several (dev.consumer lifted the single-gate limit), and
      // collapsing them here would mean a dev claim of a whole-deployment
      // stamp goes ready the moment its ONE hot-reloaded component is up —
      // with its governance and its gateway still down. That is the same
      // silent under-gating a readiness LIST exists to kill, reintroduced for
      // exactly the flavor a developer iterates in. A dev variant realizes the
      // same deployment; it waits for the same legs.
      readiness: config.app ? gate : readinessGates(config),
    };
  }

  /**
   * The realized-fidelity gate (the runbook's §3.8 STOP condition, mechanized
   * in #209; generalized and re-anchored in C16): before an instance's first
   * ready, the world must BE the flavor the claim named. ARMED by the claim —
   * the option annotation, cluster state — never by the config re-resolved at
   * probe time (a mid-boot update can change that answer out from under the
   * claim) and never by cache silence (the 08-22 rule; see devClaimArmed).
   *
   * Three parts, because platform authorship changed what a bound PVC can
   * attest (the platform creating `dev-tree` for every dev claim says nothing
   * about which variant runs):
   *
   * - The config must still ANSWER for dev — dropped or retired mid-boot is a
   *   recorded rejection naming the mismatch, never bare-ready.
   * - VARIANT evidence reads the CONSUMER: the consuming Deployment's pod
   *   template — the same object whose Available was just measured — must
   *   mount a PVC named `dev-tree`. A baked variant applied under a dev
   *   annotation (the silent-bake shape) and a registered dev stream whose
   *   consumer never mounts the tree both die here, loudly.
   * - BIND evidence reads the PARENT: the formula-named synced PVC,
   *   `spec.volumeName` equal to the pre-bound PV. Parent-side on purpose:
   *   the pre-bind lives there, and the child's view of its own claim is the
   *   syncer's translation. A foreign volumeName (a provisioner won the race
   *   the pre-bind exists to preclude — the child runs a fresh EMPTY volume)
   *   never heals; a missing synced PVC under a green gate means a different
   *   bundle is the thing running.
   *
   * Every violation is deterministic, recorded as a rejection: the boot fails
   * NOW, loudly, instead of handing an agent a child whose tree is not the
   * one they claimed.
   */
  private devFlavorRealized(namespaceName: string, stampId: string, child: Kube): boolean {
    if (!this.devClaimArmed(namespaceName)) return true; // genuinely baked — nothing to assert
    const config = this.stampFor(stampId);
    if (!config?.dev) {
      this.markStampRejected(namespaceName, stampId, devClaimUnanswered(stampId));
      return false;
    }
    const gate = devConsumerGate(stampId, config);
    const consumer = child.getJson(['deployment', gate.deployment, '-n', gate.namespace], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const volumes = consumer?.spec?.template?.spec?.volumes ?? [];
    if (!volumes.some((volume) => volume?.persistentVolumeClaim?.claimName === DEV_TREE_PVC)) {
      this.markStampRejected(
        namespaceName,
        stampId,
        `the consuming deployment '${gate.namespace}/${gate.deployment}' does not mount the '${DEV_TREE_PVC}' ` +
          `claim — the realized child is not the dev flavor this claim named`,
      );
      return false;
    }
    const pvc = this.kube.getJson(['pvc', syncedDevTreePvcName(gate.namespace), '-n', namespaceName], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (pvc?.spec?.volumeName === devTreePvName(namespaceName)) return true;
    this.markStampRejected(
      namespaceName,
      stampId,
      pvc
        ? `dev-tree PVC bound to '${String(pvc.spec?.volumeName)}' instead of the pre-bound PV ` +
            `'${devTreePvName(namespaceName)}' — a provisioner won the bind; the child runs an empty ` +
            `volume, not the claimed tree`
        : `readiness gate green without the dev-tree PVC — the realized child is not the dev flavor ` +
            `this claim named`,
    );
    return false;
  }

  /**
   * Idempotent instantiation of everything the stamp deploys inside the child
   * (D10's instantiate hook). Bounded like the probes around it: this runs on
   * the same watch-callback/poll paths, and an apply riding the CLI's default
   * budget would let one hung child apiserver stall the host for its length.
   * A timed-out apply reads as not-ready and retries; what landed stays
   * landed, so retries make monotonic progress.
   */
  private ensureStamped(child: Kube, namespaceName: string, stampId: string, config: K8sStampConfig): void {
    if (config.app) {
      const app = this.placedAppSpec(namespaceName, stampId, config);
      if (!app) return; // unplaced pull origin — rejection recorded, nothing to apply
      // Same token, both shapes: an author must not have to know which render
      // path their stamp takes to know whether `${INSTANCE}` resolves.
      child.apply(substituteInstance(renderAppManifests(stampId, app), namespaceName), {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    }
    // `${INSTANCE}` resolves to the instance's own parent-side namespace name,
    // unconditionally and on every apply (C3): the stream authors its own
    // identity env entries (`{"name": "ORG_ID", "value": "org-${INSTANCE}"}` —
    // see STAMP_IDENTITY_EXAMPLE) and no identity logic enters the driver.
    // Unconditional because the seed must be the same on the fill and on every
    // heal — the namespace name is allocated before a claimant exists, which is
    // the only reason a per-instance identity and a warm pool can coexist. A
    // stream without the token is unchanged.
    if (config.childManifests) {
      const rendered = substituteInstance(config.childManifests, namespaceName);
      child.apply(this.instanceRelay?.renderChild(namespaceName, rendered) ?? rendered, {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    }
  }

  /**
   * The render's image, resolved per origin (C15). Node-local apps render
   * what they declare — today's behavior. A pull-origin app renders the
   * DERIVED NON-RESOLVABLE ref pinned to the digest placement recorded: the
   * exact bits, immune to later re-tagging, under a name no resolver answers
   * for — which is what keeps "a claim never pulls" mechanical (an evicted
   * image is an image-pull refusal the re-probe heals, never a live fetch).
   *
   * Null = pull origin with nothing placed. The claim gate above the seam
   * refuses those before a claim exists; a path that reaches here anyway
   * (gate bypassed, snapshot raced an eviction flip) records a DETERMINISTIC
   * rejection — booting a pod whose image is not in the store is the exact
   * boot-timeout shape C15 kills. The digest is the CURRENT version's: the
   * gate holds claims of any other.
   */
  private placedAppSpec(namespaceName: string, stampId: string, config: K8sStampConfig): AppStampSpec | null {
    const origin = stampImageOrigin(config);
    if (origin.kind !== 'pull') return config.app ?? null;
    const placed = this.stampSource?.placedImage?.(stampId);
    if (!placed) {
      this.markStampRejected(
        namespaceName,
        stampId,
        `registry-origin image is not placed — claimable when stamps get shows placed`,
      );
      return null;
    }
    return { ...config.app!, image: `${placeRef(stampId, placed.version)}@${placed.digest}` };
  }

  /**
   * A rejected stamp never converges: same stream, same rejection, on this
   * boot and on the retry a "retryable" verdict would invite. Recording only —
   * the boot paths reading it deliver the verdict.
   */
  private markStampRejected(namespaceName: string, stampId: string, error: unknown): void {
    // Node's child-process error starts with the full kubectl argv. For child
    // calls that prefix --kubeconfig/--server/--tls-server-name, the former
    // 200-character ceiling cut the message immediately before kubectl's
    // actual validation error. Keep this bounded, but large enough to carry
    // the first resource refusal; stdin (the manifest stream and Secret
    // payloads) is never included by execFileSync's error message.
    const detail = `stamp '${stampId}' manifests rejected by the child: ${String(error).slice(0, 1_200)}`;
    if (!this.stampRejections.has(namespaceName)) {
      log.warn('Dev-env k8s: stamp manifests rejected; the instance cannot converge', {
        namespace: namespaceName,
        stamp: stampId,
        detail,
      });
    }
    this.stampRejections.set(namespaceName, detail);
  }

  /** @internal handle back-channel: why this instance's stamp can never converge, when it cannot. */
  stampRejection(namespaceName: string): string | null {
    return this.stampRejections.get(namespaceName) ?? null;
  }

  /** @internal handle back-channel: which gates were last seen unready, for the timeout's detail. */
  stampUnready(namespaceName: string): string | null {
    return this.stampUnreadyGates.get(namespaceName) || null;
  }

  /**
   * The C14 exposure target, resolved against the PARENT's view of the child
   * (@internal handle back-channel).
   *
   * Reads the synced Services in the instance namespace — `managed-by`
   * PRESENT is the syncer's stamp, so the control plane's own `vc` services
   * are excluded without naming them, and a tenant cannot mint a parent
   * object at all. Nothing is cached: post-first-ready the child is the
   * agent's world, and a Service deleted and recreated comes back under a new
   * ClusterIP whose predecessor the cluster may already have reissued to
   * someone else's env.
   *
   * Ambiguity is answered at GRANT and never at dial time: with a bare port
   * two qualifying services THROW (name one with --service), while a frozen
   * `<ns>/<name>` can only hit or MISS — and a miss returns null, which the
   * caller turns into a refused connection.
   */
  resolveExposureTarget(
    namespaceName: string,
    request: { service?: string; port: number },
  ): ExposureTargetResolution | null {
    const candidates: ExposureTargetResolution[] = [];
    const services = this.kube.listServices(namespaceName, SYNCED_BY_LABEL, { timeoutMs: PROBE_TIMEOUT_MS });
    for (const service of services) {
      const identity = childObjectIdentity(service);
      if (!identity) continue;
      const address = service.spec?.clusterIP;
      if (!address || address === 'None') continue; // headless: nothing to dial
      if (!(service.spec?.ports ?? []).some((entry) => entry.port === request.port)) continue;
      const qualified = `${identity.namespace}/${identity.name}`;
      // `--service` takes the child's own name, with the namespace optional —
      // the agent reads those names through its kubeconfig, not the parent's
      // translated ones. The frozen form is always qualified, so the freeze
      // and every later dial compare the same string.
      if (request.service && request.service !== qualified && request.service !== identity.name) continue;
      candidates.push({ service: qualified, address, port: request.port });
    }
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      const names = candidates.map((candidate) => candidate.service).join(', ');
      throw new Error(
        `${candidates.length} services serve port ${request.port} in this env (${names}) — ` +
          'name the one to expose with --service',
      );
    }
    return candidates[0];
  }

  /**
   * A `Kube` speaking to one instance's CHILD apiserver, or null while the
   * syncer has not exported access yet.
   *
   * Two corrections to the exported kubeconfig, both forced by where the driver
   * runs: its server is `https://vc.<ns>.svc:443`, which resolves in-cluster and
   * nowhere else, so the address becomes the service's clusterIP — and the
   * cert's SANs are the service names, so the original name has to ride along
   * as `--tls-server-name` or TLS fails against the IP.
   */
  private childKube(namespaceName: string): Kube | null {
    const access = this.childAccess(namespaceName);
    if (!access) return null;
    return new Kube(withKubectlFlags(this.cli, [`--kubeconfig=${access.kubeconfig}`, ...access.flags]));
  }

  private childAccess(namespaceName: string): ChildAccess | null {
    const cached = this.childAccessCache.get(namespaceName);
    if (cached && fs.existsSync(cached.kubeconfig)) return cached;
    const probe = { timeoutMs: PROBE_TIMEOUT_MS };
    const config = this.kube.getSecretData(namespaceName, VCLUSTER_KUBECONFIG_SECRET, 'config', probe);
    if (config === null) return null;
    const clusterIP = this.kube.getJson(['svc', VCLUSTER_NAME, '-n', namespaceName], probe)?.spec?.clusterIP;
    if (!clusterIP || clusterIP === 'None') return null;
    // Driver-private, and deliberately NOT in the per-owner layout: this is the
    // host's own way into the child, not material anyone claimed. Owner slugs
    // never start with a dot, so the two cannot collide.
    const file = path.join(this.materialsDir, CHILD_ACCESS_DIR, namespaceName, 'kubeconfig');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, config, { mode: 0o600 });
    const access: ChildAccess = {
      kubeconfig: file,
      flags: [`--server=https://${clusterIP}:443`, `--tls-server-name=${VCLUSTER_NAME}.${namespaceName}.svc`],
    };
    this.childAccessCache.set(namespaceName, access);
    return access;
  }

  /** Everything minted for a namespace that is going away: the owner's copy and the driver's own. */
  private removeMaterials(ns: KubeObject): void {
    const instanceId = ns.metadata?.labels?.[DEV_ENV_LABELS.instance];
    const scope = ns.metadata?.labels?.[SCOPE_LABEL] ?? UNSCOPED_MATERIALS;
    if (instanceId) fs.rmSync(materialsPath(this.materialsDir, scope, instanceId), { recursive: true, force: true });
    this.forgetChild(ns.metadata?.name);
  }

  /** @internal handle back-channel; also the driver's own teardown paths. */
  forgetChild(namespaceName: string | undefined): void {
    if (!namespaceName) return;
    this.stampRejections.delete(namespaceName);
    this.stampUnreadyGates.delete(namespaceName);
    this.devTrees.delete(namespaceName);
    this.dropChildAccess(namespaceName);
  }

  /**
   * Drop ONLY the child-API credential — the stale-PKI heal, deliberately
   * narrower than forgetChild: a failed child call implicates the cached
   * credential, never the claim's own memory (devTrees — see the 08-22
   * silent-bake incident) nor a recorded deterministic rejection.
   */
  private dropChildAccess(namespaceName: string): void {
    this.childAccessCache.delete(namespaceName);
    fs.rmSync(path.join(this.materialsDir, CHILD_ACCESS_DIR, namespaceName), { recursive: true, force: true });
  }

  // ---------- handles ----------

  private handleFor(ns: KubeObject): DevEnvInstanceHandle {
    // Adoption's road into the dev-tree cache: a rediscovered handle carries
    // the option annotation, and the probe paths must know before the first
    // stamp probe runs under this handle.
    this.rememberDevTree(ns);
    return new K8sInstanceHandle(this, this.kube, ns, {
      materialsDir: this.materialsDir,
      bootTimeoutMs: this.bootTimeoutMs,
      now: this.now,
    });
  }

  /** @internal handle back-channel */
  probeReady(namespaceName: string, stampId: string, everReady = false): boolean {
    return this.instanceReady(namespaceName, stampId, everReady);
  }
  /** @internal handle back-channel: the stamp half alone, for callers holding the vcluster half already. */
  probeStamp(namespaceName: string, stampId: string): boolean {
    return this.stampReady(namespaceName, stampId);
  }
  /** @internal handle back-channel */
  probePod(namespaceName: string): KubeObject | null {
    return this.currentPod(namespaceName);
  }
}

interface HandleContext {
  materialsDir: string;
  bootTimeoutMs: number;
  now: () => number;
}

class K8sInstanceHandle implements DevEnvInstanceHandle {
  readonly key: EnvKey;
  readonly stampId: string;
  readonly name: string;

  /** Slugged materials scope, read off the runtime — adoption gets it the same way a fresh claim does. */
  #materialsScope: string;
  /** Where this claim's route lives, read off the runtime — the close paths' pointer (D19). */
  #claimantNamespace: string | null;
  /** Non-null on a dev-flavor instance (read off the runtime): teardown owes a PV delete too. */
  #devTree: string | null;
  #driver: K8sDevEnvDriver;
  #kube: Kube;
  #ctx: HandleContext;
  #releaseRequested = false;
  #readyFired = false;
  #terminalFired = false;
  /** Readiness at handle construction: an already-ready handle never fires onReady. */
  #baselineReady: boolean;
  /**
   * Has this INSTANCE ever been fully ready — not just its pod? Distinct from
   * `#sawReadyEvent`, which a pod going ready sets while the stamp may still
   * be rolling out. Once true the stamp gate is off for good: the child belongs to
   * the agent, and first-boot semantics must never be re-armed over it.
   */
  #everReady: boolean;
  /** Whether the runtime already carries the ready annotation — one write per instance, not per probe. */
  #readyMarked: boolean;
  #sawReadyEvent = false;
  /** The pod that WAS the instance when it became ready — a different uid later means the state died with the old pod. */
  #readyPodUid: string | null = null;
  #failure: DevEnvFailure | null = null;
  #readyCbs: Array<() => void> = [];
  #terminalCbs: Array<(failure?: DevEnvFailure) => void> = [];
  #watch: SupervisedProcess | null = null;
  #watchBackoffMs = WATCH_BACKOFF_MIN_MS;
  #bootTimer: ReturnType<typeof setTimeout> | null = null;
  /** The instance's whole boot budget, and the ONLY deadline the stamp half answers to. */
  #bootDeadline: number;
  #secretPolling = false;

  constructor(driver: K8sDevEnvDriver, kube: Kube, ns: KubeObject, ctx: HandleContext) {
    const labels = ns.metadata?.labels ?? {};
    this.key = { envId: labels[DEV_ENV_LABELS.env], instanceId: labels[DEV_ENV_LABELS.instance] };
    this.stampId = labels[DEV_ENV_LABELS.stamp];
    this.name = ns.metadata!.name!;
    this.#materialsScope = labels[SCOPE_LABEL] ?? UNSCOPED_MATERIALS;
    this.#claimantNamespace = ns.metadata?.annotations?.[CLAIMANT_NS_ANNOTATION] ?? null;
    this.#devTree = ns.metadata?.annotations?.[`${OPTION_PREFIX}${DEV_TREE_OPTION}`] ?? null;
    this.#driver = driver;
    this.#kube = kube;
    this.#ctx = ctx;
    // The budget anchors on the INSTANCE's birth, which the runtime remembers
    // and this process may not: a re-adopted in-flight claim resumes the
    // budget it already spent, so a wedged instance still fails loudly at the
    // ORIGINAL deadline instead of earning a fresh budget per restart — on a
    // 15-minute restart cadence that refill would make `claiming` a state a
    // broken env holds forever. A birth the clock has not reached (skew) or
    // cannot parse anchors on now, which is the fresh-claim value anyway.
    const born = Math.min(Date.parse(ns.metadata?.creationTimestamp ?? '') || ctx.now(), ctx.now());
    this.#bootDeadline = born + ctx.bootTimeoutMs;
    // An instance the runtime remembers as ready is ready, full stop: no app
    // gate (the child is the agent's), no probe of a stamp they may have
    // replaced. Anything else re-runs a first boot over a live env.
    this.#everReady = !nsFailed(ns) && nsEverReady(ns);
    this.#readyMarked = this.#everReady; // the runtime already says so; nothing to write
    this.#baselineReady = this.#everReady || (nsFailed(ns) ? false : driver.probeReady(this.name, this.stampId));
    // Prefer the pod identity the runtime remembers: adoption during a pod
    // restart has nothing to read from the cluster, and anchoring on whatever
    // pod appears next is how a replacement is mistaken for the original.
    this.#readyPodUid = ns.metadata?.annotations?.[READY_POD_ANNOTATION] ?? null;
    if (this.#baselineReady) {
      this.#readyPodUid ??= driver.probePod(this.name)?.metadata?.uid ?? null;
      this.markEverReady();
    }
    if (nsFailed(ns)) this.#failure = failureFromAnnotations(ns);
    this.armWatch();
    // No boot timer for an instance that has already booted — the timer is a
    // first-boot deadline, and arming it on a live env is how adoption would
    // eventually declare a working instance failed. It fires at the anchored
    // deadline, not a fresh budget from now (see #bootDeadline above).
    if (!this.#baselineReady && !this.#failure) {
      this.#bootTimer = setTimeout(() => this.bootTimedOut(), Math.max(0, this.#bootDeadline - ctx.now()));
      this.#bootTimer.unref?.();
    }
  }

  /**
   * Latch first-ready here and on the runtime. Cheap and idempotent per handle:
   * the annotation is the part that survives this process.
   */
  private markEverReady(): void {
    this.#everReady = true;
    if (this.#readyMarked) return;
    this.#readyMarked = true;
    this.#driver.markEverReady(this.name, this.#readyPodUid);
  }

  /**
   * The C14 exposure capability (seam, optional): what serves this port in
   * this instance right now. Called at grant to freeze a service name and per
   * connection for the address to dial — never cached on either side.
   */
  async resolveExposureTarget(request: { service?: string; port: number }): Promise<ExposureTargetResolution | null> {
    return this.#driver.resolveExposureTarget(this.name, request);
  }

  /** ADOPTION ONLY (seam): the host naming the owner this instance's material belongs under. */
  setMaterialsScope(scope: string): void {
    const slug = materialsScopeSlug(scope);
    this.#materialsScope = slug;
    // Heal the runtime too, so the NEXT adoption needs no telling — and so a
    // re-mint after this one lands in the slice the sandbox actually mounts.
    const ns = this.#kube.getNamespace(this.name);
    if (ns && !ns.metadata?.labels?.[SCOPE_LABEL]) {
      try {
        this.#kube.label(this.name, { [SCOPE_LABEL]: slug });
      } catch (error) {
        log.warn('Dev-env k8s: could not record adopted materials scope', {
          namespace: this.name,
          error: String(error),
        });
      }
    }
  }

  async status(): Promise<InstanceStatus> {
    try {
      return await this.statusInner();
    } catch (error) {
      throw isDevEnvFailure(error) ? error : normalizeK8sFailure(error);
    }
  }

  private async statusInner(): Promise<InstanceStatus> {
    const ns = this.#kube.getNamespace(this.name);
    if (!ns || ns.metadata?.deletionTimestamp) {
      if (this.#releaseRequested) return { phase: 'released' };
      return { phase: 'failed', failure: this.#failure ?? { kind: 'instance-died', retryable: false } };
    }
    if (nsFailed(ns)) return { phase: 'failed', failure: this.#failure ?? failureFromAnnotations(ns) };
    const pod = this.#driver.probePod(this.name);
    if (this.podIdentityChanged(pod)) {
      return { phase: 'failed', failure: { kind: 'instance-died', retryable: false } };
    }
    if (pod?.status?.phase === 'Failed') {
      if (this.readyObserved()) return { phase: 'failed', failure: { kind: 'instance-died', retryable: false } };
      return {
        phase: 'failed',
        failure: { kind: 'instantiation-failed', retryable: false, detail: 'vcluster pod failed' },
      };
    }
    if (pod && podIsReady(pod)) {
      const kubeconfig = this.mintKubeconfig();
      // The same stamp gate the pool's warm flip uses, and only until the
      // instance has been ready once. Without it a cold claim reports active
      // the moment the empty cluster answers; after first-ready, keeping it
      // would report an agent's own changes as a broken env.
      if (kubeconfig && (this.#everReady || this.#driver.probeStamp(this.name, this.stampId))) {
        this.markEverReady();
        return {
          phase: 'ready',
          endpoints: { api: `https://${VCLUSTER_NAME}.${this.name}.svc:443` },
          access: { kubeconfig },
        };
      }
    }
    return { phase: 'provisioning' };
  }

  async release(reason: string): Promise<void> {
    this.#releaseRequested = true;
    this.settle();
    await this.#driver.releaseInstanceRelay(this.name);
    // The route CANNOT ride the namespace delete — it lives in the claimant's
    // namespace — and it closes FIRST: reachability must not outlive the
    // instance in the window finalizers hold the namespace open.
    this.#driver.closeClaimRoute(this.#claimantNamespace, this.key.instanceId);
    // Neither can the dev-tree PV (cluster-scoped): a released PV would keep
    // naming a directory in the owner's workspace under a reusable name.
    if (this.#devTree) this.#driver.deleteDevTreePv(this.name);
    this.#kube.deleteNamespace(this.name);
    this.removeMaterials();
    log.info('Dev-env k8s: instance released', { namespace: this.name, reason });
  }

  onReady(cb: () => void): void {
    if (this.#baselineReady) return; // already ready when obtained — never fires (contract)
    this.#readyCbs.push(cb);
  }

  onTerminal(cb: (failure?: DevEnvFailure) => void): void {
    this.#terminalCbs.push(cb);
  }

  // ---------- internals ----------

  private armWatch(): void {
    if (this.#watch || this.#releaseRequested || this.#terminalFired) return;
    this.#watch = this.#kube.watchPods(
      this.name,
      VCLUSTER_POD_SELECTOR,
      (event) => this.onWatchEvent(event),
      () => this.onWatchDrop(),
    );
  }

  private onWatchEvent(event: WatchEvent): void {
    this.#watchBackoffMs = WATCH_BACKOFF_MIN_MS;
    if (this.#releaseRequested || this.#terminalFired) return;
    // Nothing in here may throw: this runs inside the watch process's stdout
    // handler, where an escape is an uncaught exception that kills the host.
    try {
      this.handleWatchEvent(event);
    } catch (error) {
      // A probe blip degrades to a missed event; drop-reconciliation and the
      // boot timer are the backstops for whatever we failed to handle here.
      log.warn('Dev-env k8s: watch event probe failed', { namespace: this.name, error: String(error) });
    }
  }

  private handleWatchEvent(event: WatchEvent): void {
    if (event.type === 'DELETED') {
      // Pod deletion post-ready is instance death: the emptyDir state died
      // with it, and claimed instances are frozen — a fresh pod under the
      // Deployment is a different (broken) world. During provisioning, a
      // deleted pod may simply be rescheduled — unless the namespace itself
      // is going (Terminating counts: external teardown is external teardown
      // even while finalizers grind).
      const ns = this.#kube.getNamespace(this.name);
      const namespaceGone = !ns || !!ns.metadata?.deletionTimestamp;
      if (this.readyObserved() || namespaceGone) {
        this.fireTerminal({ kind: 'instance-died', retryable: false });
      }
      return;
    }
    const pod = event.object;
    if (this.readyObserved()) {
      // Frozen instances: any new pod identity after ready means the world we
      // handed out is gone, whatever shiny replacement the Deployment boots.
      if (pod.metadata?.uid && this.#readyPodUid && pod.metadata.uid !== this.#readyPodUid) {
        this.fireTerminal({ kind: 'instance-died', retryable: false });
        return;
      }
      if (pod.status?.phase === 'Failed') {
        this.fireTerminal({ kind: 'instance-died', retryable: false });
        return;
      }
      return;
    }
    if (pod.status?.phase === 'Failed') {
      // An eviction corpse with a live replacement booting beside it is not a
      // boot failure — only an all-failed namespace is.
      if (this.#driver.probePod(this.name)?.status?.phase === 'Failed') {
        this.markBootFailed({ kind: 'instantiation-failed', retryable: false, detail: 'vcluster pod failed' });
      }
      return;
    }
    if (podIsReady(pod)) {
      this.#readyPodUid = pod.metadata?.uid ?? this.#readyPodUid;
      this.settleReady();
    }
  }

  private readyObserved(): boolean {
    return this.#baselineReady || this.#readyFired || this.#sawReadyEvent;
  }

  private podIdentityChanged(pod: KubeObject | null): boolean {
    return (
      this.readyObserved() &&
      this.#readyPodUid !== null &&
      pod?.metadata?.uid !== undefined &&
      pod.metadata.uid !== this.#readyPodUid
    );
  }

  private settleReady(): void {
    this.#sawReadyEvent = true;
    if (this.#baselineReady || this.#readyFired || this.#terminalFired || this.#releaseRequested) return;
    // Pod ready is necessary, not sufficient: the syncer exports the child
    // kubeconfig moments later and whatever the stamp deploys comes up later
    // still, and a ready without access — or without the stamp — is a lie.
    if (this.accessAndStampReady()) {
      this.fireReady();
      return;
    }
    if (this.#secretPolling) return;
    this.#secretPolling = true;
    void this.pollSecretThenFire().finally(() => {
      this.#secretPolling = false;
    });
  }

  /**
   * The handle's half of the ONE readiness definition: access exported and the
   * stamp's readiness Deployments up. Routed through the driver so the answer
   * a handle gives and the answer the pool's warm gate gives cannot drift
   * apart.
   */
  private accessAndStampReady(): boolean {
    if (this.trySecret() === null) return false;
    return this.#everReady || this.#driver.probeStamp(this.name, this.stampId);
  }

  /** Guarded secret probe: a transient failure reads as "not yet", never as a throw. */
  private trySecret(): string | null {
    try {
      return this.#kube.getSecretData(this.name, VCLUSTER_KUBECONFIG_SECRET, 'config', {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      log.warn('Dev-env k8s: kubeconfig secret probe failed; will retry', {
        namespace: this.name,
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Poll the rest of readiness after the pod goes ready.
   *
   * Two deadlines, because the two halves fail differently. The syncer exports
   * its kubeconfig within seconds of the pod passing probes, so a minutes-long
   * absence is a broken syncer and gets its own short cap and its own verdict.
   * The stamp half runs on the INSTANCE's boot budget — the same budget a
   * pool fill gets for the same stamp — and the boot timer owns that expiry, so
   * there is exactly one deadline and one verdict for it.
   */
  private async pollSecretThenFire(): Promise<void> {
    for (let attempt = 1; this.#ctx.now() <= this.#bootDeadline; attempt++) {
      await sleep(SECRET_POLL_INTERVAL_MS);
      if (this.#readyFired || this.#terminalFired || this.#releaseRequested) return;
      if (this.accessAndStampReady()) {
        this.fireReady();
        return;
      }
      // A recorded rejection is deterministic — the same stream gets the same
      // refusal next poll, and on the retry a deadline verdict would invite.
      const rejected = this.#driver.stampRejection(this.name);
      if (rejected) {
        this.markBootFailed({ kind: 'instantiation-failed', retryable: false, detail: rejected });
        return;
      }
      if (this.trySecret() === null && attempt >= SECRET_POLL_ATTEMPTS) {
        this.markBootFailed({
          kind: 'instantiation-failed',
          retryable: false,
          detail: 'vcluster kubeconfig secret never appeared',
        });
        return;
      }
    }
  }

  private fireReady(): void {
    if (this.#readyFired) return;
    this.#readyFired = true;
    this.markEverReady();
    this.clearBootTimer();
    for (const cb of this.#readyCbs.splice(0)) cb();
  }

  private fireTerminal(failure: DevEnvFailure): void {
    if (this.#terminalFired || this.#releaseRequested) return;
    this.#terminalFired = true;
    this.#failure = failure;
    this.settle();
    // Terminal ends leave no credential files behind; release() has its own copy.
    this.removeMaterials();
    // And no standing route either: once the child namespace is gone the
    // route admits nothing, but it would pre-open the group's pods to any
    // future namespace wearing the same (random, reusable) name. Guarded
    // internally — this runs under watch callbacks, where a throw kills the
    // host.
    this.#driver.closeClaimRoute(this.#claimantNamespace, this.key.instanceId);
    // Same for the dev-tree PV: cluster-scoped, guarded internally.
    if (this.#devTree) this.#driver.deleteDevTreePv(this.name);
    for (const cb of this.#terminalCbs.splice(0)) cb(failure);
  }

  private markBootFailed(failure: DevEnvFailure): void {
    try {
      // Persist the failure on the runtime so a restarted driver's discovery
      // sees residue, not a provisioning instance that never finishes.
      this.#kube.annotate(this.name, { [STATE_ANNOTATION]: 'failed', [FAILURE_ANNOTATION]: failure.kind });
    } catch (error) {
      log.warn('Dev-env k8s: could not persist boot failure', { namespace: this.name, error: String(error) });
    }
    this.fireTerminal(failure);
  }

  /**
   * The one deadline for a first boot. It also decides WHICH failure this is:
   * an app that did not finish rolling out inside the budget is a deadline the
   * same claim could beat next time (retryable), while a vcluster that never
   * came up at all is not.
   */
  private bootTimedOut(): void {
    if (this.#readyFired || this.#terminalFired || this.#releaseRequested) return;
    // Backstop for a rejection observed on a probe path the poll never ran on.
    const rejected = this.#driver.stampRejection(this.name);
    if (rejected) {
      this.markBootFailed({ kind: 'instantiation-failed', retryable: false, detail: rejected });
      return;
    }
    const stampPending = this.trySecret() !== null;
    // Name the gates that were still red. Without them this verdict sends a
    // reader to the whole child; with them it sends them to one Deployment.
    const unready = this.#driver.stampUnready(this.name);
    this.markBootFailed({
      kind: 'instantiation-failed',
      retryable: stampPending,
      detail: stampPending
        ? `stamp '${this.stampId}' never became ready inside its instance` +
          (unready ? ` — not Available: ${unready}` : '')
        : 'boot timeout',
    });
  }

  private onWatchDrop(): void {
    this.#watch = null;
    if (this.#releaseRequested || this.#terminalFired) return;
    // Watch drops are routine; reconcile what we missed, then re-arm. A
    // FAILED reconcile is itself a drop — retry on the same backoff, forever;
    // supervision never dies quietly.
    const timer = setTimeout(() => {
      if (this.#releaseRequested || this.#terminalFired) return;
      this.status().then(
        (status) => {
          if (this.#releaseRequested || this.#terminalFired) return;
          if (status.phase === 'failed') {
            this.fireTerminal(status.failure);
          } else if (status.phase === 'released') {
            // External teardown we did not request.
            this.fireTerminal({ kind: 'instance-died', retryable: false });
          } else {
            if (status.phase === 'ready') this.settleReady();
            this.armWatch();
          }
        },
        (error) => {
          log.warn('Dev-env k8s: watch reconcile failed; retrying', { namespace: this.name, error: String(error) });
          this.onWatchDrop();
        },
      );
    }, this.#watchBackoffMs);
    timer.unref?.();
    this.#watchBackoffMs = Math.min(this.#watchBackoffMs * 2, WATCH_BACKOFF_MAX_MS);
  }

  private settle(): void {
    this.clearBootTimer();
    this.#watch?.kill();
    this.#watch = null;
  }

  private clearBootTimer(): void {
    if (this.#bootTimer) clearTimeout(this.#bootTimer);
    this.#bootTimer = null;
  }

  /**
   * Write the exported kubeconfig to the materials dir and return its path —
   * material BY REFERENCE, never by value (the conformance suite polices the
   * seam for secret-shaped strings). Re-minted whenever the file is missing:
   * deploys that rsync the install tree away must not cost an instance.
   */
  private mintKubeconfig(): string | null {
    const dir = materialsPath(this.#ctx.materialsDir, this.#materialsScope, this.key.instanceId);
    const file = path.join(dir, 'kubeconfig');
    if (fs.existsSync(file)) return file;
    // Bounded like every other read on a callback-driven path: status() runs
    // from the watch-drop reconcile, where a hung exec stalls supervision.
    const config = this.#kube.getSecretData(this.name, VCLUSTER_KUBECONFIG_SECRET, 'config', {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (config === null) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, config, { mode: 0o600 });
    return file;
  }

  /** This instance's own directory, and the driver's way into its child. Nothing shared with the owner's other envs. */
  private removeMaterials(): void {
    fs.rmSync(materialsPath(this.#ctx.materialsDir, this.#materialsScope, this.key.instanceId), {
      recursive: true,
      force: true,
    });
    this.#driver.forgetChild(this.name);
  }
}

// ---------- helpers ----------

/**
 * The Deployments whose Available condition IS this stamp's readiness — the
 * ONE readiness definition, in data. `app` keeps its converge-then-probe gate
 * on the stampId-named Deployment; `childManifests` gates on the Deployment
 * its declaration names (present by construction — see the constructor's
 * refusal). Every readiness path (pool fill, claim heal, adoption, the
 * handle's status) reads this list through `stampReady`, so "warm" and
 * "ready" cannot answer differently.
 */
function readinessDeployments(stampId: string, config: K8sStampConfig | undefined): StampReadiness[] {
  const gates: StampReadiness[] = [];
  if (config?.app) gates.push({ deployment: stampId, namespace: APP_STAMP_NAMESPACE });
  // Present by construction for the childManifests shape (the constructor's
  // refusal), and PLURAL where the stamp realizes more than one component:
  // "ready" is every declared Deployment Available, so a whole-deployment
  // stamp goes warm only once its governance answers and its gateway enforces.
  if (config?.childManifests) gates.push(...readinessGates(config));
  return gates;
}

/**
 * The armed-but-unanswered rejection (C16): the claim says dev (cluster
 * state), the stamp's current config no longer does — updated to drop the
 * block, or retired outright, mid-boot. One phrasing for every path that can
 * observe it, so the operator reads one cause however the probe got there.
 */
function devClaimUnanswered(stampId: string): string {
  return (
    `this claim is dev-armed but stamp '${stampId}' no longer declares a dev block — ` +
    `updated or retired mid-boot; the claimed flavor cannot be realized`
  );
}

function nsFailed(ns: KubeObject): boolean {
  return ns.metadata?.annotations?.[STATE_ANNOTATION] === 'failed';
}

/**
 * The two labels a POOL MEMBER wears: claimable now, or booting toward it.
 * Anything else carrying a pool label is provenance (a claimed env) or residue
 * (a fill whose slot label was dropped when it died).
 */
function isSlot(slot: string | undefined): slot is 'warm' | 'filling' {
  return slot === 'warm' || slot === 'filling';
}

function isWarmSlot(ns: KubeObject): boolean {
  return ns.metadata?.labels?.[SLOT_LABEL] === 'warm';
}

function emptyObservation(): PoolObservation {
  return { warm: 0, filling: 0, draining: 0, failed: 0 };
}

/**
 * Has this instance ever been ready? Persisted on the runtime rather than held
 * in a handle, because the question outlives every handle: a restarted host
 * rediscovering a live env must not treat it as a boot in progress.
 */
function nsEverReady(ns: KubeObject): boolean {
  return ns.metadata?.annotations?.[STATE_ANNOTATION] === 'ready';
}

function failureFromAnnotations(ns: KubeObject): DevEnvFailure {
  const kind = ns.metadata?.annotations?.[FAILURE_ANNOTATION];
  if (kind === 'instance-died') return { kind: 'instance-died', retryable: false };
  return { kind: 'instantiation-failed', retryable: false, detail: 'recorded on instance' };
}

/**
 * The claim's materials scope, slugged into something both a label value and a
 * path segment can hold. The driver reads the field for exactly this and
 * nothing else — who an owner IS stays above the seam.
 */
function claimScope(spec: DriverClaimSpec): string {
  return materialsScopeSlug(spec.materialsScope ?? UNSCOPED_MATERIALS);
}

/** Everything beyond the canonical four rides along on the flip. */
function extraLabels(labels: Record<string, string>): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (
      k !== DEV_ENV_LABELS.install &&
      k !== DEV_ENV_LABELS.env &&
      k !== DEV_ENV_LABELS.instance &&
      k !== DEV_ENV_LABELS.stamp
    ) {
      extra[k] = v;
    }
  }
  return extra;
}

function optionAnnotations(options: Record<string, string>): Record<string, string> {
  const annotations: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) annotations[`${OPTION_PREFIX}${k}`] = v;
  return annotations;
}

function validateClaimSpec(spec: DriverClaimSpec): void {
  for (const [k, v] of Object.entries(spec.labels)) {
    if (!LABEL_VALUE_RE.test(v)) {
      // Labels are the adoption contract — a value that cannot round-trip
      // through the k8s label grammar must be refused, never mangled.
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `label ${k} not k8s-legal`,
      });
    }
  }
  for (const k of Object.keys(spec.options)) {
    if (!OPTION_KEY_RE.test(k)) {
      throw asDevEnvFailureError({
        kind: 'instantiation-failed',
        retryable: false,
        detail: `option key not annotation-legal: ${k}`,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
