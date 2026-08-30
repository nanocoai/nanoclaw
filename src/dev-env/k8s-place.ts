/**
 * The k8s placement realization (C15, v1) — pure builders for the placement
 * namespace, its egress posture, and the per-placement Job. The driver owns
 * WHEN these apply; this module owns exactly WHAT they say, so the tests pin
 * objects rather than call sequences (the claim-route pattern).
 *
 * Stated without varnish, from the brief: the v1 placer mounts the node's
 * containerd socket — node-root-equivalent by design, beyond PSA `baseline`,
 * the single fact that forces the placement namespace's relaxed posture. The
 * exception is namespace-scoped and lives HERE and nowhere else; instance
 * namespaces keep their baseline floor untouched. It is also single-node and
 * containerd-only by construction, which is why the brief names this placer
 * SCAFFOLDING for the single-node POC: the registry-native realization (open
 * question 7 — let kubelet pull a digest-pinned throwaway pod) deletes the
 * placer container whole, and this namespace's standing exception with it.
 *
 * Egress (ruling 1): placement is a pod, so it is netpol-governable — the
 * namespace carries default-deny + DNS, opened ONLY toward the configured
 * gateway proxy. Credentials (ruling 3): NOTHING here carries or mounts a
 * registry credential — private-origin auth is the gateway's custody exactly
 * as it is for sandbox git, which is why the Job spec has no secret mounts to
 * audit. The placer executes nothing agent-authored on the pull origin: a
 * pull parses a manifest stream, the same surface any kubelet pull exercises.
 */
import { PLACE_REF_HOST } from './stamp-images.js';
import { DEV_ENV_LABELS, type DriverPlaceSpec } from './types.js';

/** Driver-private marker for every placement runtime object — what the residue sweep keys on. */
export const PLACEMENT_LABEL = 'nanoclaw-dev-placement';

/** Where the placer sees the node's containerd socket; the hostPath mounts here. */
const SOCKET_MOUNT_PATH = '/run/nanoclaw-place/containerd.sock';
/** Where the gateway CA (when configured) lands for the placer's own registry client. */
const PROXY_CA_MOUNT_PATH = '/run/nanoclaw-place/proxy-ca.pem';

/** k3s's containerd — the POC substrate. An install overrides via the driver knob. */
export const DEFAULT_CONTAINERD_SOCKET = '/run/k3s/containerd/containerd.sock';

const DNS_1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Same conservative ref grammar the stamp vocabulary enforces — refs ride this Job's script. */
const REF_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface PlacementEgress {
  /** The gateway proxy the pull rides (ruling 1) — the ONLY egress the netpol opens beyond DNS. */
  proxyUrl: string;
  /** Node path of the gateway CA, for the placer's own TLS client. Optional: a public CA chain needs none. */
  proxyCaPath?: string;
  /** The placer image — must be node-present (pinned-bundle preplacement); a placer that pulls itself is the failure class IfNotPresent exists to prevent. */
  placerImage: string;
  /** The node's containerd socket. */
  containerdSocket?: string;
}

export function placementNamespaceName(prefix: string): string {
  return `${prefix}-place`;
}

export function placementJobName(stampId: string, version: number): string {
  return `place-${stampId}-v${version}`;
}

function refuse(detail: string): never {
  throw new Error(`placement spec refused: ${detail}`);
}

/**
 * The placement namespace: platform infrastructure, NOT an instance
 * namespace. It carries `privileged` PodSecurity labels because the placer's
 * socket hostPath cannot admit under `baseline` — the stated STANDING
 * exception (module header), scoped to exactly this namespace so nothing
 * else inherits it.
 */
export function buildPlacementNamespace(name: string, installScope: string): object {
  if (!DNS_1123_RE.test(name)) refuse(`namespace name not k8s-legal: ${name}`);
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      labels: {
        [DEV_ENV_LABELS.install]: installScope,
        [PLACEMENT_LABEL]: 'namespace',
        'pod-security.kubernetes.io/enforce': 'privileged',
        'pod-security.kubernetes.io/warn': 'privileged',
      },
    },
  };
}

/**
 * Default-deny egress for every pod in the placement namespace, opened to
 * DNS and — when the proxy host is a literal address — the gateway proxy.
 *
 * The ipBlock here is a DELIBERATE divergence from claim-route.ts's
 * everything-is-a-selector rule, with a different threat model: the claim
 * route guards against tenant-forgeable labels admitting the parent
 * apiserver, while this term names platform infrastructure out of the
 * operator's own config — nothing a tenant writes can move it. A proxy named
 * by DNS has no netpol form at all; that case returns a RESIDUAL the caller
 * must surface, and the namespace stays sealed to DNS only — fail closed,
 * the pull then fails legibly rather than riding an un-governed opening.
 */
