/** Kubernetes Job realization of the SessionDriver contract. */
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';

import { JsonDocumentStream } from './json-stream.js';
import { registerSessionDriver } from './driver-registry.js';
import {
  LABELS,
  asFailureError,
  labelsForKey,
  specInvalid,
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type MountPolicy,
  type MountSpec,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const WATCH_RETRY_MS = 1_000;

interface ObjectMeta {
  name?: string;
  labels?: Record<string, string>;
  resourceVersion?: string;
}

interface KubernetesJob {
  metadata?: ObjectMeta;
  spec?: { suspend?: boolean; template?: { spec?: { terminationGracePeriodSeconds?: number } } };
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  };
}

interface KubernetesList {
  items?: KubernetesJob[];
  metadata?: { resourceVersion?: string };
}

interface KubernetesWatchEvent {
  type?: string;
  object?: KubernetesJob & { code?: number };
}

export interface KubernetesApi {
  request(method: string, apiPath: string, body?: unknown, contentType?: string): Promise<unknown>;
  watch(apiPath: string, signal: AbortSignal, onEvent: (event: unknown) => void): Promise<void>;
}

export class KubernetesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class InClusterKubernetesApi implements KubernetesApi {
  readonly #baseUrl: string;

  constructor(
    host = process.env.KUBERNETES_SERVICE_HOST,
    port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443',
    private readonly tokenPath = TOKEN_PATH,
    private readonly caPath = CA_PATH,
  ) {
    if (!host) throw new Error('KUBERNETES_SERVICE_HOST is missing; the Kubernetes driver is in-cluster only');
    this.#baseUrl = `https://${host}:${port}`;
  }

  async request(method: string, apiPath: string, body?: unknown, contentType = 'application/json'): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.#open(method, apiPath, controller.signal, body, contentType);
      const raw = await readResponse(response);
      if (!ok(response)) throw new KubernetesApiError(response.statusCode ?? 0, kubernetesError(response, raw));
      return response.statusCode === 204 || !raw ? null : JSON.parse(raw);
    } finally {
      clearTimeout(timeout);
    }
  }

  async watch(apiPath: string, signal: AbortSignal, onEvent: (event: unknown) => void): Promise<void> {
    const response = await this.#open('GET', apiPath, signal);
    if (!ok(response)) throw new KubernetesApiError(response.statusCode ?? 0, kubernetesError(response));
    const decoder = new TextDecoder();
    const documents = new JsonDocumentStream();
    for await (const chunk of response) {
      for (const document of documents.push(decoder.decode(chunk as Buffer, { stream: true }))) onEvent(document);
    }
  }

  #open(
    method: string,
    apiPath: string,
    signal: AbortSignal,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<IncomingMessage> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        `${this.#baseUrl}${apiPath}`,
        {
          method,
          signal,
          ca: fs.readFileSync(this.caPath),
          headers: {
            Authorization: `Bearer ${fs.readFileSync(this.tokenPath, 'utf8').trim()}`,
            Accept: 'application/json',
            ...(serialized === undefined
              ? {}
              : { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(serialized) }),
          },
        },
        resolve,
      );
      request.on('error', reject);
      request.end(serialized);
    });
  }
}

function readResponse(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });
}

function ok(response: IncomingMessage): boolean {
  return (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300;
}

/* eslint-disable no-catch-all/no-catch-all -- non-JSON API error bodies use a safe status fallback */
function kubernetesError(response: IncomingMessage, raw = ''): string {
  try {
    const status = JSON.parse(raw) as { message?: unknown };
    if (typeof status.message === 'string') return status.message;
  } catch (_error) {
    // Kubernetes may return an empty or non-JSON body through an intermediary.
  }
  return `Kubernetes API returned ${response.statusCode ?? 0}`;
}
/* eslint-enable no-catch-all/no-catch-all */

export interface KubernetesPersistentVolumeMount {
  hostRoot: string;
  claimName: string;
  claimSubPath: string;
}

export interface KubernetesBakedSurface {
  hostRoot: string;
  containerRoot: string;
}

export interface KubernetesDriverOptions extends MountPolicy {
  namespace: string;
  serviceAccountName?: string;
  /** Pin sessions to this node; only for RWO state volumes. Prefer an RWX state class. */
  nodeName?: string;
  /** Service DNS name the session's networkAccess endpoint resolves to (the --add-host equivalent). */
  gatewayHost?: string;
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  persistentVolumeMounts: KubernetesPersistentVolumeMount[];
  bakedSurfaces: KubernetesBakedSurface[];
  api?: KubernetesApi;
}

interface DriverWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  controller: AbortController;
}

