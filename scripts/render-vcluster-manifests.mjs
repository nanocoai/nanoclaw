#!/usr/bin/env node
/**
 * Regenerate src/dev-env/vcluster-manifests.ts from the pinned vcluster chart.
 *
 * Dev-time only: helm is needed HERE and nowhere else — the host applies the
 * checked-in rendered output with plain kubectl (no helm, no vcluster binary
 * at runtime). Re-run on every chart version bump; never hand-edit the
 * generated module.
 *
 *   node scripts/render-vcluster-manifests.mjs
 *
 * What it does, and why:
 *  - Renders the chart with a DNS-safe placeholder namespace (vcns-000) and
 *    the fixed instance name `vc` (the namespace is the per-instance identity;
 *    the name never varies, which keeps service DNS and secret names
 *    predictable: service `vc`, kubeconfig secret `vc-vc`).
 *  - DROPS the vc-config Secret from the rendered stream: its config.yaml is
 *    base64 of the merged values with the namespace baked into extraSANs and
 *    exportKubeConfig.server, so text substitution cannot reach it. The
 *    driver regenerates that secret per instance from VCLUSTER_CONFIG_YAML
 *    via stringData.
 *  - Replaces the placeholder namespace with __VC_NS__ tokens and verifies
 *    nothing else render-specific leaked through.
 *  - Appends the driver-authored NetworkPolicies (D19 egress seal) — not from
 *    the chart (policies.networkPolicy stays disabled; vcluster's own netpol
 *    model guards the wrong layer for us).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHART_VERSION = '0.36.1';
const PLACEHOLDER_NS = 'vcns-000';
const NS_TOKEN = '__VC_NS__';
const RUNTIME_CLASS_TOKEN = '__VC_RUNTIME_CLASS__';
const VCLUSTER_NAME = 'vc';
const PARENT_CLUSTER_ROLE = 'nanoclaw-dev-env-vcluster';
/** Match the POC's k3s server minor — RBAC rules are kube-version-gated at render. */
const KUBE_VERSION = '1.35.7';

const VALUES = `controlPlane:
  statefulSet:
    image:
      repository: loft-sh/vcluster-oss
    resources:
      requests:
        cpu: 100m
        memory: 512Mi
        ephemeral-storage: 400Mi
      limits:
        cpu: "1"
        memory: 2Gi
        ephemeral-storage: 8Gi
    persistence:
      volumeClaim:
        enabled: false
  proxy:
    extraSANs:
      - ${VCLUSTER_NAME}.${PLACEHOLDER_NS}.svc
      - ${VCLUSTER_NAME}.${PLACEHOLDER_NS}.svc.cluster.local
exportKubeConfig:
  server: https://${VCLUSTER_NAME}.${PLACEHOLDER_NS}.svc:443
telemetry:
  enabled: false
`;

/**
 * D19: claimed instances default to no egress. The seal is host-level netpol
 * (k3s enforces via its embedded controller); vcluster-internal policies are
 * not synced and would guard nothing. Three policies:
 *  - default-deny egress for every pod in the namespace, with intra-namespace
 *    and DNS carve-outs (workloads must reach the vcluster apiserver pod and
 *    the synced CoreDNS; CoreDNS must reach upstream DNS).
 *  - control-plane exception: the syncer must reach the host apiserver, which
 *    sits outside the pod CIDR. Our infrastructure, not tenant code. The
 *    selector must be UNFORGEABLE: plain labels (like `app`) sync verbatim
 *    from tenant pods, so a tenant could wear them. `vcluster.loft.sh/
 *    managed-by` is in the syncer's translated set — every synced pod carries
 *    it, a tenant cannot shed it, and the control-plane pod (chart-created,
 *    not synced) never has it. app=vcluster AND managed-by-absent is
 *    therefore exactly "our infra, never tenant code".
 *  - ingress: intra-namespace freely; the vcluster API port from anywhere
 *    (client-cert gated; per-claim route narrowing is a declared deferral).
 */
