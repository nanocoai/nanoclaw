/**
 * The `nanoclaw` builtin stamp — a complete nanoclaw deployment rendered for
 * the INSIDE of an instance's child cluster: the host runs as a pod from a
 * source-carrying image, seeds a PVC with its baked tree on first boot, and
 * spawns session pods via the pod driver in PVC volume mode.
 *
 * ONE namespace holds host, sessions and the tree PVC together. PVCs are
 * namespace-scoped and cross-namespace mounts do not exist, so a
 * system/agents split cannot put the host's tree under a session pod — the
 * split does not translate, and pretending otherwise would render manifests
 * that can never mount.
 *
 * Every pod here must clear PodSecurity `baseline` on the parent node (the
 * instance namespace enforces it on synced pods): no hostPath, no privileged,
 * no hostNetwork. The tree rides a PVC instead — baseline-legal, provisioned
 * by the child's own default StorageClass — and `fsGroup` applies to it,
 * which hostPath never honored.
 *
 * Rendered as a JSON document stream (JSON is YAML) for the same reason
 * stamps.ts renders that way: hand-rolled YAML quoting is where arbitrary
 * text becomes a manifest injection, and the stream shape is what
 * `Kube.apply` already takes. Everything here is literal and checked in;
 * applying it is idempotent by construction — every name is fixed, so
 * re-applying converges instead of accumulating.
 */
import {
  DEV_TREE_GID_TOKEN,
  DEV_TREE_PVC,
  DEV_TREE_UID_TOKEN,
  substituteDevTreeIdentity,
  type DevTreeIdentity,
} from './dev-tree.js';

/** ONE namespace for host + sessions + PVC — see the header. */
export const NANOCLAW_NAMESPACE = 'nanoclaw';
export const NANOCLAW_HOST_DEPLOYMENT = 'nanoclaw-host';
export const NANOCLAW_TREE_PVC = 'nanoclaw-tree';
/**
 * Source-carrying, imported node-locally (the vcluster syncer rewrites no
 * image refs, so child pods resolve against node containerd). Versioned tag,
 * never `:latest` — IfNotPresent over a floating tag is how a node quietly
 * runs last month's build.
 */
export const NANOCLAW_CHILD_HOST_IMAGE = 'nanoclaw-child-host:v05';
/** The runtime tree (PVC mount): cwd of the host process; INSTALL_SLUG derives from it. */
export const NANOCLAW_TREE_PATH = '/nanoclaw/host';

// ---------------------------------------------------------------------------
// The DEV flavor — the hot-loop variant of the same bundle.
//
// A dev-flavor claim runs the child host FROM THE CLAIMING SANDBOX'S WORKING
// TREE instead of the baked seed: the child mounts the platform-authored
// `dev-tree` claim (dev-tree.ts — the driver creates the PVC and pre-binds a
// static parent-side PersistentVolume whose `local.path` is the node path of
// that working tree). Everything else — one namespace, the five-verb grant,
// Recreate, the socket readiness gate — is deliberately identical, so a dev
// child differs from a baked one in exactly one dimension: where its tree
// comes from. Since C16 the flavor rides the GENERALIZED dev declaration:
// this render is the builtin's code-provided `dev.manifests`, carrying the
// identity tokens like any registered dev stream would, first consumer of
// the seam it proved.
// ---------------------------------------------------------------------------

/**
 * The dev flavor's image. v06 adds exactly one behavior to v05: an
 * NANOCLAW_DEV_TREE=1 branch in the entrypoint that REFUSES to seed the
 * baked tree over the mount (the seed tar would clobber the developer's
 * working tree). The baked flavor stays on v05 until the operator imports
 * v06 node-side — and a dev claim BEFORE that import has no fast failure:
 * IfNotPresent against a missing node image is just ImagePullBackOff, which
 * the stamp gate only ever sees as a Deployment that never goes Available,
 * so the claim polls out its whole boot budget (~10 min) and dies as a
 * generic boot timeout — the same mute failure mode ISSUES records for a
 * missing v05. That is why the runbook sequences the v06 import (§3)
 * strictly before the first dev claim (§4); an image-pull fast-fail in
 * stampReady would be the mechanical fix if this edge ever needs closing.
 */
export const NANOCLAW_CHILD_HOST_DEV_IMAGE = 'nanoclaw-child-host:v06';

/**
 * The D10 dev-mode vocabulary: a per-component manifest declaring how a
 * change goes live in a running instance. Transport is the EXECUTOR'S
 * business, never the manifest's — rsync from a dev machine, an exec stream
 * from a sandbox, node-local import for images. Reload-complete is the
 * stamp's own readiness signal going green again.
 */
export type DevModeReload =
  | { kind: 'restart-unit'; unit: string }
  | { kind: 'self-watch' }
  | { kind: 'rollout'; namespace: string; deployment: string };

export interface DevModeComponentManifest {
  artifact: 'tree' | 'image' | 'file';
  /** Executor-run step before reload (compose on the dev side, build in-instance). */
  prepare?: 'build' | 'compose';
  dest: string;
  exclude: readonly string[];
  reload: DevModeReload;
}