export class KubernetesSessionDriver implements SessionDriver {
  readonly kind = 'kubernetes';
  readonly #api: KubernetesApi;
  readonly #policy: MountPolicy;
  readonly #watches = new Map<string, DriverWatch>();

  constructor(private readonly opts: KubernetesDriverOptions) {
    this.#api = opts.api ?? new InClusterKubernetesApi();
    this.#policy = opts;
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      unrealized: ['pidsLimit'],
      sharedNetworkNamespace: true,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    try {
      await this.#api.request('GET', '/version');
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    if (spec.containers.length !== 1) {
      throw specInvalid('Kubernetes Jobs support exactly one agent container');
    }
    const name = kubernetesJobName(spec.key);
    const existing = await this.#getJob(name);
    if (existing) {
      assertJobIdentity(existing, spec.key);
      return new KubernetesHandle(spec.key, name, this.opts.namespace, this.#api, spec.stopGraceSeconds);
    }
    try {
      const gatewayIp = this.opts.gatewayHost ? (await dns.lookup(this.opts.gatewayHost)).address : undefined;
      await this.#api.request('POST', this.#jobsPath(), kubernetesJobForSession(spec, name, this.opts, gatewayIp));
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
    return new KubernetesHandle(spec.key, name, this.opts.namespace, this.#api, spec.stopGraceSeconds);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    try {
      const list = (await this.#api.request(
        'GET',
        `${this.#jobsPath()}?labelSelector=${encodeURIComponent(`${LABELS.install}=${installSlug}`)}`,
      )) as KubernetesList;
      return (list.items ?? []).flatMap((job) => {
        const key = keyFromJob(job);
        const name = job.metadata?.name;
        if (!key || !name) return [];
        const { phase, failure } = jobSnapshot(job);
        return [
          {
            handle: new KubernetesHandle(
              key,
              name,
              this.opts.namespace,
              this.#api,
              job.spec?.template?.spec?.terminationGracePeriodSeconds ?? 30,
            ),
            phase,
            ...(failure ? { failure } : {}),
          },
        ];
      });
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let state = this.#watches.get(installSlug);
    if (!state) {
      state = { subscribers: new Set(), controller: new AbortController() };
      this.#watches.set(installSlug, state);
      void this.#runWatch(installSlug, state);
    }
    state.subscribers.add(onEvent);
    return {
      stop: () => {
        state!.subscribers.delete(onEvent);
        if (state!.subscribers.size === 0) {
          state!.controller.abort();
          this.#watches.delete(installSlug);
        }
      },
    };
  }

  async reapResidue(installSlug: string): Promise<void> {
    const sessions = await this.listSessions(installSlug);
    await Promise.all(
      sessions.filter((session) => session.phase === 'terminal').map((session) => session.handle.stop('reap')),
    );
  }

  #jobsPath(): string {
    return `/apis/batch/v1/namespaces/${encodeURIComponent(this.opts.namespace)}/jobs`;
  }

  async #getJob(name: string): Promise<KubernetesJob | null> {
    try {
      return (await this.#api.request('GET', `${this.#jobsPath()}/${encodeURIComponent(name)}`)) as KubernetesJob;
    } catch (error) {
      if (error instanceof KubernetesApiError && error.status === 404) return null;
      throw normalizeKubernetesError(error);
    }
  }

  async #runWatch(installSlug: string, state: DriverWatch): Promise<void> {
    const selector = encodeURIComponent(`${LABELS.install}=${installSlug}`);
    while (!state.controller.signal.aborted) {
      try {
        const list = (await this.#api.request(
          'GET',
          `${this.#jobsPath()}?labelSelector=${selector}`,
        )) as KubernetesList;
        const resourceVersion = list.metadata?.resourceVersion ?? '0';
        await this.#api.watch(
          `${this.#jobsPath()}?watch=1&allowWatchBookmarks=true&resourceVersion=${encodeURIComponent(resourceVersion)}&labelSelector=${selector}`,
          state.controller.signal,
          (raw) => {
            const event = sessionEvent(raw, installSlug);
            if (event) for (const subscriber of state.subscribers) subscriber(event);
          },
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- watches reconnect after transport failures
      } catch (error) {
        if (state.controller.signal.aborted) return;
        if (!(error instanceof KubernetesApiError && error.status === 410)) await delay(WATCH_RETRY_MS);
      }
    }
  }
}