const NETWORK_POLICIES = `---
# driver-authored (not from chart): D19 egress seal
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dev-env-default-deny
  namespace: ${PLACEHOLDER_NS}
spec:
  podSelector: {}
  policyTypes:
    - Egress
    - Ingress
  egress:
    - to:
        - podSelector: {}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
  ingress:
    - from:
        - podSelector: {}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dev-env-control-plane
  namespace: ${PLACEHOLDER_NS}
spec:
  podSelector:
    matchExpressions:
      - key: app
        operator: In
        values:
          - vcluster
      - key: vcluster.loft.sh/managed-by
        operator: DoesNotExist
  policyTypes:
    - Egress
    - Ingress
  egress:
    - {}
  ingress:
    - ports:
        - protocol: TCP
          port: 8443
`;

const rendered = execFileSync(
  'helm',
  [
    'template',
    VCLUSTER_NAME,
    'vcluster',
    '--repo',
    'https://charts.loft.sh',
    '--version',
    CHART_VERSION,
    '--namespace',
    PLACEHOLDER_NS,
    '--kube-version',
    KUBE_VERSION,
    '-f',
    '-',
  ],
  { input: VALUES, maxBuffer: 16 * 1024 * 1024 },
).toString();

// Split into documents, pull the config secret out, keep the rest.
const docs = rendered.split(/^---$/m).filter((d) => d.trim().length > 0);
let configYaml = null;
let droppedVclusterRole = false;
let rewroteVclusterBinding = false;
const kept = [];
for (let doc of docs) {
  const isConfigSecret = /kind: Secret/.test(doc) && new RegExp(`name: "vc-config-${VCLUSTER_NAME}"`).test(doc);
  if (isConfigSecret) {
    const match = doc.match(/config\.yaml: "([A-Za-z0-9+/=]+)"/);
    if (!match) throw new Error('vc-config secret found but config.yaml data not parseable');
    configYaml = Buffer.from(match[1], 'base64').toString('utf8');
    continue;
  }
  const isVclusterRole = /^kind: Role$/m.test(doc) && new RegExp(`name: "?vc-${VCLUSTER_NAME}"?`).test(doc);
  if (isVclusterRole) {
    droppedVclusterRole = true;
    continue;
  }
  const isVclusterBinding = /^kind: RoleBinding$/m.test(doc) && new RegExp(`name: "?vc-${VCLUSTER_NAME}"?`).test(doc);
  if (isVclusterBinding) {
    const before = doc;
    doc = doc.replace(
      /(roleRef:\s*\n\s*)kind: Role(\s*\n\s*name:) "?vc-vc"?/,
      `$1kind: ClusterRole$2 ${PARENT_CLUSTER_ROLE}`,
    );
    if (doc === before) throw new Error('vc-vc RoleBinding roleRef shape changed');
    rewroteVclusterBinding = true;
  }
  kept.push(doc.trimEnd());
}
if (!configYaml) throw new Error(`no vc-config-${VCLUSTER_NAME} Secret in render — chart layout changed?`);
if (!droppedVclusterRole || !rewroteVclusterBinding) {
  throw new Error('vcluster Role/RoleBinding shape changed — parent RBAC projection not applied');
}

const substitute = (text) => text.replaceAll(PLACEHOLDER_NS, NS_TOKEN);
let manifests = substitute(kept.join('\n---') + '\n' + NETWORK_POLICIES);
const serviceAccountLine = /^(\s*)serviceAccountName: "?vc-vc"?$/m;
if (!serviceAccountLine.test(manifests)) throw new Error('vcluster control-plane serviceAccountName shape changed');
manifests = manifests.replace(serviceAccountLine, `$&\n$1runtimeClassName: "${RUNTIME_CLASS_TOKEN}"`);
let config = substitute(configYaml);
if (!config.includes('runtimeClassName: ""')) throw new Error('vcluster workload runtimeClassName shape changed');
config = config.replace('runtimeClassName: ""', `runtimeClassName: "${RUNTIME_CLASS_TOKEN}"`);