/**
 * How a source change reaches a running `nanoclaw` instance (D8 pulled
 * forward as the agent-side sync tool). `node_modules` never transfers: deps
 * are baked into the image and the child cannot npm-install behind
 * default-deny egress. `data`/`groups` are the instance's own live state,
 * `dist` is rebuilt in-instance (`prepare: build`), and `.env` does not exist
 * in a child — all config arrives as pod env.
 */
export const NANOCLAW_DEV_MODE_MANIFEST: Readonly<Record<string, DevModeComponentManifest>> = {
  host: {
    artifact: 'tree',
    prepare: 'build',
    dest: NANOCLAW_TREE_PATH,
    exclude: ['node_modules', '.git', 'data', 'groups', 'dist', '.env'],
    reload: { kind: 'rollout', namespace: NANOCLAW_NAMESPACE, deployment: NANOCLAW_HOST_DEPLOYMENT },
  },
};

/**
 * The DEV flavor's manifest: same vocabulary, degenerate transport. The
 * working tree IS the mounted volume, so nothing transfers and nothing is
 * excluded — `prepare: build` moves to the SANDBOX side (dist/ appears in the
 * child through the mount), and reload stays the same Recreate rollout gated
 * on the same socket probe. deps note: the mounted tree must carry its own
 * node_modules (same node, same arch as the sandbox that installed them) —
 * the baked image's deps live under /opt, which the dev flavor never seeds.
 */
export const NANOCLAW_DEV_MODE_MANIFEST_DEV: Readonly<Record<string, DevModeComponentManifest>> = {
  host: {
    artifact: 'tree',
    prepare: 'build',
    dest: NANOCLAW_TREE_PATH,
    exclude: [],
    reload: { kind: 'rollout', namespace: NANOCLAW_NAMESPACE, deployment: NANOCLAW_HOST_DEPLOYMENT },
  },
};

/** What varies between the baked bundle and its dev flavor — nothing else may. */
interface ChildFlavor {
  /**
   * The tree claim the host consumes. `authored` = this stream carries the
   * PVC document itself (the baked flavor); the dev flavor only MOUNTS the
   * platform-authored `dev-tree` claim (dev-tree.ts — PVC authorship is the
   * driver's, per C16's trust split).
   */
  tree: { claimName: string; authored: boolean };
  image: string;
  /** Strings are the C16 identity tokens — the dev flavor's, substituted at render. */
  securityContext: { runAsUser: number | string; runAsGroup: number | string; fsGroup?: number };
  extraEnv: ReadonlyArray<{ name: string; value: string }>;
}