class KubernetesHandle implements SessionHandle {
  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly namespace: string,
    private readonly api: KubernetesApi,
    private readonly stopGraceSeconds: number,
  ) {}

  async start(): Promise<void> {
    try {
      await this.api.request(
        'PATCH',
        `${this.#path()}?fieldManager=nanoclaw-session-driver`,
        { spec: { suspend: false } },
        'application/merge-patch+json',
      );
    } catch (error) {
      throw normalizeKubernetesError(error);
    }
  }

  async status(): Promise<SessionStatus> {
    try {
      const job = (await this.api.request('GET', this.#path())) as KubernetesJob;
      return jobStatus(job);
    } catch (error) {
      if (error instanceof KubernetesApiError && error.status === 404) return { phase: 'stopped' };
      throw normalizeKubernetesError(error);
    }
  }

  async stop(_reason: string): Promise<void> {
    try {
      await this.api.request('DELETE', this.#path(), {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        gracePeriodSeconds: this.stopGraceSeconds,
        propagationPolicy: 'Foreground',
      });
    } catch (error) {
      if (!(error instanceof KubernetesApiError && error.status === 404)) throw normalizeKubernetesError(error);
    }
  }

  execSpec(command: string[]): SessionExecSpec {
    const base = ['-n', this.namespace, 'exec'];
    return {
      bin: 'kubectl',
      argsTty: [...base, '-it', `job/${this.name}`, '--', ...command],
      argsPlain: [...base, '-i', `job/${this.name}`, '--', ...command],
    };
  }

  #path(): string {
    return `/apis/batch/v1/namespaces/${encodeURIComponent(this.namespace)}/jobs/${encodeURIComponent(this.name)}`;
  }
}

export function kubernetesJobForSession(
  spec: SessionSpec,
  name: string,
  options: KubernetesDriverOptions,
  gatewayIp?: string,
): Record<string, unknown> {
  const labels = kubernetesLabels(labelsForKey(spec.key, 'agent', spec.labels));
  const volumes: Array<Record<string, unknown>> = [];
  const claims = new Map<string, string>();
  const containers = spec.containers.map((container, index) => {
    const volumeMounts: Array<Record<string, unknown>> = container.mounts.flatMap((mount) => {
      const source = resolveMount(mount, options);
      if (source === 'baked') return [];
      let volumeName = claims.get(source.claimName);
      if (!volumeName) {
        volumeName = `state-${claims.size}`;
        claims.set(source.claimName, volumeName);
        volumes.push({ name: volumeName, persistentVolumeClaim: { claimName: source.claimName } });
      }
      return [
        {
          name: volumeName,
          mountPath: mount.containerPath,
          subPath: source.claimSubPath,
          readOnly: mount.mode === 'ro',
        },
      ];
    });
    if (spec.resources.shmSizeMb) {
      if (container.mounts.some((mount) => mount.containerPath === '/dev/shm')) {
        throw specInvalid(`${container.role} already mounts /dev/shm`);
      }
      const shmName = `shm-${index}`;
      volumes.push({ name: shmName, emptyDir: { medium: 'Memory', sizeLimit: `${spec.resources.shmSizeMb}Mi` } });
      volumeMounts.push({ name: shmName, mountPath: '/dev/shm' });
    }
    return podContainer(container, spec, volumeMounts, options.imagePullPolicy ?? 'IfNotPresent');
  });
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: options.namespace, labels },
    spec: {
      suspend: true,
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
          ...(options.nodeName
            ? {
                affinity: {
                  nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                      nodeSelectorTerms: [
                        { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [options.nodeName] }] },
                      ],
                    },
                  },
                },
              }
            : {}),
          ...(gatewayIp && spec.networkAccess.target.kind !== 'session-container'
            ? { hostAliases: [{ ip: gatewayIp, hostnames: [spec.networkAccess.endpoint] }] }
            : {}),
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: spec.stopGraceSeconds,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            ...(spec.runAs ? { runAsUser: spec.runAs.uid, runAsGroup: spec.runAs.gid, fsGroup: spec.runAs.gid, fsGroupChangePolicy: 'OnRootMismatch' } : {}),
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers,
          volumes,
        },
      },
    },
  };
}

