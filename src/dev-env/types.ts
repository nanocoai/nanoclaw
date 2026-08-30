/**
 * Dev-env driver seam — shared contract types (sandbox-spec D10–D12, D18–D19, D21).
 *
 * Two halves, deliberately asymmetric:
 *
 * - The HOST owns environment identity and lifetime: the durable env registry
 *   holds who claimed what, under which lifetime mode, and which instance
 *   currently realizes it. An environment outlives its instances (D21) — the
 *   registry is where that split lives.
 * - A DRIVER realizes instances from stamps and owns isolation and speed
 *   strategy (D11). Pooling is driver-private: "seconds" is a property of the
 *   k8s driver's warm pool, not of this contract (D5), so nothing here names a
 *   pool. The pool's own vocabulary — desired sizes down, observed state up —
 *   lives beside the registry in `stamp-registry.ts` (`StampSource.poolSizes`,
 *   `PoolObserver`), off this contract on purpose. Lifetimes never cross this
 *   seam either — a driver that knew about `bound` would be coupling itself to
 *   host concerns it cannot see.
 *
 * Claims may complete asynchronously (D18): `claim` returns a handle that can
 * still be `provisioning`; readiness is relayed by the host (claim-notify.ts
 * pushes it into the claiming session). Release is full teardown — a stamp's
 * teardown IS deleting the instance's scope (D10), which is what keeps
 * instances disposable.
 */
import { LABELS } from '../drivers/types.js';

export interface EnvKey {
  /** Durable environment identity — survives instance succession (D21). */
  envId: string;
  /** One realization of the env. Dies by release; never re-converged. */
  instanceId: string;
}

/**
 * Lifetime as recorded on the env (D12). The registry owns every consequence:
 * TTL reaping, bound-owner release, pinned survival across host restarts.
 * `bound` deliberately carries no data — the owner ref lives on the env record
 * itself, because ttl and pinned envs have owners too.
 */
export type EnvLifetime = { mode: 'bound' } | { mode: 'ttl'; expiresAtMs: number } | { mode: 'pinned' };

/** Lifetime as requested at claim time; the registry resolves ttlMs to a deadline. */
export type ClaimLifetime = { mode: 'bound' } | { mode: 'ttl'; ttlMs: number } | { mode: 'pinned' };

/**
 * What the host hands a driver. Fully resolved, same rule as the session seam:
 * if a driver needs to figure something out, the spec is underspecified.
 *
 * `stampId` names a project's deployable definition (the D10 contract); how a
 * driver resolves it — Helm chart, generic app stamp, recipe release — is the
 * driver's configuration, not the seam's. `options` are opaque driver hints
 * (the k8s driver keys its pools on the shape-changing ones); no claim carries
 * a code ref — the agent brings the code under test in (D18).
 */
export interface DriverClaimSpec {
  key: EnvKey;
  stampId: string;
  /** Stamped onto every runtime object; a handle must be rebuildable from these alone. */
  labels: Record<string, string>;
  options: Record<string, string>;
  /**
   * OPAQUE grouping key for whatever access material this claim's driver mints.
   * The host passes the owning ref; a driver may use it ONLY to lay out its
   * materials, never to decide anything — who an owner is, and what may reach
   * an owner's files, stays above the seam. Drivers that mint nothing (the
   * mock) ignore it. The claimant fields below are the SANCTIONED decision
   * inputs; this one stays decision-free.
   *
   * It exists because material is passed BY REFERENCE: a path handed out to one
   * owner is only safely mountable into that owner's sandbox if it lives under
   * a directory nobody else's does.
   */
  materialsScope?: string;
  /**
   * WHO is claiming — the sanctioned decision input for per-claim
   * reachability (D19). Unlike `materialsScope`, a driver MAY decide from it,
   * and the two realized drivers decide differently from the same value: the
   * k8s driver authors a NetworkPolicy keyed on this selector, the docker
   * driver attaches exactly the containers wearing it to the claimed env's
   * network. The value is the session seam's install/group/role labels, which
   * BOTH session drivers stamp — GROUP-granular, never the session label, so
   * reachability survives a session respawn.
   *
   * Present on every service-issued claim: an owner always exists, and which
   * runtime realizes that owner's sessions is not this field's business. It
   * still fails closed — a host claim wears `HOST_OWNER_REF`, a group id the
   * registry refuses to create, so its selector matches no workload anywhere
   * and the reachability a driver authors from it admits nobody.
   */
  claimantSelector?: Record<string, string>;
  /**
   * WHERE those workloads run, for a runtime whose selectors are scoped.
   * Kubernetes has namespaces and a NetworkPolicy must live in one; docker's
   * daemon is flat and a `network connect` names no scope at all. Absent =
   * this host's sessions are not scope-realized, and a driver that NEEDS a
   * scope authors nothing rather than guessing one — the fail-closed
   * direction. Never travels without `claimantSelector`.
   */
  claimantNamespace?: string;
}