export function buildPlacementNetpol(
  namespaceName: string,
  installScope: string,
  proxyUrl: string,
): { policy: object; residual: string | null } {
  const url = new URL(proxyUrl);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const isIp = IPV4_RE.test(url.hostname);
  const egress: object[] = [
    {
      // DNS, both protocols, to the cluster's own resolver.
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
  ];
  if (isIp) {
    egress.push({
      to: [{ ipBlock: { cidr: `${url.hostname}/32` } }],
      ports: [{ protocol: 'TCP', port }],
    });
  }
  return {
    policy: {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'placement-egress',
        namespace: namespaceName,
        labels: { [DEV_ENV_LABELS.install]: installScope, [PLACEMENT_LABEL]: 'netpol' },
      },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress,
      },
    },
    residual: isIp
      ? null
      : `placement proxy '${url.hostname}' is DNS-named — no netpol term can pin it, so the namespace stays sealed beyond DNS and pulls will fail until the proxy is addressed by IP (or the netpol grows a governed opening)`,
  };
}

export interface PlacementJobInput {
  namespaceName: string;
  installScope: string;
  spec: DriverPlaceSpec;
  egress: PlacementEgress;
}

/**
 * One placement, one disposable Job, `backoffLimit: 0` — retry policy
 * belongs to the reconciler's rows, not to kubelet restarts that would blur
 * whose attempt failed.
 *
 * The script is three lines on purpose, every substituted value
 * grammar-clamped above it: pull the digest-pinned source ref through the
 * proxy env (a digest-pinned pull is CONTENT-ADDRESSED — landing bits other
 * than the signed digest is not a thing containerd can do, which is the
 * digest verification), tag it under the derived non-resolvable ref, done.
 * Idempotent by probe: re-pulling a present digest is a no-op, which is what
 * makes host-death re-runs safe.
 */
export function buildPlacementJob(input: PlacementJobInput): object {
  const { namespaceName, installScope, spec, egress } = input;
  if (spec.origin.kind !== 'pull') refuse(`k8s placement realizes only the pull origin, got '${spec.origin.kind}'`);
  if (!REF_RE.test(spec.origin.sourceRef)) refuse(`source ref not grammar-legal: ${spec.origin.sourceRef}`);
  if (!REF_RE.test(spec.ref)) refuse(`derived ref not grammar-legal: ${spec.ref}`);
  if (!spec.ref.startsWith(`${PLACE_REF_HOST}/`)) refuse(`derived ref must be registry-derived (${PLACE_REF_HOST}/…): ${spec.ref}`);
  if (!spec.origin.sourceRef.endsWith(`@${spec.origin.digest}`)) {
    refuse(`source ref is not pinned to the signed digest: ${spec.origin.sourceRef}`);
  }
  const jobName = placementJobName(spec.stampId, spec.version);
  if (!DNS_1123_RE.test(jobName)) refuse(`job name not k8s-legal (stamp id too long?): ${jobName}`);
  const ctr = `ctr --address ${SOCKET_MOUNT_PATH} -n k8s.io images`;
  const script = [
    'set -eu',
    `${ctr} pull ${spec.origin.sourceRef}`,
    `${ctr} tag --force ${spec.origin.sourceRef} ${spec.ref}`,
    `echo placed ${spec.origin.digest}`,
  ].join('\n');
  const labels = {
    ...spec.labels,
    [DEV_ENV_LABELS.install]: installScope,
    [PLACEMENT_LABEL]: 'job',
  };
  const caMount = egress.proxyCaPath
    ? {
        volumeMounts: [{ name: 'proxy-ca', mountPath: PROXY_CA_MOUNT_PATH, readOnly: true }],
        volumes: [{ name: 'proxy-ca', hostPath: { path: egress.proxyCaPath, type: 'File' } }],
        env: [{ name: 'SSL_CERT_FILE', value: PROXY_CA_MOUNT_PATH }],
      }
    : { volumeMounts: [], volumes: [], env: [] };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: namespaceName, labels },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'placer',
              image: egress.placerImage,
              // Node-present by contract (PlacementEgress.placerImage) — a
              // placement pod that pulls at placement time is the failure
              // class IfNotPresent exists to prevent.
              imagePullPolicy: 'IfNotPresent',
              command: ['/bin/sh', '-c', script],
              env: [
                // Ruling 1: the pull rides the gateway. Ruling 3: no
                // credential is projected here — private-origin auth is the
                // gateway's custody, same as sandbox git.
                { name: 'HTTPS_PROXY', value: egress.proxyUrl },
                { name: 'HTTP_PROXY', value: egress.proxyUrl },
                { name: 'NO_PROXY', value: 'localhost,127.0.0.1' },
                ...caMount.env,
              ],
              resources: {
                // The quota story: a placement is bounded work, and limits
                // are what keeps a runaway pull from being node hygiene.
                limits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '2Gi' },
              },
              volumeMounts: [
                { name: 'containerd-sock', mountPath: SOCKET_MOUNT_PATH },
                ...caMount.volumeMounts,
              ],
            },
          ],
          volumes: [
            {
              name: 'containerd-sock',
              hostPath: { path: egress.containerdSocket ?? DEFAULT_CONTAINERD_SOCKET, type: 'Socket' },
            },
            ...caMount.volumes,
          ],
        },
      },
    },
  };
}