function podContainer(
  container: ContainerSpec,
  spec: SessionSpec,
  volumeMounts: Array<Record<string, unknown>>,
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never',
): Record<string, unknown> {
  const env = Object.entries({ ...container.env, ...(container.contributedEnv ?? {}) }).map(([name, value]) => ({
    name,
    value,
  }));
  return {
    name: dnsLabel(container.role),
    image: container.image,
    imagePullPolicy,
    ...(container.command ? { command: container.command } : {}),
    ...(container.args ? { args: container.args } : {}),
    env,
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: container.role !== 'agent',
      capabilities: { drop: ['ALL'] },
    },
    resources: {
      requests: resourceRequirements(spec),
      limits: resourceRequirements(spec),
    },
    volumeMounts,
  };
}

function resourceRequirements(spec: SessionSpec): Record<string, string> {
  return {
    ...(spec.resources.cpus ? { cpu: spec.resources.cpus } : {}),
    ...(spec.resources.memoryMb ? { memory: `${spec.resources.memoryMb}Mi` } : {}),
  };
}

function resolveMount(
  mount: MountSpec,
  options: KubernetesDriverOptions,
): { claimName: string; claimSubPath: string } | 'baked' {
  for (const root of options.persistentVolumeMounts) {
    const relative = relativeUnder(root.hostRoot, mount.hostPath);
    if (relative !== null) {
      return { claimName: root.claimName, claimSubPath: path.posix.join(root.claimSubPath, relative) };
    }
  }
  for (const surface of options.bakedSurfaces) {
    const relative = relativeUnder(surface.hostRoot, mount.hostPath);
    if (relative !== null && path.posix.join(surface.containerRoot, relative) === mount.containerPath) return 'baked';
  }
  throw specInvalid(`Kubernetes driver has no PVC or baked-image realization for mount ${mount.hostPath}`);
}

function relativeUnder(root: string, candidate: string): string | null {
  const relative = path.posix.relative(root, candidate);
  return !relative ? '.' : relative.startsWith('../') || path.posix.isAbsolute(relative) ? null : relative;
}

function kubernetesLabels(labels: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(labels)) {
    if (!/^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(key)) {
      throw specInvalid(`label key '${key}' is not Kubernetes-compatible`);
    }
    if (value.length > 63 || !/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(value)) {
      throw specInvalid(`label value for '${key}' is not Kubernetes-compatible`);
    }
  }
  return labels;
}

function assertJobIdentity(job: KubernetesJob, key: SessionKey): void {
  const labels = job.metadata?.labels ?? {};
  if (
    labels[LABELS.install] !== key.installSlug ||
    labels[LABELS.group] !== key.agentGroupId ||
    labels[LABELS.session] !== key.sessionId
  ) {
    throw asFailureError({
      kind: 'unknown',
      retryable: false,
      opaqueRef: `job-name-collision-${job.metadata?.name ?? 'unknown'}`,
    });
  }
}

function keyFromJob(job: KubernetesJob): SessionKey | null {
  const labels = job.metadata?.labels ?? {};
  const installSlug = labels[LABELS.install];
  const agentGroupId = labels[LABELS.group];
  const sessionId = labels[LABELS.session];
  return installSlug && agentGroupId && sessionId ? { installSlug, agentGroupId, sessionId } : null;
}