export type DevEnvFailure =
  | { kind: 'stamp-unknown'; retryable: false; detail: string }
  | { kind: 'denied-by-policy'; retryable: false; detail: string }
  | { kind: 'capacity-exhausted'; retryable: true }
  | { kind: 'driver-unavailable'; retryable: true }
  /**
   * Realization did not finish. `retryable` is the honest split inside one
   * kind: a namespace collision or a syncer that never exported its kubeconfig
   * will fail again identically (false), while a stamp whose app did not
   * finish rolling out inside the boot budget is a deadline, not a verdict
   * (true) — the same condition a pool fill simply retries.
   */
  | { kind: 'instantiation-failed'; retryable: boolean; detail?: string }
  | { kind: 'instance-died'; retryable: false }
  | { kind: 'unknown'; retryable: false; opaqueRef: string };

/**
 * `ready.endpoints` are named, non-secret addresses (URL, host:port). `access`
 * passes material BY REFERENCE — host paths the agent can read (a child-scoped
 * kubeconfig, an ssh key the driver minted) — never credential values. The
 * conformance suite asserts the absence of secret-shaped values on both, the
 * same measure the session seam applies to container env.
 */
export type InstanceStatus =
  | { phase: 'provisioning' }
  | { phase: 'ready'; endpoints: Record<string, string>; access: Record<string, string> }
  | { phase: 'released' }
  | { phase: 'failed'; failure: DevEnvFailure };

export interface DevEnvInstanceHandle {
  readonly key: EnvKey;
  readonly stampId: string;
  /** Stable runtime name for logs and operator commands. */
  readonly name: string;
  status(): Promise<InstanceStatus>;
  /**
   * Full teardown of everything this instance allocated (D10: teardown = delete
   * the scope). Idempotent; releasing a released instance is a no-op, because
   * the reaper and an agent's explicit release will race and both must win.
   */
  release(reason: string): Promise<void>;
  /**
   * Fires at most once, on the provisioning → ready transition (D18's async
   * path). A handle that is already ready when obtained never fires it —
   * callers check `status()` first, then subscribe.
   */
  onReady(cb: () => void): void;
  /** Fires at most once, on any end the host did not request via release(). */
  onTerminal(cb: (failure?: DevEnvFailure) => void): void;
  /**
   * ADOPTION ONLY: name the owner whose material this instance's access
   * belongs under (see `DriverClaimSpec.materialsScope`, which carries the
   * same value on the claim path). A rediscovered handle is rebuilt from
   * runtime labels alone and an instance realized before its driver laid
   * material out per owner carries none, so the host — which has never
   * forgotten who owns what — says it once, before anything is minted.
   *
   * Optional: only a driver that hands out material by path has anywhere to
   * put it, and calling it must never be required for correctness of anything
   * else.
   */
  setMaterialsScope?(scope: string): void;
  /**
   * OPTIONAL (C14): resolve one exposure's target inside this instance. Two
   * jobs, one call, because they are the same question asked at two times:
   *
   * - at GRANT, with the port alone, it finds the ONE service in this
   *   instance serving that port and returns its name to freeze into the row
   *   — and THROWS when two qualify, because ambiguity is a grant-time
   *   question a human answers with `--service`, never a dial-time port scan.
   * - PER CONNECTION, with the frozen name, it returns the address to dial
   *   NOW. Names are unique per instance, so this can never see ambiguity;
   *   what it can see is a MISS — renamed away, deleted, the port no longer
   *   served — and a miss answers NULL, which every provider must treat as a
   *   refused connection. Fail closed; never dial a memory.
   *
   * A driver that does not implement it simply has no exposures: the grant
   * refuses at create, naming the driver, rather than minting a URL nothing
   * could ever carry.
   */
  resolveExposureTarget?(request: { service?: string; port: number }): Promise<ExposureTargetResolution | null>;
}

/**
 * Where one exposure's traffic goes RIGHT NOW (C14). `service` is the target's
 * frozen identity — resolved once at grant and echoed back verbatim on every
 * later call; `address` is the answer that must never be written down.
 */
export interface ExposureTargetResolution {
  service: string;
  address: string;
  port: number;
}

