/** Parent-governed egress for one claimed vcluster.
 *
 * The session private key never enters the child. A parent-owned relay pod in
 * the vcluster's outer namespace holds it; the claimed child's Gateway learns
 * only that Service's ClusterIP and the public proxy CA. The parent Gateway
 * therefore receives its ordinary session-channel identity and remains the
 * final policy, credential and audit boundary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { emitDevEnvironmentBound } from '../audit/runtime-emitters.js';
import {
  GatewaySessionChannelProvisioner,
  type GatewaySessionChannelProvisionerOptions,
} from './gateway-provisioner.js';
import type {
  ProvisionedSessionChannel,
  SessionChannelLineage,
  SessionChannelProvisioner,
} from './session-sidecar.js';
import type {
  K8sInstanceRelay,
  K8sInstanceRelayCluster,
  K8sInstanceRelayContext,
} from '../dev-env/k8s-driver.js';

const STAMP_ID = 'governed-child-kata';
const CHILD_HOST_CONTAINER = 'host';
const RELAY_NAME = 'parent-egress-relay';
const TRUST_NAME = 'parent-egress-trust';
const RELAY_PORT = 15001;
const TRUST_DIR = '/etc/nanoco/parent-egress';
const WORKSPACE_NAMESPACE_SUFFIX = '-workspace';
const WORKSPACE_CONTROLLER_NAME = 'nanoclaw-workspace-controller';
const WORKSPACE_CONTROLLER_PORT = 8787;
const WORKSPACE_TOKEN_NAME = 'nanoclaw-workspace-controller-token';
const WORKSPACE_TOKEN_DIR = '/run/nanoclaw/workspace-controller';
const WORKSPACE_TRUST_NAME = 'nanoclaw-workspace-gateway-trust';
const WORKSPACE_HOST_ROOT = '/var/lib/nanoco/workspaces';
const EDGE_NAME = 'governed-child-edge';
const EDGE_PORT = 8080;
const EDGE_RETRY_MS = 1_000;
const EDGE_RUNTIME_CLASS = 'kata-qemu-runtime-rs';
const CHILD_RENDER_RETRY_MS = 1_000;
const RENEW_MARGIN_MS = 60_000;
const RENEW_RETRY_MS = 5_000;
const IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const CONFIG_KEYS = [
  'NANOCO_DEPLOYMENT_ID',
  'NANOCO_SIDECAR_IMAGE',
  'NANOCO_GATEWAY_CONTROL_URL',
  'NANOCO_GATEWAY_CONTROL_SERVER_NAME',
  'NANOCO_GATEWAY_ADDRESS',
  'NANOCO_GATEWAY_SERVER_NAME',
  'NANOCO_GATEWAY_CA',
  'NANOCO_DEPLOYMENT_CERT',
  'NANOCO_DEPLOYMENT_KEY',
  'NANOCO_PROXY_CA',
] as const;

const EDGE_CONFIG_KEYS = [
  'NANOCLAW_DEV_ENV_EDGE_DOMAIN',
  'NANOCLAW_DEV_ENV_EDGE_ACTOR',
  'NANOCLAW_DEV_ENV_EDGE_PROXY_IMAGE',
] as const;

interface RelayState {
  context: K8sInstanceRelayContext;
  channel: ProvisionedSessionChannel;
  serviceIp: string;
  proxyCa: string;
  requestCapability: string;
  workspaceControllerToken: string;
  timer: ReturnType<typeof setTimeout> | null;
  edgeTimer: ReturnType<typeof setTimeout> | null;
  childRenderTimer: ReturnType<typeof setTimeout> | null;
  cluster: K8sInstanceRelayCluster;
}

interface EdgeOptions {
  domain: string;
  actor: string;
  proxyImage: string;
}

interface RelayOptions {
  deploymentId: string;
  sidecarImage: string;
  gatewayAddress: string;
  gatewayServerName: string;
  proxyCaPath: string;
  parentSystemNamespace: string;
  parentHostServiceAccount: string;
  provisioner: SessionChannelProvisioner;
  edge?: EdgeOptions;
  now?: () => number;
}

export class ParentGovernedDevEnvRelay implements K8sInstanceRelay {
  private readonly options: RelayOptions;
  private readonly now: () => number;
  private readonly states = new Map<string, RelayState>();

  constructor(options: RelayOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async ensure(context: K8sInstanceRelayContext, cluster: K8sInstanceRelayCluster): Promise<void> {
    if (context.stampId !== STAMP_ID) return;
    validateContext(context);
    const existing = this.states.get(context.namespace);
    if (existing) {
      cluster.apply(parentRelayManifests(existing.context, existing.channel, this.options));
      existing.serviceIp = requireServiceIp(cluster, context.namespace);
      existing.cluster = cluster;
      this.armChildRender(existing);
      this.armEdge(existing);
      return;
    }

    const expected = lineageFor(this.options.deploymentId, context);
    let channel: ProvisionedSessionChannel | null = null;
    try {
      const adoptable = this.options.provisioner.findAdoptableLineage?.(expected.sessionId) ?? null;
      const lineage: MailboxLineage = adoptable
        ? requireSameLineage(adoptable as MailboxLineage, expected)
        : { ...expected, requestCapability: randomBytes(32).toString('hex') };
      const requestCapability = requireRequestCapability(lineage.requestCapability);
      channel = adoptable
        ? await this.options.provisioner.adopt!(lineage)
        : await this.options.provisioner.provision(lineage);
      cluster.apply(parentRelayManifests(context, channel, this.options));
      const state: RelayState = {
        context,
        channel,
        serviceIp: requireServiceIp(cluster, context.namespace),
        proxyCa: fs.readFileSync(this.options.proxyCaPath, 'utf8'),
        requestCapability,
        workspaceControllerToken: randomBytes(32).toString('base64url'),
        timer: null,
        edgeTimer: null,
        childRenderTimer: null,
        cluster,
      };
      this.states.set(context.namespace, state);
      this.armRenewal(state);
      this.armChildRender(state);
      this.armEdge(state);
      await emitDevEnvironmentBound({
        parentAgentId: context.ownerRef,
        relaySessionId: expected.sessionId,
        environmentId: context.envId,
        instanceNamespace: context.namespace,
      });
    } catch (error) {
      if (channel) {
        await Promise.allSettled([
          this.options.provisioner.revoke(channel, 'dev-environment-relay-setup-failed'),
          this.options.provisioner.release(channel),
        ]);
      }
      throw error;
    }
  }

  renderChild(namespace: string, manifests: string): string {
    const state = this.states.get(namespace);
    if (!state) return manifests; // an unclaimed warm slot keeps its sealed baseline
    const docs = parseJsonDocuments(manifests);
    const deployment = docs.find((doc) =>
      doc.kind === 'Deployment' && doc.metadata?.namespace === 'system' && doc.metadata?.name === 'gateway');
    if (!deployment) throw new Error('governed child has no system/gateway Deployment for parent relay');
    if (deployment.metadata?.annotations?.['nanoco.dev/parent-governed-egress'] !== 'required') {
      return manifests;
    }
    const podSpec = deployment.spec?.template?.spec;
    const gateway = podSpec?.containers?.find((container: Record<string, unknown>) => container.name === 'gateway');
    if (!podSpec || !gateway) throw new Error('governed child Gateway pod shape changed');

    gateway.env = upsertNamed(gateway.env, [
      { name: 'NANOCO_GW_UPSTREAM_PROXY_URL', value: `http://${state.serviceIp}:${RELAY_PORT}` },
      { name: 'NANOCO_GW_UPSTREAM_CA_CERT', value: `${TRUST_DIR}/proxy-ca.pem` },
    ]);
    gateway.volumeMounts = upsertNamed(gateway.volumeMounts, [
      { name: TRUST_NAME, mountPath: TRUST_DIR, readOnly: true },
    ]);
    podSpec.volumes = upsertNamed(podSpec.volumes, [
      { name: TRUST_NAME, configMap: { name: TRUST_NAME, defaultMode: 0o444 } },
    ]);
    const hostDeployment = docs.find((doc) =>
      doc.kind === 'Deployment' && doc.metadata?.namespace === 'nanoclaw' && doc.metadata?.name === 'nanoclaw-host');
    const hostPodSpec = hostDeployment?.spec?.template?.spec;
    const host = hostPodSpec?.containers?.find(
      (container: Record<string, unknown>) => container.name === CHILD_HOST_CONTAINER,
    );
    if (!hostPodSpec || !host) throw new Error('governed child Host pod shape changed');
    const mailboxPrefix = childMailboxPrefix(host.env, state.context.namespace, state.channel.lineage.sessionId);
    const workspacePrefix = childWorkspacePrefix(host.env, state.context.namespace, state.channel.lineage.sessionId);
    const hostImage = requireImmutableChildImage(host.image);
    const storage = workspaceStorageCoordinates(host.env, workspacePrefix);
    const custodyNamespace = workspaceNamespace(state.context.namespace);
    state.cluster.apply(workspacePlaneManifests(state, this.options, hostImage, storage));
    const workspaceControllerIp = requireWorkspaceControllerIp(state.cluster, custodyNamespace);
    host.env = removeNamed(host.env, [
      'NANOCLAW_WORKSPACE_S3_BUCKET',
      'NANOCLAW_WORKSPACE_S3_ENDPOINT',
      'NANOCLAW_WORKSPACE_S3_PREFIX',
      'NANOCLAW_WORKSPACE_S3_REGION',
      'NANOCLAW_WORKSPACE_S3_TRANSPORT',
    ]);
    host.env = upsertNamed(host.env, [
      { name: 'NANOCLAW_MAILBOX_S3_PREFIX', value: mailboxPrefix },
      { name: 'NANOCLAW_MAILBOX_S3_TRANSPORT', value: 'gateway' },
      { name: 'NANOCLAW_MAILBOX_GATEWAY_PROXY', value: `http://${state.serviceIp}:${RELAY_PORT}` },
      { name: 'NANOCLAW_MAILBOX_GATEWAY_CA', value: `${TRUST_DIR}/proxy-ca.pem` },
      { name: 'NANOCLAW_STORAGE_CAPABILITY', value: state.requestCapability },
      { name: 'NANOCO_STATELESS_K8S_HOST', value: '1' },
      { name: 'NANOCO_HOST_SOURCE_ROOT', value: '/opt/nanoclaw/host' },
      { name: 'NANOCO_MATERIALIZER_IMAGE', value: hostImage },
      { name: 'NANOCO_WORKSPACE_CONTROLLER_URL', value: `http://${workspaceControllerIp}:${WORKSPACE_CONTROLLER_PORT}` },
      { name: 'NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE', value: `${WORKSPACE_TOKEN_DIR}/token` },
      { name: 'NANOCO_WORKSPACE_HOST_ROOT', value: WORKSPACE_HOST_ROOT },
    ]);
    host.volumeMounts = upsertNamed(host.volumeMounts, [
      { name: TRUST_NAME, mountPath: TRUST_DIR, readOnly: true },
      { name: WORKSPACE_TOKEN_NAME, mountPath: WORKSPACE_TOKEN_DIR, readOnly: true },
    ]);
    hostPodSpec.volumes = upsertNamed(hostPodSpec.volumes, [
      { name: TRUST_NAME, configMap: { name: TRUST_NAME, defaultMode: 0o444 } },
      { name: WORKSPACE_TOKEN_NAME, secret: { secretName: WORKSPACE_TOKEN_NAME, defaultMode: 0o400 } },
    ]);
    const trusts = ['system', 'nanoclaw'].map((namespace) => ({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: TRUST_NAME, namespace },
      data: { 'proxy-ca.pem': state.proxyCa },
    }));
    const workspaceToken = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: WORKSPACE_TOKEN_NAME, namespace: 'nanoclaw' },
      type: 'Opaque',
      stringData: { token: state.workspaceControllerToken },
    };
    // kubectl applies a multi-document stream in order. The trust ConfigMaps
    // must follow both Namespace documents but precede the workloads that
    // mount them; prepending them makes the first apply deterministically fail
    // with "namespaces ... not found", after which the readiness Deployments
    // exist and the driver's absence-only healer has no reason to reapply.
    const namespaceIndexes = ['system', 'nanoclaw'].map((namespace) =>
      docs.findIndex((doc) => doc.kind === 'Namespace' && doc.metadata?.name === namespace),
    );
    if (namespaceIndexes.some((index) => index < 0)) {
      throw new Error('governed child is missing the system or nanoclaw Namespace document');
    }
    const trustIndex = Math.max(...namespaceIndexes) + 1;
    return [...docs.slice(0, trustIndex), ...trusts, workspaceToken, ...docs.slice(trustIndex)]
      .map((doc) => JSON.stringify(doc))
      .join('\n---\n');
  }

  async release(namespace: string, cluster?: K8sInstanceRelayCluster): Promise<void> {
    const state = this.states.get(namespace);
    if (state) {
      this.states.delete(namespace);
      if (state.timer) clearTimeout(state.timer);
      if (state.edgeTimer) clearTimeout(state.edgeTimer);
      if (state.childRenderTimer) clearTimeout(state.childRenderTimer);
      // Only the channel grant needs the state: it names a channel this
      // process opened, and a process that never opened one has none to revoke.
      await Promise.allSettled([
        this.options.provisioner.revoke(state.channel, 'dev-environment-released'),
        this.options.provisioner.release(state.channel),
      ]);
    }
    // The companion namespace is NOT one of those: it is derivable from the
    // instance namespace alone, so it is torn down whether or not this process
    // held the relay state. It used to hang off `state`, which meant a host
    // restart between claim and release left the namespace — and the
    // workspace-controller Deployment inside it — running forever, invisible to
    // `envs list` because the env itself released cleanly.
    (cluster ?? state?.cluster)?.deleteNamespace?.(workspaceNamespace(namespace));
  }

  private armChildRender(state: RelayState): void {
    if (this.states.get(state.context.namespace) !== state || !state.cluster.renderChild) return;
    if (state.childRenderTimer) clearTimeout(state.childRenderTimer);
    try {
      if (state.cluster.renderChild()) {
        state.childRenderTimer = null;
        return;
      }
    } catch (error) {
      log.warn('Dev-env relay child render failed; retrying', {
        namespace: state.context.namespace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    state.childRenderTimer = setTimeout(() => this.armChildRender(state), CHILD_RENDER_RETRY_MS);
    state.childRenderTimer.unref?.();
  }

  private armEdge(state: RelayState): void {
    if (!this.options.edge || this.states.get(state.context.namespace) !== state) return;
    if (state.edgeTimer) clearTimeout(state.edgeTimer);
    try {
      const rendered = edgeBridgeManifests(state.context, state.cluster, this.options.edge);
      if (rendered) {
        state.cluster.apply(rendered);
        state.edgeTimer = null;
        return;
      }
    } catch (error) {
      log.warn('Dev-env child edge bridge reconcile failed; retrying', {
        namespace: state.context.namespace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    state.edgeTimer = setTimeout(() => this.armEdge(state), EDGE_RETRY_MS);
    state.edgeTimer.unref?.();
  }

  private armRenewal(state: RelayState): void {
    if (state.timer) clearTimeout(state.timer);
    const leaseExpiresAt = Date.parse(state.channel.expiresAt);
    const delay = Math.max(1_000, leaseExpiresAt - this.now() - RENEW_MARGIN_MS);
    state.timer = setTimeout(() => void this.renew(state), delay);
    state.timer.unref?.();
  }

  private async renew(state: RelayState): Promise<void> {
    if (this.states.get(state.context.namespace) !== state) return;
    try {
      state.channel = await this.options.provisioner.renew(state.channel);
      this.armRenewal(state);
    } catch (error) {
      if (this.now() >= Date.parse(state.channel.certificateNotAfter)) {
        log.error('Dev-env parent relay certificate horizon exhausted', {
          namespace: state.context.namespace,
          environmentId: state.context.envId,
        });
        return;
      }
      log.warn('Dev-env parent relay renewal failed; retrying inside certificate horizon', {
        namespace: state.context.namespace,
        error: error instanceof Error ? error.message : String(error),
      });
      state.timer = setTimeout(() => void this.renew(state), RENEW_RETRY_MS);
      state.timer.unref?.();
    }
  }
}

export function configuredParentGovernedDevEnvRelay(): K8sInstanceRelay | undefined {
  const dotenv = readEnvFile([...CONFIG_KEYS, ...EDGE_CONFIG_KEYS]);
  const values = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, process.env[key]?.trim() || dotenv[key]?.trim() || '']),
  ) as Record<(typeof CONFIG_KEYS)[number], string>;
  if (CONFIG_KEYS.every((key) => !values[key])) return undefined;
  const missing = CONFIG_KEYS.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`Dev-env parent relay configuration is incomplete: ${missing.join(', ')}`);
  const edgeValues = Object.fromEntries(
    EDGE_CONFIG_KEYS.map((key) => [key, process.env[key]?.trim() || dotenv[key]?.trim() || '']),
  ) as Record<(typeof EDGE_CONFIG_KEYS)[number], string>;
  const edgePresent = EDGE_CONFIG_KEYS.filter((key) => edgeValues[key]);
  if (edgePresent.length !== 0 && edgePresent.length !== EDGE_CONFIG_KEYS.length) {
    throw new Error('Dev-env child edge configuration is incomplete');
  }
  const edge: EdgeOptions | undefined = edgePresent.length === 0
    ? undefined
    : {
        domain: requireEdgeDomain(edgeValues.NANOCLAW_DEV_ENV_EDGE_DOMAIN),
        actor: requireEdgeActor(edgeValues.NANOCLAW_DEV_ENV_EDGE_ACTOR),
        proxyImage: requireEdgeImage(edgeValues.NANOCLAW_DEV_ENV_EDGE_PROXY_IMAGE),
      };
  const materialRoot = path.join(DATA_DIR, 'nanoco-dev-env-relays');
  const serviceAccount = serviceAccountIdentity();
  const provisionerOptions: GatewaySessionChannelProvisionerOptions = {
    deploymentId: values.NANOCO_DEPLOYMENT_ID,
    controlUrl: values.NANOCO_GATEWAY_CONTROL_URL,
    controlServerName: values.NANOCO_GATEWAY_CONTROL_SERVER_NAME,
    gatewayAddress: values.NANOCO_GATEWAY_ADDRESS,
    gatewayServerName: values.NANOCO_GATEWAY_SERVER_NAME,
    gatewayCaPath: values.NANOCO_GATEWAY_CA,
    deploymentCertificatePath: values.NANOCO_DEPLOYMENT_CERT,
    deploymentPrivateKeyPath: values.NANOCO_DEPLOYMENT_KEY,
    proxyCaPath: values.NANOCO_PROXY_CA,
    materialRoot,
  };
  return new ParentGovernedDevEnvRelay({
    deploymentId: values.NANOCO_DEPLOYMENT_ID,
    sidecarImage: values.NANOCO_SIDECAR_IMAGE,
    gatewayAddress: values.NANOCO_GATEWAY_ADDRESS,
    gatewayServerName: values.NANOCO_GATEWAY_SERVER_NAME,
    proxyCaPath: values.NANOCO_PROXY_CA,
    parentSystemNamespace: serviceAccount.namespace,
    parentHostServiceAccount: serviceAccount.name,
    provisioner: new GatewaySessionChannelProvisioner(provisionerOptions),
    edge,
  });
}

function requireEdgeDomain(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) || value.includes('..')) {
    throw new Error('Dev-env child edge domain is invalid');
  }
  return value;
}

function requireEdgeActor(value: string): string {
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)) {
    throw new Error('Dev-env child edge actor is invalid');
  }
  return value;
}

function requireEdgeImage(value: string): string {
  if (!/^[A-Za-z0-9._/@:+-]{1,512}$/.test(value)) throw new Error('Dev-env child edge proxy image is invalid');
  return value;
}

function serviceAccountIdentity(): { namespace: string; name: string } {
  const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
  const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
  let subject = '';
  try {
    subject = String(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).sub ?? '');
  } catch {
    throw new Error('Host service-account token has no readable subject');
  }
  const prefix = `system:serviceaccount:${namespace}:`;
  const name = subject.startsWith(prefix) ? subject.slice(prefix.length) : '';
  for (const [kind, value] of [['namespace', namespace], ['name', name]] as const) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) throw new Error(`Host service-account ${kind} is invalid`);
  }
  return { namespace, name };
}

type MailboxLineage = SessionChannelLineage & { requestCapability?: string };

function lineageFor(deploymentId: string, context: K8sInstanceRelayContext): MailboxLineage {
  return {
    deploymentId,
    agentId: context.ownerRef,
    sessionId: `devenv-${context.envId}`,
    containerInstanceId: `devenv-${context.instanceId}`,
    channelId: `channel-${context.instanceId}`,
  };
}

function validateContext(context: K8sInstanceRelayContext): void {
  for (const value of [context.envId, context.instanceId, context.ownerRef, context.namespace]) {
    if (!IDENTIFIER_RE.test(value)) throw new Error('Dev-env parent relay context contains an unsafe identifier');
  }
  if (context.ownerRef === 'operator' || context.ownerRef === 'unscoped') {
    throw new Error('Dev-env parent relay requires an agent-owned claim');
  }
}

function requireSameLineage(actual: MailboxLineage, expected: MailboxLineage): MailboxLineage {
  for (const key of Object.keys(expected) as Array<keyof SessionChannelLineage>) {
    if (actual[key] !== expected[key]) throw new Error('Persisted dev-env relay lineage does not match its instance');
  }
  requireRequestCapability(actual.requestCapability);
  return actual;
}

function requireRequestCapability(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Persisted dev-env relay has no valid request capability');
  }
  return value;
}

function requireServiceIp(cluster: K8sInstanceRelayCluster, namespace: string): string {
  const value = cluster.serviceIp(namespace, RELAY_NAME);
  if (!value || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    throw new Error('Dev-env parent relay Service has no IPv4 ClusterIP');
  }
  return value;
}

interface WorkspaceStorageCoordinates {
  bucket: string;
  endpoint: string;
  prefix: string;
  region: string;
}

function workspaceNamespace(instanceNamespace: string): string {
  const value = `${instanceNamespace}${WORKSPACE_NAMESPACE_SUFFIX}`;
  if (value.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new Error('Dev-env workspace companion namespace is invalid');
  }
  return value;
}

function requireWorkspaceControllerIp(cluster: K8sInstanceRelayCluster, namespace: string): string {
  const value = cluster.serviceIp(namespace, WORKSPACE_CONTROLLER_NAME);
  if (!value || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    throw new Error('Dev-env workspace Controller Service has no IPv4 ClusterIP');
  }
  return value;
}

function requireImmutableChildImage(candidate: unknown): string {
  const value = typeof candidate === 'string' ? candidate : '';
  if (!/^\S+@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('Dev-env child Host manifest has no immutable image identity');
  }
  return value;
}

function workspaceStorageCoordinates(current: unknown, prefix: string): WorkspaceStorageCoordinates {
  const bucket = envLiteral(current, 'NANOCLAW_WORKSPACE_S3_BUCKET');
  const endpoint = envLiteral(current, 'NANOCLAW_WORKSPACE_S3_ENDPOINT');
  const region = envLiteral(current, 'NANOCLAW_WORKSPACE_S3_REGION');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('real-S3 child workspace bucket is invalid');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || endpoint !== `https://s3.${region}.amazonaws.com`) {
    throw new Error('real-S3 child workspace endpoint and region disagree');
  }
  return { bucket, endpoint, prefix, region };
}

function workspacePlaneManifests(
  state: RelayState,
  options: RelayOptions,
  image: string,
  storage: WorkspaceStorageCoordinates,
): string {
  const instanceNamespace = state.context.namespace;
  const namespace = workspaceNamespace(instanceNamespace);
  const controllerLabels = {
    'app.kubernetes.io/name': WORKSPACE_CONTROLLER_NAME,
    'nanoco.dev/instance': state.context.instanceId,
  };
  const custodianLabels = { 'app.kubernetes.io/name': 'nanoclaw-workspace-custodian' };
  const parentSubject = {
    kind: 'ServiceAccount',
    name: options.parentHostServiceAccount,
    namespace: options.parentSystemNamespace,
  };
  const controllerSubject = { kind: 'ServiceAccount', name: WORKSPACE_CONTROLLER_NAME, namespace };
  const docs = [
    {
      apiVersion: 'v1', kind: 'Namespace', metadata: {
        name: namespace,
        labels: {
          'pod-security.kubernetes.io/enforce': 'privileged',
          'pod-security.kubernetes.io/audit': 'baseline',
          'pod-security.kubernetes.io/warn': 'baseline',
          'nanoco.dev/workspace-companion': 'true',
        },
        annotations: { 'nanoco.dev/instance-namespace': instanceNamespace },
      },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
      metadata: { name: 'nanoclaw-workspace-installer', namespace },
      rules: [
        { apiGroups: [''], resources: ['configmaps', 'secrets', 'serviceaccounts', 'services'], verbs: ['get', 'create', 'patch'] },
        { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'create', 'patch'] },
        { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings'], verbs: ['get', 'create', 'patch'] },
        { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['get', 'create', 'patch'] },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: 'nanoclaw-workspace-installer', namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'nanoclaw-workspace-installer' },
      subjects: [parentSubject],
    },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: WORKSPACE_CONTROLLER_NAME, namespace }, automountServiceAccountToken: true },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: WORKSPACE_CONTROLLER_NAME, namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'nanoclaw-workspace-controller' },
      subjects: [controllerSubject],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: WORKSPACE_CONTROLLER_NAME, namespace: instanceNamespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'nanoclaw-workspace-agent-fence' },
      subjects: [controllerSubject],
    },
    {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: WORKSPACE_TOKEN_NAME, namespace },
      type: 'Opaque', stringData: { token: state.workspaceControllerToken },
    },
    {
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nanoclaw-workspace-storage', namespace },
      data: {
        NANOCLAW_WORKSPACE_S3_BUCKET: storage.bucket,
        NANOCLAW_WORKSPACE_S3_ENDPOINT: storage.endpoint,
        NANOCLAW_WORKSPACE_S3_PREFIX: storage.prefix,
        NANOCLAW_WORKSPACE_S3_REGION: storage.region,
      },
    },
    {
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: WORKSPACE_TRUST_NAME, namespace },
      data: { 'proxy-ca.pem': state.proxyCa },
    },
    {
      apiVersion: 'v1', kind: 'Service', metadata: { name: WORKSPACE_CONTROLLER_NAME, namespace, labels: controllerLabels },
      spec: { selector: controllerLabels, ports: [{ name: 'http', port: WORKSPACE_CONTROLLER_PORT, targetPort: 'http' }] },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: WORKSPACE_CONTROLLER_NAME, namespace, labels: controllerLabels },
      spec: {
        replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: controllerLabels },
        template: { metadata: { labels: controllerLabels }, spec: {
          serviceAccountName: WORKSPACE_CONTROLLER_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          nodeSelector: { 'nanoco.ai/workspace-nvme': 'true' },
          securityContext: { runAsUser: 501, runAsGroup: 1000, runAsNonRoot: true, fsGroup: 1000 },
          containers: [{
            name: 'controller', image, imagePullPolicy: 'IfNotPresent',
            command: ['node', '/opt/nanoclaw/host/dist/storage/workspace-controller.js'],
            envFrom: [{ configMapRef: { name: 'nanoclaw-workspace-storage' } }],
            env: [
              { name: 'NANOCO_WORKSPACE_NAMESPACE', value: namespace },
              { name: 'NANOCLAW_POD_NAMESPACE', value: instanceNamespace },
              { name: 'NANOCO_WORKSPACE_HOST_ROOT', value: WORKSPACE_HOST_ROOT },
              { name: 'NANOCO_WORKSPACE_IMAGE', value: image },
              { name: 'NANOCO_HOST_SOURCE_ROOT', value: '/opt/nanoclaw/host' },
              { name: 'NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE', value: '/run/nanoco/controller/token' },
              { name: 'NANOCO_WORKSPACE_RUN_AS_UID', value: '501' },
              { name: 'NANOCO_WORKSPACE_RUN_AS_GID', value: '1000' },
              { name: 'NANOCO_WORKSPACE_DISABLE_IMDS', value: '1' },
              { name: 'NANOCLAW_WORKSPACE_S3_TRANSPORT', value: 'gateway' },
              { name: 'NANOCLAW_MAILBOX_GATEWAY_PROXY', value: `http://${state.serviceIp}:${RELAY_PORT}` },
              { name: 'NANOCLAW_MAILBOX_GATEWAY_CA', value: `${TRUST_DIR}/proxy-ca.pem` },
              { name: 'NANOCLAW_STORAGE_CAPABILITY', value: state.requestCapability },
              { name: 'NANOCO_WORKSPACE_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
            ],
            ports: [{ name: 'http', containerPort: WORKSPACE_CONTROLLER_PORT }],
            readinessProbe: { httpGet: { path: '/ready', port: 'http' }, periodSeconds: 2, failureThreshold: 30 },
            resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { memory: '256Mi' } },
            securityContext: {
              allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' },
            },
            volumeMounts: [
              { name: 'token', mountPath: '/run/nanoco/controller', readOnly: true },
              { name: 'gateway-trust', mountPath: TRUST_DIR, readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
            ],
          }],
          volumes: [
            { name: 'token', secret: { secretName: WORKSPACE_TOKEN_NAME, defaultMode: 0o400 } },
            { name: 'gateway-trust', configMap: { name: WORKSPACE_TRUST_NAME, defaultMode: 0o444 } },
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
          ],
        } },
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: `${WORKSPACE_CONTROLLER_NAME}-ingress`, namespace },
      spec: { podSelector: { matchLabels: controllerLabels }, policyTypes: ['Ingress'], ingress: [{
        from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': instanceNamespace } }, podSelector: { matchLabels: { app: 'nanoclaw-host' } } }],
        ports: [{ protocol: 'TCP', port: WORKSPACE_CONTROLLER_PORT }],
      }] },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: 'nanoclaw-workspace-custodian', namespace },
      spec: {
        podSelector: { matchLabels: custodianLabels }, policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [{ podSelector: { matchLabels: controllerLabels } }], ports: [{ protocol: 'TCP', port: 8788 }] }],
        egress: [
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': instanceNamespace } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': RELAY_NAME } } }], ports: [{ protocol: 'TCP', port: RELAY_PORT }] },
        ],
      },
    },
  ];
  return docs.map((doc) => JSON.stringify(doc)).join('\n---\n');
}

function parentRelayManifests(
  context: K8sInstanceRelayContext,
  channel: ProvisionedSessionChannel,
  options: RelayOptions,
): string {
  const gatewayPort = endpointPort(options.gatewayAddress);
  const labels = { 'app.kubernetes.io/name': RELAY_NAME, 'nanoco.dev/instance': context.instanceId };
  const material = channel.materials;
  const secret = {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: RELAY_NAME, namespace: context.namespace, labels },
    type: 'Opaque',
    stringData: {
      'gateway-ca.pem': fs.readFileSync(material.gatewayCaPath(), 'utf8'),
      'session-cert.pem': fs.readFileSync(material.clientCertificatePath(), 'utf8'),
      'session-key.pem': fs.readFileSync(material.clientPrivateKeyPath(), 'utf8'),
    },
  };
  const deployment = {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: RELAY_NAME, namespace: context.namespace, labels },
    spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false, terminationGracePeriodSeconds: 10,
          securityContext: { runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true, fsGroup: 65532 },
          containers: [{
            name: 'relay', image: options.sidecarImage, imagePullPolicy: 'IfNotPresent',
            env: [
              { name: 'NANOCO_SIDECAR_LISTEN_ADDR', value: `0.0.0.0:${RELAY_PORT}` },
              { name: 'NANOCO_SIDECAR_GATEWAY_ADDR', value: options.gatewayAddress },
              { name: 'NANOCO_SIDECAR_GATEWAY_SERVER_NAME', value: options.gatewayServerName },
              { name: 'NANOCO_SIDECAR_GATEWAY_CA', value: '/run/nanoco/gateway-ca.pem' },
              { name: 'NANOCO_SIDECAR_CLIENT_CERT', value: '/run/nanoco/session-cert.pem' },
              { name: 'NANOCO_SIDECAR_CLIENT_KEY', value: '/run/nanoco/session-key.pem' },
            ],
            ports: [{ name: 'proxy', containerPort: RELAY_PORT, protocol: 'TCP' }],
            readinessProbe: { tcpSocket: { port: 'proxy' }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 3 },
            resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { memory: '128Mi' } },
            securityContext: {
              allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' },
            },
            volumeMounts: [{ name: 'identity', mountPath: '/run/nanoco', readOnly: true }],
          }],
          volumes: [{ name: 'identity', secret: { secretName: RELAY_NAME, defaultMode: 0o400 } }],
        },
      },
    },
  };
  const service = {
    apiVersion: 'v1', kind: 'Service', metadata: { name: RELAY_NAME, namespace: context.namespace, labels },
    spec: { selector: labels, ports: [{ name: 'proxy', port: RELAY_PORT, targetPort: 'proxy', protocol: 'TCP' }] },
  };
  const egress = {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: `${RELAY_NAME}-egress`, namespace: context.namespace, labels },
    spec: {
      podSelector: { matchLabels: labels }, policyTypes: ['Egress'],
      egress: [
        {
          // The relay dials a Service DNS name. Keep this DNS hole beside the
          // gateway allow-rule; without it the denied lookup surfaces as a
          // misleading connection refusal against Gateway.
          to: [{
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          }],
          ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
        },
        {
          to: [{
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': options.parentSystemNamespace } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'gateway' } },
          }],
          ports: [{ protocol: 'TCP', port: gatewayPort }],
        },
      ],
    },
  };
  return [secret, deployment, service, egress].map((doc) => JSON.stringify(doc)).join('\n---\n');
}

function edgeBridgeManifests(
  context: K8sInstanceRelayContext,
  cluster: K8sInstanceRelayCluster,
  edge: EdgeOptions,
): string | null {
  const secretData = cluster.secretData;
  if (!secretData) return null;
  const backlotCa = secretData(context.namespace, 'gateway-pki-x-system-x-vc', 'upstream-ca.pem');
  const governanceCa = secretData(
    context.namespace,
    'gateway-identity-x-system-x-vc',
    'governance-identity-ca.pem',
  );
  if (!backlotCa || !governanceCa) return null;
  for (const [name, pem] of [['Backlot', backlotCa], ['Governance', governanceCa]] as const) {
    if (!/^-----BEGIN CERTIFICATE-----\n/.test(pem)) throw new Error(`${name} edge CA is not a PEM certificate`);
  }
  const labels = {
    app: EDGE_NAME,
    'nanoco.dev/trust-boundary': 'edge',
    'nanoco.dev/env-id': context.envId,
  };
  const script = `
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const namespace = process.env.INSTANCE_NAMESPACE;
const domain = process.env.EDGE_DOMAIN;
const actor = process.env.GOVERNANCE_ACTOR;
const listenPort = Number(process.env.LISTEN_PORT);
const targets = new Map([
  [\`slack-\${namespace}.\${domain}\`, {
    host: \`backlot-x-system-x-vc.\${namespace}.svc.cluster.local\`, port: 9081,
    servername: 'backlot.system.svc.cluster.local', ca: '/edge/backlot-ca.pem', actor: null,
  }],
  [\`governance-\${namespace}.\${domain}\`, {
    host: \`governance-x-nanoclaw-x-vc.\${namespace}.svc.cluster.local\`, port: 10255,
    servername: 'governance.nanoclaw.svc.cluster.local', ca: '/edge/governance-ca.pem', actor,
  }],
]);

const refuse = (socket, status, text) => socket.end(
  \`HTTP/1.1 \${status} \${text}\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n\`,
);

const targetFor = (host) => targets.get((host ?? '').split(':', 1)[0].toLowerCase());
const headersFor = (headers, target, upgrade = false) => {
  const forwarded = { ...headers };
  delete forwarded['x-forwarded-email'];
  delete forwarded['proxy-connection'];
  if (!upgrade) forwarded.connection = 'close';
  if (target.actor) forwarded['x-forwarded-email'] = target.actor;
  return forwarded;
};

const server = http.createServer((req, res) => {
  if ((req.url ?? '').split('?', 1)[0] === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
    res.end('ok');
    return;
  }
  const target = targetFor(req.headers.host);
  if (!target) { res.writeHead(404); res.end(); return; }
  const upstream = https.request({
    host: target.host,
    port: target.port,
    servername: target.servername,
    ca: fs.readFileSync(target.ca),
    rejectUnauthorized: true,
    agent: false,
    method: req.method,
    path: req.url,
    headers: headersFor(req.headers, target),
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, downstream, head) => {
  const target = targetFor(req.headers.host);
  if (!target) { refuse(downstream, 404, 'Not Found'); return; }
  const headers = headersFor(req.headers, target, true);
  const upstream = tls.connect({
    host: target.host,
    port: target.port,
    servername: target.servername,
    ca: fs.readFileSync(target.ca),
    rejectUnauthorized: true,
  });
  upstream.once('secureConnect', () => {
    const headerLines = [];
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) headerLines.push(name + ': ' + item);
      }
    }
    upstream.write(
      (req.method ?? 'GET') + ' ' + (req.url ?? '/') + ' HTTP/' + req.httpVersion + '\\r\\n' +
      headerLines.join('\\r\\n') + '\\r\\n\\r\\n',
      'latin1',
    );
    if (head.length) upstream.write(head);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  upstream.on('error', () => refuse(downstream, 502, 'Bad Gateway'));
  downstream.on('error', () => upstream.destroy());
});

server.listen(listenPort, '0.0.0.0');
`;
  const edgeConfigSha256 = createHash('sha256')
    .update(script)
    .update('\0')
    .update(backlotCa)
    .update('\0')
    .update(governanceCa)
    .digest('hex');
  const docs: Array<Record<string, unknown>> = [
    {
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: EDGE_NAME, namespace: context.namespace, labels },
      data: { 'proxy.mjs': script, 'backlot-ca.pem': backlotCa, 'governance-ca.pem': governanceCa },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: EDGE_NAME, namespace: context.namespace, labels },
      spec: {
        replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels },
        template: {
          metadata: { labels, annotations: { 'nanoco.dev/edge-config-sha256': edgeConfigSha256 } },
          spec: {
            automountServiceAccountToken: false,
            runtimeClassName: EDGE_RUNTIME_CLASS,
            securityContext: { runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true },
            containers: [{
              name: 'edge', image: edge.proxyImage, imagePullPolicy: 'IfNotPresent',
              command: ['node', '/edge/proxy.mjs'],
              env: [
                { name: 'INSTANCE_NAMESPACE', value: context.namespace },
                { name: 'EDGE_DOMAIN', value: edge.domain },
                { name: 'GOVERNANCE_ACTOR', value: edge.actor },
                { name: 'LISTEN_PORT', value: String(EDGE_PORT) },
              ],
              ports: [{ name: 'http', containerPort: EDGE_PORT, protocol: 'TCP' }],
              readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 2, failureThreshold: 30 },
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
              securityContext: {
                allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' },
              },
              volumeMounts: [{ name: 'edge', mountPath: '/edge', readOnly: true }],
            }],
            volumes: [{ name: 'edge', configMap: { name: EDGE_NAME, defaultMode: 0o444 } }],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service', metadata: { name: EDGE_NAME, namespace: context.namespace, labels },
      spec: { selector: labels, ports: [{ name: 'http', port: EDGE_PORT, targetPort: 'http', protocol: 'TCP' }] },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: EDGE_NAME, namespace: context.namespace, labels },
      spec: {
        podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
        ingress: [{
          from: [{
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'system' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'nanoco-dev-env-edge-router' } },
          }],
          ports: [{ protocol: 'TCP', port: EDGE_PORT }],
        }],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
            ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
          },
          {
            to: [{ podSelector: { matchLabels: { app: 'backlot', 'nanoco.dev/trust-boundary': 'control' } } }],
            ports: [{ protocol: 'TCP', port: 9081 }],
          },
          {
            to: [{ podSelector: { matchLabels: { app: 'governance', 'nanoco.dev/trust-boundary': 'control' } } }],
            ports: [{ protocol: 'TCP', port: 10255 }],
          },
        ],
      },
    },
  ];
  return docs.map((doc) => JSON.stringify(doc)).join('\n---\n');
}

function endpointPort(address: string): number {
  const match = address.match(/:(\d{1,5})$/);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Parent Gateway address has no valid port');
  }
  return port;
}

function parseJsonDocuments(manifests: string): Array<Record<string, any>> {
  try {
    return manifests.split(/\n---\n/).filter((doc) => doc.trim()).map((doc) => JSON.parse(doc));
  } catch {
    throw new Error('governed child manifests are not a JSON document stream');
  }
}

function upsertNamed(current: unknown, additions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const rows = Array.isArray(current) ? current.filter((row) => row && typeof row === 'object') : [];
  const names = new Set(additions.map((row) => row.name));
  return [...rows.filter((row) => !names.has((row as Record<string, unknown>).name)), ...additions] as Array<Record<string, unknown>>;
}

function removeNamed(current: unknown, names: string[]): Array<Record<string, unknown>> {
  const rows = Array.isArray(current) ? current.filter((row) => row && typeof row === 'object') : [];
  const removed = new Set(names);
  return rows.filter((row) => !removed.has(String((row as Record<string, unknown>).name ?? ''))) as Array<Record<string, unknown>>;
}

function envLiteral(current: unknown, name: string): string {
  const rows = Array.isArray(current) ? current : [];
  const entry = rows.find((row) => row && typeof row === 'object' && row.name === name);
  const value = entry && typeof entry.value === 'string' ? entry.value.trim() : '';
  if (!value) throw new Error(`governed child Host has no literal ${name}`);
  return value;
}

function childMailboxPrefix(current: unknown, instanceNamespace: string, relaySessionId: string): string {
  const rows = Array.isArray(current) ? current : [];
  const entry = rows.find((row) => row && typeof row === 'object' && row.name === 'NANOCLAW_MAILBOX_S3_PREFIX');
  const value = entry && typeof entry.value === 'string' ? entry.value : '';
  const suffix = `/children/${instanceNamespace}`;
  if (!value.endsWith(suffix)) throw new Error('real-S3 child mailbox prefix is not instance-scoped');
  return `${value.slice(0, -suffix.length)}/children/${relaySessionId}`;
}

function childWorkspacePrefix(current: unknown, instanceNamespace: string, relaySessionId: string): string {
  const rows = Array.isArray(current) ? current : [];
  const entry = rows.find((row) => row && typeof row === 'object' && row.name === 'NANOCLAW_WORKSPACE_S3_PREFIX');
  const value = entry && typeof entry.value === 'string' ? entry.value : '';
  const suffix = `/children/${instanceNamespace}`;
  if (!value.endsWith(suffix)) throw new Error('real-S3 child workspace prefix is not instance-scoped');
  return `${value.slice(0, -suffix.length)}/children/${relaySessionId}`;
}
