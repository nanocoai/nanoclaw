/**
 * The platform's dev-tree vocabulary (C16) — the hot-loop flavor any stamp
 * can opt into.
 *
 * A dev-flavor claim runs a stamp's consuming workload FROM THE CLAIMING
 * SANDBOX'S WORKING TREE instead of its baked artifact. The machinery is the
 * proven nanoclaw-private one, parameterized: the claimant's tree becomes a
 * static parent-side PV pre-bound to a child-side claim, and the stamp's DEV
 * VARIANT mounts that claim. What lives here is exactly the platform's half
 * of the contract:
 *
 * - THE TREE CLAIM IS PLATFORM-AUTHORED, ALWAYS. The child-side PVC is the
 *   driver's to create (`renderDevTreePvc`), named by the platform constant,
 *   classed with the reserved class no provisioner owns. An author's dev
 *   variant only MOUNTS `dev-tree`; a stream that declares its own is refused
 *   at registration (stamps.ts owns that refusal). This splits trust cleanly —
 *   the approver reviews consumption; provisioning is platform clamp — and it
 *   makes the syncer-derived parent-side name a pure formula the fidelity
 *   gate can assert.
 * - THE TREE-OWNER IDENTITY IS A CLAMP, NEVER APPROVER VIGILANCE. The
 *   consuming pods run as the OWNER OF THE MOUNTED TREE, stat'd host-side at
 *   render time, with fsGroup absent — the kubelet's recursive ownership
 *   management must never chgrp a developer's working tree at mount. For
 *   driver-rendered app variants that is a rendered securityContext; for
 *   author-supplied manifest streams it is the `${DEV_TREE_UID}` /
 *   `${DEV_TREE_GID}` tokens, REQUIRED at registration (stamps.ts) and
 *   substituted here with stat-derived integers — nothing else ever
 *   substitutes.
 */

/**
 * The reserved claim-option key every driver honours (the hot-loop flavor).
 * Its value is a HOST-ABSOLUTE path to the claiming sandbox's working tree,
 * resolved and containment-checked ABOVE the seam (the envs resource derives
 * it from the caller's own code session — an agent can never name an
 * arbitrary host path); a driver re-asserts only what it can see: absolute,
 * readable, a directory.
 *
 * It lives HERE, with the rest of the C16 vocabulary, and not inside a
 * driver: the surface that MINTS the key is the CLI, which must not import a
 * driver, and a second driver that had to import the first one to learn the
 * key would be inheriting a dependency edge nothing else in the seam has.
 */
export const DEV_TREE_OPTION = 'devTreePath';

/**
 * The child-side name of every dev claim's tree PVC — a platform constant,
 * not the author's: the driver creates it in the consumer's namespace, and
 * the parent-side synced name (`dev-tree-x-<consumer-ns>-x-<vcluster>`)
 * derives from it, which is what makes claimRef pre-binding a formula.
 */
export const DEV_TREE_PVC = 'dev-tree';

/**
 * Pinned on BOTH the child PVC and the parent PV, and deliberately a class no
 * provisioner owns. A class-less child PVC gets the parent's default class
 * stamped by admission after sync (proven live: local-path intercepted it),
 * and an intercepted claim binds a freshly provisioned EMPTY volume — the
 * child would silently run a blank tree. A named non-empty class survives
 * serialization through the syncer (an explicit "" may be dropped as empty
 * and re-defaulted), matches the PV the driver authors, and leaves the
 * local-path provisioner nothing to act on. The VALUE predates the
 * generalization on purpose: it is what live deployments already carry.
 */
export const DEV_TREE_STORAGE_CLASS = 'nanoclaw-dev-static';

/**
 * The identity tokens an authored dev stream carries VERBATIM where its
 * pod templates run as the tree owner. Substituted with stat-derived
 * integers at render — quoted occurrences become JSON numbers, so
 * `"runAsUser": "${DEV_TREE_UID}"` lands as `"runAsUser": 501`.
 */
export const DEV_TREE_UID_TOKEN = '${DEV_TREE_UID}';
export const DEV_TREE_GID_TOKEN = '${DEV_TREE_GID}';

/**
 * Who a dev-flavor consumer runs as: the OWNER OF THE MOUNTED TREE, stat'd
 * host-side at render time. A baked flavor's fixed uid would EACCES on a tree
 * owned by the sandbox uid, and fsGroup is dropped entirely — the kubelet's
 * recursive ownership management must never chgrp a developer's working tree
 * at mount time. Dev children are mock-provider and credential-free (D18),
 * so running as the tree owner concedes nothing.
 */
export interface DevTreeIdentity {
  runAsUser: number;
  runAsGroup: number;
}