export interface DevEnvDriverCapabilities {
  /**
   * What separates one instance from another: 'vcluster', 'namespace',
   * 'container', 'vm', 'process'... Diagnostic honesty for logs and operator
   * eyes — never a branch. Deliberately a string: out-of-tree drivers bring
   * isolations this file must not have to enumerate.
   */
  isolation: string;
  /**
   * Whether claimed instances start egress-sealed (D19: children default to no
   * egress; the agent may delegate policies it holds). A statement about THIS
   * realization, never a prediction about which runtimes can seal: the k8s
   * driver seals with default-deny NetworkPolicies, the docker driver with
   * `--internal` networks (no NAT, no route, no DNS carve-out — a coarser
   * seal, and a total one), and a driver that allocates nothing to seal
   * declares false. Anything that manages child egress gates on this, never
   * on `kind`.
   */
  sealedEgress: boolean;
  /**
   * The two placement capabilities (C15) — two flags, not one, because almost
   * every driver can PULL (getting an image into the store its claims resolve
   * from is close to the definition of having a store) and far fewer can
   * BUILD. A stamp whose origin the driver cannot realize is refused at
   * CREATE with the capability named — the author learns in seconds, the
   * approver never sees an unrealizable stamp, and no claim ever discovers it
   * as a timeout. Same gating discipline as the session contract's
   * `imageBuild`, deliberately the same name.
   */
  imagePull: boolean;
  imageBuild: boolean;
}

/**
 * What the host hands a driver's `placeImage` (C15). Fully resolved, same
 * rule as `claim`: if a driver needs to figure something out, the spec is
 * underspecified. `ref` is the derived non-resolvable ref (placeRef); the
 * origin carries exactly what approval signed — the digest for a pull (a
 * build arm joins this union when a driver realizes builds). `credential`
 * NAMES a custody credential; no value ever crosses the seam.
 */
export interface DriverPlaceSpec {
  stampId: string;
  version: number;
  ref: string;
  /** Stamped onto every placement runtime object, so reapResidue covers orphans. */
  labels: Record<string, string>;
  origin: { kind: 'pull'; digest: string; sourceRef: string; credential?: string };
}

export interface DevEnvDriver {
  /** Identity for logs and diagnostics only — never a branch. Not a union, same reasoning as the session seam. */
  readonly kind: string;
  capabilities(): DevEnvDriverCapabilities;
  /** Fatal-at-startup reachability check, for drivers with a runtime to reach. */
  ensureReady?(): Promise<void>;
  /**
   * Stop background work — the sanctioned counterpart to `ensureReady`, called
   * once from host shutdown, after which nothing this driver started may fire.
   * Optional: a driver whose realization is entirely request-scoped has
   * nothing to stop. It exists because the alternative is a subscription
   * process — a pod watch, a `docker events` stream — outliving the host that
   * started it, which leaks a child per restart and hangs a test runner that
   * is waiting for the event loop to drain.
   */
  dispose?(): void;
  /**
   * Realize an instance. Idempotent on key: an existing live instance for this
   * key returns its handle rather than a duplicate. May return a
   * still-provisioning handle (D18); must throw a `DevEnvFailureError` for
   * anything that will never become ready.
   */
  claim(spec: DriverClaimSpec): Promise<DevEnvInstanceHandle>;
  /**
   * Converge a surviving in-flight claim after a host restart — the resume
   * half of adoption. Everything `claim` would heal on a replay of this key
   * (steps the dying host never reached; all idempotent), MINUS everything
   * that could allocate a fresh instance: an instance the runtime no longer
   * holds is the registry's fact to settle, and this call answers it by doing
   * nothing. The host calls it for `claiming` rows whose instance discovery
   * still sees, before attaching the rediscovered handle; readiness then
   * arrives through that handle's normal probe path.
   *
   * Optional: a driver whose claim allocates nothing outside the instance
   * itself has nothing to converge.
   */
  resumeClaim?(spec: DriverClaimSpec): Promise<void>;
  /**
   * Discovery for adoption and reaping. Handles are reconstructed from
   * runtime-visible labels only — if the registry knows an env the runtime has
   * no instance for, the instance died with the host down, and the registry
   * (not the driver) decides what that means.
   */
  listInstances(installScope: string): Promise<DevEnvInstanceHandle[]>;
  /** Residue a released instance could not clean up itself. */
  reapResidue?(installScope: string): Promise<void>;
  /**
   * The C15 placement verb — one verb for both origins, because the
   * postcondition is identical: the image is in the store this driver's
   * claims resolve from, under `spec.ref`, and `storeId` is what landed
   * (recorded verbatim as the row's digest). May take minutes; the CALLER
   * (the placement reconciler) owns the hard timeout. Optional exactly like
   * the capability that advertises it: a driver declaring `imagePull` must
   * implement it, and the reconciler records the mismatch as a failed
   * placement rather than trusting the flag.
   */
  placeImage?(spec: DriverPlaceSpec): Promise<{ storeId: string }>;
  /**
   * Is `ref` still present in the store this driver's claims resolve from?
   * The re-probe's leg: `placed` is a database claim about a store whose
   * eviction policy the platform does not own (kubelet image GC), and left
   * unverified the claim gate opens onto the boot timeout it exists to kill.
   * Optional: a driver without a cheap, truthful answer declines rather than
   * guessing — a false "absent" would close the claim gate over a live image.
   */
  probeImage?(ref: string): Promise<boolean>;
  /**
   * The same question for a SET, answered in one read: which of these refs the
   * store does NOT hold. It exists because a stamp that realizes a whole
   * deployment asserts seven or eight node-local images (`nodeImages`), and
   * the claim gate answers before every claim — per-ref probing would put that
   * many round trips on the claim path. Optional on the same terms as
   * `probeImage`, and a driver that declines leaves the assertion ungated
   * rather than guessing.
   */
  missingNodeImages?(refs: string[]): Promise<string[]>;
}

