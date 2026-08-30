/**
 * D19 per-claim route — the NetworkPolicy the k8s driver authors in the
 * CLAIMANT'S namespace, opening one group's session pods to one claimed
 * child's apiserver and nothing else.
 *
 * Why a policy per claim, in the claimant's namespace: the agents namespace
 * floor is default-deny (recipes 50-agents-netpol.yaml), and NetworkPolicies
 * are additive — so reachability to a child is an ALLOW object that exists
 * exactly while the claim does, keyed on the group's stable pod labels so it
 * survives pod respawn, and deleted explicitly on release/terminal/reap
 * because it does NOT live in (and die with) the child's namespace.
 *
 * THE T6 SEAL, structurally: every term is a SELECTOR. A pod-selector egress
 * rule can never admit the parent apiserver — it is not a pod — where a CIDR
 * would silently include it. Policy evaluates POST-DNAT, so rules name the
 * child's real port (8443) and its pods, never the Service's ClusterIP or
 * :443 — an ipBlock against a ClusterIP is dead code that reads like
 * enforcement. The child pod term is the forge-proof pair the rendered bundle
 * already uses (vcluster-manifests.ts): `app=vcluster` alone is
 * tenant-forgeable inside the child (plain labels sync verbatim), and the
 * syncer stamps `vcluster.loft.sh/managed-by` on every synced pod, so
 * requiring it ABSENT is what a tenant pod cannot fake — paired with the
 * namespace's immutable kubernetes.io/metadata.name.
 *
 * The type below is deliberately closed (no ipBlock field exists to fill in),
 * and the tests assert the built object carries none anyway — the guard must
 * outlive a future widening of the type.
 */
import { DEV_ENV_LABELS } from './types.js';

/** The one port a route ever opens: the child apiserver's real (post-DNAT) port. */
export const CLAIM_ROUTE_PORT = 8443;
const CLAIM_ROUTE_PREFIX = 'dev-env-route-';

/** DNS-1123 label — namespace names; kept to 63 like the driver's own prefix check. */
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** DNS-1123 subdomain — object names (the route's own name must survive `create`). */
const OBJECT_NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
/** Label key: optional prefix/, then a qualified name. Conservative, ASCII-only. */
const LABEL_KEY_RE = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
/** Label value — the same grammar the claim's labels are refused against. */
const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

export interface ClaimRouteSpec {
  installScope: string;
  instanceId: string;
  claimantNamespace: string;
  claimantPodSelector: Record<string, string>;
  /** The claimed instance's own namespace — where its vcluster pod runs. */
  childNamespace: string;
}

/**
 * The route object, as a closed shape: selectors and one port, with nowhere
 * to put an ipBlock. Egress-only — the child-side floor already admits 8443
 * ingress; a route must widen exactly one direction.
 */
export interface ClaimRoute {
  apiVersion: 'networking.k8s.io/v1';
  kind: 'NetworkPolicy';
  metadata: {
    name: string;
    namespace: string;
    /** install + instance: what attributes a route to its claim, and what the residue sweep joins on. */
    labels: Record<string, string>;
  };
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    policyTypes: ['Egress'];
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: Record<string, string> };
            podSelector: {
              matchExpressions: [
                { key: 'app'; operator: 'In'; values: ['vcluster'] },
                { key: 'vcluster.loft.sh/managed-by'; operator: 'DoesNotExist' },
              ];
            };
          },
        ];
        ports: [{ protocol: 'TCP'; port: number }];
      },
    ];
  };
}

/** One name rule, shared by open and every close path — drift here would strand routes. */
export function claimRouteName(instanceId: string): string {
  return `${CLAIM_ROUTE_PREFIX}${instanceId}`;
}

function refuse(detail: string): never {
  // Same shape stampUnknown gives its refusals: the detail rides the message,
  // because "instantiation-failed" alone is not a diagnosis.
  throw Object.assign(new Error(`instantiation-failed: ${detail}`), {
    kind: 'instantiation-failed' as const,
    retryable: false as const,
    detail,
  });
}

/**
 * Build the route or refuse. Refusals fail CLOSED on charset grounds: an
 * input that cannot round-trip the k8s grammar must never be mangled into a
 * selector that matches something else.
 */
export function buildClaimRoute(spec: ClaimRouteSpec): ClaimRoute {
  if (!NAMESPACE_RE.test(spec.claimantNamespace)) refuse(`claimant namespace not k8s-legal: ${spec.claimantNamespace}`);
  if (!NAMESPACE_RE.test(spec.childNamespace)) refuse(`child namespace not k8s-legal: ${spec.childNamespace}`);
  if (!LABEL_VALUE_RE.test(spec.installScope)) refuse('install scope not label-legal');
  if (!LABEL_VALUE_RE.test(spec.instanceId)) refuse('instance id not label-legal');
  const name = claimRouteName(spec.instanceId);
  if (!OBJECT_NAME_RE.test(name)) refuse(`route name not k8s-legal: ${name}`);
  const selector = Object.entries(spec.claimantPodSelector);
  // An empty selector is every pod in the namespace — the exact widening this
  // object exists to avoid. Refused, never defaulted.
  if (selector.length === 0) refuse('claimant pod selector is empty');
  for (const [key, value] of selector) {
    if (!LABEL_KEY_RE.test(key)) refuse(`claimant selector key not label-legal: ${key}`);
    if (!LABEL_VALUE_RE.test(value)) refuse(`claimant selector value not label-legal (key ${key})`);
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name,
      namespace: spec.claimantNamespace,
      labels: {
        [DEV_ENV_LABELS.install]: spec.installScope,
        [DEV_ENV_LABELS.instance]: spec.instanceId,
      },
    },
    spec: {
      podSelector: { matchLabels: { ...spec.claimantPodSelector } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': spec.childNamespace } },
              podSelector: {
                matchExpressions: [
                  { key: 'app', operator: 'In', values: ['vcluster'] },
                  { key: 'vcluster.loft.sh/managed-by', operator: 'DoesNotExist' },
                ],
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: CLAIM_ROUTE_PORT }],
        },
      ],
    },
  };
}