/**
 * How an edit goes live in a running dev-flavor instance — the declaration's
 * reload vocabulary, driven SANDBOX-side (the generic dev-reload skill reads
 * it from `stamps get`; the platform never executes a reload):
 *
 * - `rollout` (the default): restart the consuming Deployment, wait
 *   Available, check a different pod answers.
 * - `exec`: a process signal — the command exec'd in the consuming pod
 *   (HUP a config-reloading service, touch a watch file).
 * - `none`: a self-watching process (bun --watch); edits are live on save.
 *
 * Reload-complete is the stamp's own readiness going green again — the
 * proven definition, whatever the kind.
 */
export type StampDevReload = { kind: 'rollout' } | { kind: 'exec'; command: string[] } | { kind: 'none' };

/**
 * The dev block of an APP-shape stamp: the driver already renders its
 * manifests, so it renders the dev variant too — same Deployment/Service,
 * plus the platform's tree claim mounted at `mountPath`, with
 * `command`/`image`/`env` overridden where declared (run from the tree
 * instead of the baked artifact). The tree-owner securityContext is
 * driver-rendered — never the author's to write. A dev image obeys the image
 * clamp everything else does: node-local, IfNotPresent, never a pull at
 * claim.
 */
export interface StampDevApp {
  /** Where the working tree mounts inside the consuming container. Absolute; refused otherwise. */
  mountPath: string;
  command?: string[];
  image?: string;
  env?: Record<string, string>;
  reload?: StampDevReload;
}

/**
 * WHICH declared readiness gate consumes the tree — a `{deployment, namespace}`
 * pair, structurally the same shape as `StampReadiness` (it is deliberately
 * spelled here rather than imported, because `stamps.ts` imports THIS module
 * and the edge must not run both ways).
 *
 * It exists because "one tree, one consumer" and "a whole-deployment stamp
 * declares a readiness LIST" are both true at once. The platform must never
 * GUESS which of several gates mounts the tree — the fidelity gate reads its
 * variant evidence off the consuming Deployment, so a guess is a dev claim
 * reporting active over a gate that never mounted anything. Declaring it is
 * how the author answers the question instead of the platform inventing an
 * answer: still one tree and one consumer, now NAMED.
 */
export interface StampDevConsumer {
  deployment: string;
  namespace: string;
}

/**
 * The dev block of a childManifests stamp: the author supplies the dev
 * variant stream, exactly as the nanoclaw builtin's code-provided render is
 * that stream. It only MOUNTS `dev-tree` (the platform authors the claim),
 * and every mounting pod template carries the identity tokens verbatim —
 * both are create-time refusals (stamps.ts). Readiness stays the stamp's own
 * declaration: both flavors gate on the same Deployment, which is precisely
 * why the fidelity gate exists.
 *
 * `consumer` names that Deployment when the stamp declares more than one
 * readiness gate. Optional for a single-gate stamp (the one gate IS the
 * consumer, and nothing is being guessed); REQUIRED past that, and refused
 * whenever it names a pair the readiness list does not.
 */
export interface StampDevManifests {
  manifests: string;
  consumer?: StampDevConsumer;
  reload?: StampDevReload;
}

export type StampDevSpec = StampDevApp | StampDevManifests;

/** The two shapes share one discriminator: only the childManifests variant carries a stream. */
export function isDevManifests(dev: StampDevSpec): dev is StampDevManifests {
  return 'manifests' in dev;
}

/**
 * Resolve the identity tokens against the stat'd tree owner. Quoted
 * occurrences first, so a JSON-stream token becomes a NUMBER (the pod spec's
 * type), then bare occurrences for token uses inside longer strings.
 */
export function substituteDevTreeIdentity(stream: string, identity: DevTreeIdentity): string {
  return stream
    .replaceAll(`"${DEV_TREE_UID_TOKEN}"`, String(identity.runAsUser))
    .replaceAll(`"${DEV_TREE_GID_TOKEN}"`, String(identity.runAsGroup))
    .replaceAll(DEV_TREE_UID_TOKEN, String(identity.runAsUser))
    .replaceAll(DEV_TREE_GID_TOKEN, String(identity.runAsGroup));
}

/**
 * The platform-authored tree claim, rendered for the consumer's namespace.
 * Applied by the driver AFTER the author's dev stream (whose documents may
 * create that namespace), never carried by the stream itself. Same 10Gi RWO
 * shape the proven nanoclaw flavor declared — on a single node the consumer
 * and whatever it spawns share the claim.
 */
export function renderDevTreePvc(namespace: string): string {
  return JSON.stringify(
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: DEV_TREE_PVC, namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: DEV_TREE_STORAGE_CLASS,
        resources: { requests: { storage: '10Gi' } },
      },
    },
    null,
    2,
  );
}