function jobStatus(job: KubernetesJob): SessionStatus {
  if (job.spec?.suspend) return { phase: 'ready' };
  if ((job.status?.active ?? 0) > 0) return { phase: 'running' };
  if ((job.status?.failed ?? 0) > 0 || condition(job, 'Failed')) {
    return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false } };
  }
  if ((job.status?.succeeded ?? 0) > 0 || condition(job, 'Complete')) return { phase: 'stopped' };
  return { phase: 'preparing' };
}

function jobSnapshot(job: KubernetesJob): { phase: 'starting' | 'running' | 'terminal'; failure?: SessionFailure } {
  if (job.spec?.suspend) return { phase: 'starting' };
  if ((job.status?.active ?? 0) > 0) return { phase: 'running' };
  if ((job.status?.failed ?? 0) > 0 || condition(job, 'Failed')) {
    return { phase: 'terminal', failure: { kind: 'started-then-died', retryable: false } };
  }
  if ((job.status?.succeeded ?? 0) > 0 || condition(job, 'Complete')) return { phase: 'terminal' };
  return { phase: 'starting' };
}

function condition(job: KubernetesJob, type: string): boolean {
  return Boolean(job.status?.conditions?.some((item) => item.type === type && item.status === 'True'));
}

function sessionEvent(raw: unknown, installSlug: string): SessionEvent | null {
  const event = raw as KubernetesWatchEvent;
  if (event.type === 'BOOKMARK' || event.type === 'ERROR') return null;
  const key = keyFromJob(event.object ?? {});
  if (!key || key.installSlug !== installSlug) return null;
  const terminal = event.type === 'DELETED' || jobSnapshot(event.object ?? {}).phase === 'terminal';
  return { key, kind: terminal ? 'terminal' : 'phase' };
}

export function kubernetesJobName(key: SessionKey): string {
  const raw = `ncl-${key.installSlug}-${key.sessionId}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
  const normalized = raw.replaceAll(/-+/g, '-').replace(/^-|-$/g, '') || 'ncl-session';
  if (normalized.length <= 63) return normalized;
  const hash = createHash('sha256').update(`${key.installSlug}\u0000${key.sessionId}`).digest('hex').slice(0, 8);
  return `${normalized.slice(0, 54).replace(/-$/g, '')}-${hash}`;
}

function dnsLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw specInvalid(`container role '${value}' cannot form a Kubernetes container name`);
  if (normalized.length <= 63) return normalized;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${normalized.slice(0, 54).replace(/-$/g, '')}-${hash}`;
}

function normalizeKubernetesError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/manifest unknown|image.*not found|errimagepull|imagepullbackoff/i.test(message)) {
    return asFailureError({ kind: 'image-unavailable', retryable: true });
  }
  if (!(error instanceof KubernetesApiError)) {
    return asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }
  if (error.status === 401 || error.status === 403) {
    return asFailureError({ kind: 'denied-by-policy', retryable: false, detail: 'Kubernetes API denied the request' });
  }
  if (error.status === 422) return specInvalid('Kubernetes API rejected the Job manifest');
  if (error.status === 429 || /quota|insufficient|exceeded/i.test(message))
    return asFailureError({ kind: 'resources-exhausted', retryable: true });
  if (error.status >= 500) return asFailureError({ kind: 'runtime-unavailable', retryable: true });
  return asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `kubernetes-http-${error.status}` });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface KubernetesMountConfiguration {
  persistentVolumeMounts?: KubernetesPersistentVolumeMount[];
  bakedSurfaces?: KubernetesBakedSurface[];
}