/**
 * Canonical label keys — the adoption contract. A handle must be rebuildable
 * from these alone. Values obey the k8s label-value grammar (the strictest
 * surface any driver realizes labels onto — see `labelValueLegal` in the
 * session seam, whose bound this seam shares).
 */
export const DEV_ENV_LABELS = {
  install: 'nanoclaw-dev-install',
  env: 'nanoclaw-dev-env',
  instance: 'nanoclaw-dev-instance',
  stamp: 'nanoclaw-dev-stamp',
} as const;

export function devEnvLabels(
  installScope: string,
  key: EnvKey,
  stampId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [DEV_ENV_LABELS.install]: installScope,
    [DEV_ENV_LABELS.env]: key.envId,
    [DEV_ENV_LABELS.instance]: key.instanceId,
    [DEV_ENV_LABELS.stamp]: stampId,
    ...extra,
  };
}

/**
 * The ownerRef host-CLI claims wear (`ownerFor` in the envs resource). It maps
 * through `claimantGroupSelector` verbatim like any group id, so its selector
 * matches workloads labeled `nanoclaw-group: operator` — which must be NONE,
 * or a group wearing the name would inherit reach to every host-claimed
 * child. Every in-tree creation path mints random group ids, but that is a
 * convention; `createAgentGroup` is where the name is actually REFUSED, which
 * is what turns "selects nothing" from naming luck into an invariant (found
 * in D19 review: nothing reserved the sentinel).
 */
export const HOST_OWNER_REF = 'operator';

/**
 * The GROUP-granular selector for `DriverClaimSpec.claimantSelector`, derived
 * from the labels the session drivers stamp on every agent workload
 * (`labelsForKey` in the session seam — the pod driver and the docker driver
 * stamp the same three). Deliberately install + group + role and NEVER the
 * session label: reachability pinned to one session dies with its workload,
 * and the whole point of selecting labels over addresses is that the
 * respawned one wears the same three.
 */
export function claimantGroupSelector(installScope: string, ownerRef: string): Record<string, string> {
  return {
    [LABELS.install]: installScope,
    [LABELS.group]: ownerRef,
    [LABELS.role]: 'agent',
  };
}

// ---------- failure constructors, shared by all drivers ----------

export type DevEnvFailureError = Error & DevEnvFailure;

export function stampUnknown(detail: string): DevEnvFailureError {
  return Object.assign(new Error(`stamp-unknown: ${detail}`), {
    kind: 'stamp-unknown' as const,
    retryable: false as const,
    detail,
  });
}

export function envDeniedByPolicy(detail: string): DevEnvFailureError {
  return Object.assign(new Error(`denied-by-policy: ${detail}`), {
    kind: 'denied-by-policy' as const,
    retryable: false as const,
    detail,
  });
}

export function asDevEnvFailureError(failure: DevEnvFailure): DevEnvFailureError {
  return Object.assign(new Error(`env realization failed: ${failure.kind}`), failure);
}

/**
 * The human-readable half of a failure, wherever the taxonomy carries one —
 * ONE extraction shared by every recorder (the env row, the host log), so a
 * kind that grows a detail field cannot be recorded with it in one place and
 * without it in another. `unknown` yields its opaqueRef: that string IS the
 * only cause anyone captured.
 */
export function devEnvFailureDetail(failure: DevEnvFailure): string | null {
  if (failure.kind === 'unknown') return failure.opaqueRef;
  return 'detail' in failure ? (failure.detail ?? null) : null;
}

export function isDevEnvFailure(error: unknown): error is DevEnvFailureError {
  return error instanceof Error && 'kind' in error && 'retryable' in error;
}