function renderChildManifests(flavor: ChildFlavor): string {
  const labels = { app: NANOCLAW_HOST_DEPLOYMENT };
  const namespace = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: NANOCLAW_NAMESPACE },
  };
  const serviceAccount = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: NANOCLAW_HOST_DEPLOYMENT, namespace: NANOCLAW_NAMESPACE },
  };
  // The session driver's EXACT grant, and nothing else: the pod driver's
  // seven kubectl call sites reduce to five verbs on pods. No pods/log, no
  // pods/exec, no events, no secrets — the derivation lives with the driver;
  // this is its shape.
  const role = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'nanoclaw-session-driver', namespace: NANOCLAW_NAMESPACE },
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch', 'create', 'delete'] }],
  };
  const roleBinding = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: 'nanoclaw-session-driver', namespace: NANOCLAW_NAMESPACE },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'nanoclaw-session-driver' },
    subjects: [{ kind: 'ServiceAccount', name: NANOCLAW_HOST_DEPLOYMENT, namespace: NANOCLAW_NAMESPACE }],
  };
  // Baked flavor only: no storageClassName ON PURPOSE — the child's default
  // class is its own localPathProvisioner, and naming a class would couple
  // the stamp to one child distro's naming. The dev flavor authors NO PVC:
  // its claim is the platform's `dev-tree`, created by the driver with the
  // reserved static class (dev-tree.ts), so the parent's default-class
  // admission cannot intercept the synced claim away from the pre-bound PV.
  // RWO is enough — on a single node the host pod and its session pods share
  // the claim.
  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: flavor.tree.claimName, namespace: NANOCLAW_NAMESPACE },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '10Gi' } },
    },
  };
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: NANOCLAW_HOST_DEPLOYMENT, namespace: NANOCLAW_NAMESPACE, labels },
    spec: {
      // Singleton, doubly forced: one writer per session DB is the host's core
      // invariant, and the ncl socket server unlinks a stale socket before
      // binding — a second replica silently STEALS it. Recreate, never
      // RollingUpdate: a rolling update is a deliberate two-writer window.
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: NANOCLAW_HOST_DEPLOYMENT,
          // The deliberate inversion: session pods must not hold API
          // credentials; the host pod is the ONE pod that does, because
          // driving session pods is its job. Its power is bounded by the
          // five-verb Role above.
          automountServiceAccountToken: true,
          // Baked: uid/gid own the tree the image bakes; fsGroup makes the
          // freshly provisioned PVC writable by them on first boot — the
          // thing hostPath mounts never gave the phase-4 shape. Dev: uid/gid
          // are the MOUNTED TREE'S owner and fsGroup is absent — the kubelet
          // must never recursively chgrp a developer's working tree.
          securityContext: flavor.securityContext,
          containers: [
            {
              name: 'host',
              image: flavor.image,
              // The node has the image or the stamp does not boot; never reach
              // for a registry the child cannot see.
              imagePullPolicy: 'IfNotPresent',
              // ALL config arrives as pod env — no .env writer exists in a
              // child and none is added (D18: instances never hold repo
              // credentials; the mock provider keeps sessions credential-free).
              env: [
                // /tmp is a writable emptyDir; the runAs uid has no passwd
                // entry in the image and an unset HOME resolves to '/'.
                { name: 'HOME', value: '/tmp' },
                { name: 'NANOCLAW_RUNTIME_DRIVER', value: 'pod' },
                { name: 'NANOCLAW_POD_NAMESPACE', value: NANOCLAW_NAMESPACE },
                { name: 'NANOCLAW_SESSION_EGRESS', value: 'none' },
                // PVC volume mode: session mounts under the tree ride the
                // claim as subPaths instead of hostPath — what keeps every
                // session pod PSA-baseline-legal on the parent node. The dev
                // flavor names ITS claim here, so session pods keep working
                // unchanged against the mounted tree (the one-claim rule).
                { name: 'NANOCLAW_POD_VOLUME_PVC', value: flavor.tree.claimName },
                { name: 'NANOCLAW_POD_VOLUME_ROOT', value: NANOCLAW_TREE_PATH },
                { name: 'CONTAINER_IMAGE', value: 'nanoclaw-agent:spike-p0' },
                { name: 'DEFAULT_AGENT_PROVIDER', value: 'mock' },
                ...flavor.extraEnv,
              ],
              // The ncl socket server is the LAST boot step, so socket-exists
              // == fully booted — but ONLY for a socket this container
              // created. The file lives on the PVC and survives every
              // container restart, while the host unlinks a stale one at bind
              // time, its last step: unless the image ENTRYPOINT removes
              // data/ncl.sock before starting the host, every restart reads
              // Ready off the dead process's file for the whole reboot. The
              // child-host image owes that unlink; this manifest cannot
              // express it. Generous budget: a first boot seeds the PVC from
              // the baked tree and initializes the agent DB before the host
              // process even starts.
              readinessProbe: {
                exec: { command: ['test', '-S', `${NANOCLAW_TREE_PATH}/data/ncl.sock`] },
                periodSeconds: 5,
                failureThreshold: 60,
              },
              // Declared explicitly: the child's LimitRange default (512Mi)
              // is too small for the host and would apply silently.
              resources: {
                requests: { cpu: '200m', memory: '256Mi' },
                limits: { cpu: '1', memory: '1536Mi' },
              },
              volumeMounts: [
                { name: 'tree', mountPath: NANOCLAW_TREE_PATH },
                { name: 'home', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'tree', persistentVolumeClaim: { claimName: flavor.tree.claimName } },
            { name: 'home', emptyDir: {} },
          ],
        },
      },
    },
  };
  return [namespace, serviceAccount, role, roleBinding, ...(flavor.tree.authored ? [pvc] : []), deployment]
    .map((doc) => JSON.stringify(doc, null, 2))
    .join('\n---\n');
}

export const NANOCLAW_CHILD_MANIFESTS = renderChildManifests({
  tree: { claimName: NANOCLAW_TREE_PVC, authored: true },
  image: NANOCLAW_CHILD_HOST_IMAGE,
  securityContext: { runAsUser: 501, runAsGroup: 1000, fsGroup: 1000 },
  extraEnv: [],
});

/**
 * The dev-flavor bundle as the builtin's DECLARED `dev.manifests` (C16): the
 * identity tokens ride verbatim where the pod spec runs as the tree owner,
 * and the driver's generic substitution resolves them per claim off the
 * stat'd tree — the same path any registered dev stream takes. Same shape,
 * same names, same readiness gate as the baked bundle; the PVC document is
 * absent because the tree claim is platform-authored.
 */
export const NANOCLAW_DEV_CHILD_MANIFESTS = renderChildManifests({
  tree: { claimName: DEV_TREE_PVC, authored: false },
  image: NANOCLAW_CHILD_HOST_DEV_IMAGE,
  securityContext: { runAsUser: DEV_TREE_UID_TOKEN, runAsGroup: DEV_TREE_GID_TOKEN },
  extraEnv: [{ name: 'NANOCLAW_DEV_TREE', value: '1' }],
});

/**
 * The dev-flavor bundle with the tree owner's identity resolved — the exact
 * stream the driver applies for a claim whose stat said `identity`. One
 * implementation on purpose: this IS the generic substitution over the
 * declared stream, so what the tests render and what a claim realizes cannot
 * drift apart.
 */
export function renderDevChildManifests(identity: DevTreeIdentity): string {
  return substituteDevTreeIdentity(NANOCLAW_DEV_CHILD_MANIFESTS, identity);
}