for (const [what, text] of [
  ['manifests', manifests],
  ['config', config],
]) {
  if (text.includes(PLACEHOLDER_NS)) throw new Error(`placeholder namespace leaked through substitution in ${what}`);
}

const images = [...new Set([...rendered.matchAll(/image: "([^"]+)"/g)].map((m) => m[1]))];
// Runtime-only images the render never mentions: the syncer deploys CoreDNS as
// a synced workload, and injects a hosts-rewrite init container into every
// synced tenant pod. Harvest their pins from the merged config so the pre-pull
// list is actually complete.
const configCoredns = config.match(/coredns\/coredns:[0-9.]+/);
images.push(configCoredns ? `docker.io/${configCoredns[0]}` : 'docker.io/coredns/coredns:1.14.2');
const rewriteHosts = config.match(
  /rewriteHosts:[\s\S]*?initContainer:[\s\S]*?registry: ([^\s]+)\s+repository: ([^\s]+)\s+[\s\S]*?tag: "([^"]+)"/,
);
if (!rewriteHosts) throw new Error('rewriteHosts init image not found in config — chart layout changed?');
images.push(`${rewriteHosts[1]}/${rewriteHosts[2]}:${rewriteHosts[3]}`);

const escapeTemplate = (s) => s.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('$', '\\$');

const out = `/**
 * GENERATED by scripts/render-vcluster-manifests.mjs — do not edit.
 *
 * Rendered from the vcluster chart v${CHART_VERSION} (k8s distro, emptyDir, OSS
 * image, telemetry off) with --kube-version ${KUBE_VERSION}, plus the
 * driver-authored D19 NetworkPolicies. The vc-config Secret is deliberately
 * absent: the driver regenerates it per instance from VCLUSTER_CONFIG_YAML
 * because its content embeds the namespace (extraSANs, exportKubeConfig).
 *
 * The instance name is fixed ('${VCLUSTER_NAME}'): service \`${VCLUSTER_NAME}\`, kubeconfig secret
 * \`vc-${VCLUSTER_NAME}\`, config secret \`vc-config-${VCLUSTER_NAME}\`. The namespace is the
 * per-instance identity — every \`${NS_TOKEN}\` token below is replaced by the
 * driver at apply time.
 */

export const VCLUSTER_CHART_VERSION = '${CHART_VERSION}';
export const VCLUSTER_NAME = '${VCLUSTER_NAME}';
export const VCLUSTER_NS_TOKEN = '${NS_TOKEN}';
export const VCLUSTER_RUNTIME_CLASS_TOKEN = '${RUNTIME_CLASS_TOKEN}';
export const VCLUSTER_PARENT_CLUSTER_ROLE = '${PARENT_CLUSTER_ROLE}';
/** Kubeconfig secret the syncer writes at runtime (never rendered by helm). */
export const VCLUSTER_KUBECONFIG_SECRET = 'vc-${VCLUSTER_NAME}';
export const VCLUSTER_CONFIG_SECRET = 'vc-config-${VCLUSTER_NAME}';
/** Every image an instance needs; the pool node must have them pre-supplied. */
export const VCLUSTER_IMAGES = ${JSON.stringify(images, null, 2)} as const;

export const VCLUSTER_MANIFESTS = \`${escapeTemplate(manifests)}\`;

export const VCLUSTER_CONFIG_YAML = \`${escapeTemplate(config)}\`;
`;

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dev-env', 'vcluster-manifests.ts');
writeFileSync(dest, out);
console.log(`wrote ${dest}: ${kept.length} manifest docs + netpol, config ${config.length} bytes, images: ${images.join(', ')}`);