export function kubernetesOptionsFromEnvironment(
  policy: MountPolicy,
  env: NodeJS.ProcessEnv = process.env,
): KubernetesDriverOptions {
  const configured = parseMountConfiguration(env.NANOCLAW_KUBERNETES_MOUNTS);
  const imagePullPolicy = env.NANOCLAW_KUBERNETES_IMAGE_PULL_POLICY || 'IfNotPresent';
  if (!['Always', 'IfNotPresent', 'Never'].includes(imagePullPolicy)) {
    throw new Error('NANOCLAW_KUBERNETES_IMAGE_PULL_POLICY must be Always, IfNotPresent, or Never');
  }
  const namespace = env.NANOCLAW_KUBERNETES_NAMESPACE || currentNamespace();
  const serviceAccountName = env.NANOCLAW_KUBERNETES_SERVICE_ACCOUNT;
  const nodeName = env.NANOCLAW_KUBERNETES_NODE_NAME;
  const gatewayHost = env.NANOCLAW_KUBERNETES_GATEWAY_HOST;
  if (!dnsSubdomain(namespace)) throw new Error('NANOCLAW_KUBERNETES_NAMESPACE must be a DNS subdomain');
  if (gatewayHost && !dnsSubdomain(gatewayHost)) throw new Error('NANOCLAW_KUBERNETES_GATEWAY_HOST must be a DNS name');
  if (nodeName && !dnsSubdomain(nodeName)) throw new Error('NANOCLAW_KUBERNETES_NODE_NAME must be a DNS subdomain');
  if (serviceAccountName && !dnsSubdomain(serviceAccountName)) {
    throw new Error('NANOCLAW_KUBERNETES_SERVICE_ACCOUNT must be a DNS subdomain');
  }
  return {
    ...policy,
    namespace,
    ...(serviceAccountName ? { serviceAccountName } : {}),
    ...(nodeName ? { nodeName } : {}),
    ...(gatewayHost ? { gatewayHost } : {}),
    imagePullPolicy: imagePullPolicy as KubernetesDriverOptions['imagePullPolicy'],
    persistentVolumeMounts: configured.persistentVolumeMounts ?? [],
    bakedSurfaces: configured.bakedSurfaces ?? [],
  };
}

function parseMountConfiguration(raw: string | undefined): KubernetesMountConfiguration {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('NANOCLAW_KUBERNETES_MOUNTS must be valid JSON', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NANOCLAW_KUBERNETES_MOUNTS must be a JSON object');
  }
  const config = parsed as Record<string, unknown>;
  if (config.persistentVolumeMounts !== undefined && !Array.isArray(config.persistentVolumeMounts)) {
    throw new Error('NANOCLAW_KUBERNETES_MOUNTS persistentVolumeMounts must be an array');
  }
  if (config.bakedSurfaces !== undefined && !Array.isArray(config.bakedSurfaces)) {
    throw new Error('NANOCLAW_KUBERNETES_MOUNTS bakedSurfaces must be an array');
  }
  const persistentVolumeMounts = (config.persistentVolumeMounts ?? []) as KubernetesPersistentVolumeMount[];
  const bakedSurfaces = (config.bakedSurfaces ?? []) as KubernetesBakedSurface[];
  for (const mount of persistentVolumeMounts) {
    if (
      !mount ||
      typeof mount !== 'object' ||
      !absoluteCanonical(mount.hostRoot) ||
      !dnsSubdomain(mount.claimName) ||
      !relativeCanonical(mount.claimSubPath)
    ) {
      throw new Error('NANOCLAW_KUBERNETES_MOUNTS contains an invalid persistentVolumeMount');
    }
  }
  for (const surface of bakedSurfaces) {
    if (
      !surface ||
      typeof surface !== 'object' ||
      !absoluteCanonical(surface.hostRoot) ||
      !absoluteCanonical(surface.containerRoot)
    ) {
      throw new Error('NANOCLAW_KUBERNETES_MOUNTS contains an invalid bakedSurface');
    }
  }
  const roots = [...persistentVolumeMounts, ...bakedSurfaces].map((mapping) => mapping.hostRoot);
  if (
    roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && relativeUnder(root, other)))
  ) {
    throw new Error('NANOCLAW_KUBERNETES_MOUNTS host roots must not overlap');
  }
  return { persistentVolumeMounts, bakedSurfaces };
}

function absoluteCanonical(value: unknown): value is string {
  return typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
}

function relativeCanonical(value: unknown): value is string {
  return typeof value === 'string' && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
}

function dnsSubdomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value);
}

function currentNamespace(): string {
  try {
    return fs.readFileSync(NAMESPACE_PATH, 'utf8').trim() || 'default';
    // eslint-disable-next-line no-catch-all/no-catch-all -- outside a Pod, the Kubernetes default namespace is correct
  } catch (_error) {
    return 'default';
  }
}

registerSessionDriver('kubernetes', (policy) => new KubernetesSessionDriver(kubernetesOptionsFromEnvironment(policy)));
