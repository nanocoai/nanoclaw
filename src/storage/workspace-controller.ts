import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import {
  WORKSPACE_FINALIZER,
  WORKSPACE_GENERATION_LABEL,
  WORKSPACE_GROUP_ANNOTATION,
  WORKSPACE_GROUP_LABEL,
  WORKSPACE_LABEL,
  WORKSPACE_RECOVERY_ANNOTATION,
  WORKSPACE_SESSION_ANNOTATION,
  WORKSPACE_SESSION_LABEL,
  WORKSPACE_TIER_ANNOTATION,
  bearerMatches,
  labelId,
  validateWorkspacePaths,
  validateWorkspaceRelay,
  type WorkspaceAssignment,
  type WorkspaceRelay,
} from './workspace-plane.js';

type Json = Record<string, any>;
type Tier = 'container' | 'vm';
type EnsureRequest = { groupId: string; sessionId: string; runtimeTier: Tier; relay?: WorkspaceRelay };

const GROUP_LEASE_LABEL = 'nanoco.ai/workspace-group-lease';
const RESERVATION_LABEL = 'nanoco.ai/workspace-reservation';
const IDLE_MS = 5 * 60_000;
const RESERVATION_SECONDS = 300;
const CUSTODIAN_ATTEMPTS_ANNOTATION = 'nanoco.ai/workspace-custodian-attempts';
const CUSTODIAN_ATTEMPT_AT_ANNOTATION = 'nanoco.ai/workspace-custodian-attempt-at';
const CUSTODIAN_BACKOFF_BASE_MS = 15_000;
const CUSTODIAN_BACKOFF_MAX_MS = 15 * 60_000;
const CHECKPOINT_ATTEMPTS_ANNOTATION = 'nanoco.ai/workspace-checkpoint-attempts';
const CHECKPOINT_LOST_AT_ANNOTATION = 'nanoco.ai/workspace-checkpoint-lost-at';
const CHECKPOINT_LOST_REASON_ANNOTATION = 'nanoco.ai/workspace-checkpoint-lost-reason';
const CHECKPOINT_MAX_ATTEMPTS = 5;

/**
 * A Custodian generation is a RETRY COUNTER, so a group that can never succeed
 * burns one on every Host sweep, forever: a workspace whose Gateway policy
 * binding was missing walked from generation 20 to 51 within an hour, churning
 * a Pod, Service, token and relay Secret each time. Deleting the previous Pod
 * bounds the TRAIL of terminal Pods; nothing bounded the RATE.
 *
 * The backoff lives on the lease so it survives a controller restart, and it
 * arms only once the current generation has actually terminated — a Custodian
 * still starting up is not a failure. A generation that reaches Ready clears
 * the counter, so a group that heals pays nothing.
 */
function custodianBackoffMs(attempts: number): number {
  const step = Math.min(Math.max(attempts - 1, 0), 6);
  return Math.min(CUSTODIAN_BACKOFF_MAX_MS, CUSTODIAN_BACKOFF_BASE_MS * 2 ** step);
}

export class WorkspaceController {
  readonly #namespace: string;
  readonly #agentsNamespace: string;
  readonly #hostRoot: string;
  readonly #image: string;
  readonly #token: string;
  readonly #roleTemplate: string;
  readonly #nodeName?: string;
  readonly #sourceRoot: string;
  readonly #kube: Kube;
  readonly #operations = new Map<string, Promise<void>>();

  constructor(options: {
    namespace: string; agentsNamespace: string; hostRoot: string; image: string;
    token: string; roleTemplate?: string; nodeName?: string; sourceRoot?: string; kube?: Kube;
  }) {
    this.#namespace = dns(options.namespace);
    this.#agentsNamespace = dns(options.agentsNamespace);
    if (!/^\/[A-Za-z0-9._/-]+$/.test(options.hostRoot) || options.hostRoot.includes('..')) throw new Error('invalid workspace host root');
    if (!/^\S+@sha256:[0-9a-f]{64}$/.test(options.image)) throw new Error('workspace image must be immutable');
    if (options.token.length < 32) throw new Error('workspace Controller token is invalid');
    this.#hostRoot = options.hostRoot.replace(/\/$/, '');
    this.#image = options.image;
    this.#token = options.token;
    this.#roleTemplate = options.roleTemplate ?? '';
    this.#nodeName = options.nodeName ? workspaceNode(options.nodeName) : undefined;
    this.#sourceRoot = sourceRoot(options.sourceRoot ?? '/opt/nanoclaw');
    this.#kube = options.kube ?? new Kube();
  }

  async ensure(input: EnsureRequest): Promise<WorkspaceAssignment> {
    validateInput(input);
    return this.#serialized(input.groupId, () => this.#ensure(input));
  }

  async release(input: WorkspaceAssignment): Promise<void> {
    validateInput(input);
    await this.#kube.delete('lease', reservationName(input.groupId, input.sessionId), this.#namespace);
  }

  async ensurePaths(input: WorkspaceAssignment & { paths: string[] }): Promise<void> {
    validateInput(input);
    const paths = validateWorkspacePaths(input.paths);
    await this.#serialized(input.groupId, async () => {
      const lease = await this.#kube.get('lease', groupLeaseName(input.groupId), this.#namespace);
      const annotations = lease?.metadata?.annotations ?? {};
      const expectedPath = `${this.#hostRoot}/${input.groupId}/generations/${input.generation}/plain`;
      if (annotations['nanoco.ai/workspace-generation'] !== String(input.generation)
        || annotations['nanoco.ai/workspace-node'] !== input.nodeName
        || annotations[WORKSPACE_TIER_ANNOTATION] !== input.runtimeTier
        || input.plainHostPath !== expectedPath) throw new Error(`stale workspace assignment for ${input.groupId}`);
      const custodian = await this.#kube.get('pod', custodianPodName(input.groupId, input.generation), this.#namespace);
      if (!podReady(custodian)) throw new Error(`workspace Custodian is not Ready for ${input.groupId}`);
      await this.#custodianRequest(input.groupId, '/v1/paths/ensure', { paths });
    });
  }

  async reconcile(): Promise<void> {
    const [pods, reservations, groupLeases] = await Promise.all([
      this.#kube.list('pods', this.#agentsNamespace, `${WORKSPACE_LABEL}=true`),
      this.#kube.list('leases.coordination.k8s.io', this.#namespace, `${RESERVATION_LABEL}=true`),
      this.#kube.list('leases.coordination.k8s.io', this.#namespace, `${GROUP_LEASE_LABEL}=true`),
    ]);
    const now = Date.now();
    for (const pod of pods) {
      const sessionId = pod.metadata?.annotations?.[WORKSPACE_SESSION_ANNOTATION];
      const groupId = pod.metadata?.annotations?.[WORKSPACE_GROUP_ANNOTATION];
      if (groupId && sessionId) await this.#kube.delete('lease', reservationName(groupId, sessionId), this.#namespace);
    }
    for (const lease of reservations.filter((candidate) => reservationExpired(candidate, now))) {
      await this.#kube.delete('lease', lease.metadata.name, this.#namespace);
    }
    for (const lease of groupLeases) {
      const groupId = lease.metadata?.annotations?.[WORKSPACE_GROUP_ANNOTATION];
      if (!groupId) continue;
      await this.#serialized(groupId, () => this.#reconcileGroup(groupId, now));
    }
  }

  authenticate(req: IncomingMessage): boolean {
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    return bearerMatches(this.#token, supplied);
  }

  async #ensure(input: EnsureRequest): Promise<WorkspaceAssignment> {
    const gatewayTransport = process.env.NANOCLAW_WORKSPACE_S3_TRANSPORT === 'gateway';
    if (gatewayTransport) {
      if (!input.relay) throw new Error('Gateway workspace transport requires a relay identity');
      validateWorkspaceRelay(input.relay, input);
    } else if (input.relay) {
      throw new Error('workspace relay supplied while Gateway transport is disabled');
    }
    const leaseName = groupLeaseName(input.groupId);
    let lease = await this.#kube.get('lease', leaseName, this.#namespace);
    const sessions = await this.#kube.list('pods', this.#agentsNamespace, `${WORKSPACE_GROUP_LABEL}=${labelId(input.groupId)}`);
    const reservations = (await this.#kube.list('leases.coordination.k8s.io', this.#namespace, `${RESERVATION_LABEL}=true,${WORKSPACE_GROUP_LABEL}=${labelId(input.groupId)}`))
      .filter((candidate) => !reservationExpired(candidate, Date.now()));
    const oldTier = lease?.metadata?.annotations?.[WORKSPACE_TIER_ANNOTATION];
    if (oldTier && oldTier !== input.runtimeTier) {
      if (sessions.length > 0 || reservations.length > 0) throw new Error(`agent group ${input.groupId} is active on runtime tier ${oldTier}`);
      await this.#checkpoint(input.groupId, lease!);
      lease = await this.#kube.get('lease', leaseName, this.#namespace);
      if (!lease) throw new Error(`workspace lease disappeared during tier change for ${input.groupId}`);
      await this.#stopCustodian(input.groupId, lease!);
    }
    if (sessions.some((pod) => !podActive(pod) && pod.metadata?.finalizers?.includes(WORKSPACE_FINALIZER))) {
      throw new Error(`workspace checkpoint is pending for ${input.groupId}`);
    }
    const nodeName = lease?.metadata?.annotations?.['nanoco.ai/workspace-node'] || await this.#selectNode();
    let generation = Number(lease?.metadata?.annotations?.['nanoco.ai/workspace-generation'] ?? 0);
    let current = generation > 0 && oldTier === input.runtimeTier ? await this.#kube.get('pod', custodianPodName(input.groupId, generation), this.#namespace) : null;
    if (podReady(current) && !podUsesImage(current, this.#image)) {
      const anotherStart = reservations.some((reservation) => reservation.metadata?.annotations?.[WORKSPACE_SESSION_ANNOTATION] !== input.sessionId);
      if (sessions.length > 0 || anotherStart) throw new Error(`workspace Custodian upgrade is waiting for active sessions in ${input.groupId}`);
      await this.#checkpoint(input.groupId, lease!);
      await this.#stopCustodian(input.groupId, lease!);
      current = null;
    }
    if (podReady(current) && lease?.metadata?.annotations?.[CUSTODIAN_ATTEMPTS_ANNOTATION] &&
        lease.metadata.annotations[CUSTODIAN_ATTEMPTS_ANNOTATION] !== '0') {
      // A generation reached Ready: the group healed, so the next failure starts
      // its backoff from zero rather than inheriting an old streak.
      await this.#annotateLease(lease, { [CUSTODIAN_ATTEMPTS_ANNOTATION]: '0' });
    }
    if (!podReady(current)) {
      if (sessions.length > 0) throw new Error(`workspace recovery is draining existing sessions for ${input.groupId}`);
      const attempts = Number(lease?.metadata?.annotations?.[CUSTODIAN_ATTEMPTS_ANNOTATION] ?? '0') || 0;
      const lastAttemptMs = Date.parse(lease?.metadata?.annotations?.[CUSTODIAN_ATTEMPT_AT_ANNOTATION] ?? '');
      if (generation > 0 && podStopped(current) && attempts > 0 && Number.isFinite(lastAttemptMs)) {
        const dueAt = lastAttemptMs + custodianBackoffMs(attempts);
        const remainingMs = dueAt - Date.now();
        if (remainingMs > 0) {
          throw new Error(
            `workspace Custodian for ${input.groupId} failed ${attempts} generation(s) in a row; ` +
              `next attempt in ${Math.ceil(remainingMs / 1000)}s`,
          );
        }
      }
      const previousGeneration = generation;
      generation += 1;
      lease = await this.#applyGroupLease(input.groupId, input.runtimeTier, nodeName, generation);
      await this.#annotateLease(lease!, {
        [CUSTODIAN_ATTEMPTS_ANNOTATION]: String(attempts + 1),
        [CUSTODIAN_ATTEMPT_AT_ANNOTATION]: new Date().toISOString(),
      });
      // A non-Ready generation has no usable state. Remove it before waiting on
      // its replacement so a failed startup cannot leave an unbounded trail of
      // terminal Pods behind on every Host retry.
      if (previousGeneration > 0) await this.#kube.delete('pod', custodianPodName(input.groupId, previousGeneration), this.#namespace);
      await this.#startCustodian(input.groupId, input.runtimeTier, nodeName, generation, input.relay);
    }
    if (lease?.metadata?.annotations?.['nanoco.ai/workspace-dirty'] !== 'true') {
      await this.#annotateLease(lease!, { 'nanoco.ai/workspace-dirty': 'true' });
    }
    await this.#applyReservation(input, generation);
    return {
      ...input,
      nodeName,
      generation,
      plainHostPath: `${this.#hostRoot}/${input.groupId}/generations/${generation}/plain`,
    };
  }

  async #reconcileGroup(groupId: string, now: number): Promise<void> {
    const [lease, groupPods, reservations] = await Promise.all([
      this.#kube.get('lease', groupLeaseName(groupId), this.#namespace),
      this.#kube.list('pods', this.#agentsNamespace, `${WORKSPACE_GROUP_LABEL}=${labelId(groupId)}`),
      this.#kube.list('leases.coordination.k8s.io', this.#namespace, `${RESERVATION_LABEL}=true,${WORKSPACE_GROUP_LABEL}=${labelId(groupId)}`),
    ]);
    if (!lease) return;
    const reserved = reservations.some((reservation) => !reservationExpired(reservation, now));
    const active = groupPods.filter(podActive);
    const finalizing = groupPods.filter((pod) => pod.metadata?.finalizers?.includes(WORKSPACE_FINALIZER));
    const generation = Number(lease.metadata?.annotations?.['nanoco.ai/workspace-generation']);
    const custodian = await this.#kube.get('pod', custodianPodName(groupId, generation), this.#namespace);
    if (active.length > 0 && podStopped(custodian)) {
      await this.#annotateLease(lease, { 'nanoco.ai/workspace-dirty': 'true', 'nanoco.ai/workspace-recovery-at': new Date(now).toISOString() });
      for (const pod of active) {
        await this.#kube.patch('pod', pod.metadata.name, this.#agentsNamespace, { metadata: { annotations: { ...pod.metadata.annotations, [WORKSPACE_RECOVERY_ANNOTATION]: 'true' } } });
        await this.#kube.delete('pod', pod.metadata.name, this.#agentsNamespace);
      }
      return;
    }
    if (active.length > 0 || reserved) {
      if (lease.metadata?.annotations?.['nanoco.ai/workspace-dirty'] !== 'true') await this.#annotateLease(lease, { 'nanoco.ai/workspace-dirty': 'true' });
      for (const pod of finalizing.filter((candidate) => !podActive(candidate))) await this.#removeFinalizer(pod);
      return;
    }
    const dirty = lease.metadata?.annotations?.['nanoco.ai/workspace-dirty'] === 'true';
    if (finalizing.length > 0 || dirty) {
      if (dirty) {
        // The final checkpoint is a REAL guarantee — restic compacts and pushes
        // here, and a session's last writes live or die on it, so a teardown
        // pausing for it is correct. What is not correct is being hostage to
        // it: this threw, `#removeFinalizer` one line below was never reached,
        // and the driver loop retried every 5s forever. A pod sat Failed for
        // 100+ minutes with every container dead, waiting on a backup that
        // could not succeed.
        //
        // So: bound it, don't drop it. Keep flushing while attempts remain;
        // past the ceiling, release the pod anyway and record the loss loudly
        // on the lease — a reaped pod with a named, dated lost checkpoint beats
        // an unreapable one, and the annotation is the evidence that a
        // checkpoint was actually skipped rather than quietly succeeding.
        try {
          await this.#checkpoint(groupId, lease);
          await this.#annotateLease(lease, {
            'nanoco.ai/workspace-dirty': 'false',
            'nanoco.ai/workspace-last-idle-at': new Date(now).toISOString(),
            [CHECKPOINT_ATTEMPTS_ANNOTATION]: '0',
          });
        } catch (error) {
          const attempts = (Number(lease.metadata?.annotations?.[CHECKPOINT_ATTEMPTS_ANNOTATION] ?? '0') || 0) + 1;
          const detail = error instanceof Error ? error.message : String(error);
          if (attempts < CHECKPOINT_MAX_ATTEMPTS) {
            await this.#annotateLease(lease, { [CHECKPOINT_ATTEMPTS_ANNOTATION]: String(attempts) });
            throw error;
          }
          await this.#annotateLease(lease, {
            'nanoco.ai/workspace-dirty': 'false',
            'nanoco.ai/workspace-last-idle-at': new Date(now).toISOString(),
            [CHECKPOINT_ATTEMPTS_ANNOTATION]: '0',
            [CHECKPOINT_LOST_AT_ANNOTATION]: new Date(now).toISOString(),
            [CHECKPOINT_LOST_REASON_ANNOTATION]: detail.slice(0, 200),
          });
        }
      }
      for (const pod of finalizing) await this.#removeFinalizer(pod);
      return;
    }
    const idle = Date.parse(lease.metadata?.annotations?.['nanoco.ai/workspace-last-idle-at'] ?? '');
    if (!Number.isFinite(idle)) {
      await this.#annotateLease(lease, { 'nanoco.ai/workspace-last-idle-at': new Date(now).toISOString() });
    } else if (now - idle >= IDLE_MS) {
      await this.#stopCustodian(groupId, lease);
    }
  }

  async #selectNode(): Promise<string> {
    if (this.#nodeName) return this.#nodeName;
    const nodes = await this.#kube.list('nodes', undefined, undefined);
    const ready = nodes.filter((node) => node.metadata?.labels?.['nanoco.ai/workspace-nvme'] === 'true' && !node.spec?.unschedulable && node.status?.conditions?.some((condition: Json) => condition.type === 'Ready' && condition.status === 'True'));
    ready.sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
    if (!ready[0]?.metadata?.name) throw new Error('no Ready Kubernetes node is labelled nanoco.ai/workspace-nvme=true');
    return ready[0].metadata.name;
  }

  async #applyGroupLease(groupId: string, tier: Tier, nodeName: string, generation: number): Promise<Json> {
    return this.#kube.apply({
      apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
      metadata: { name: groupLeaseName(groupId), namespace: this.#namespace, labels: { [GROUP_LEASE_LABEL]: 'true', [WORKSPACE_GROUP_LABEL]: labelId(groupId) }, annotations: {
        [WORKSPACE_GROUP_ANNOTATION]: groupId, [WORKSPACE_TIER_ANNOTATION]: tier,
        'nanoco.ai/workspace-node': nodeName, 'nanoco.ai/workspace-generation': String(generation),
      } },
      spec: { holderIdentity: nodeName, leaseDurationSeconds: 2147483647, renewTime: leaseTime() },
    });
  }

  async #applyReservation(input: EnsureRequest, generation: number): Promise<void> {
    await this.#kube.apply({
      apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: {
        name: reservationName(input.groupId, input.sessionId), namespace: this.#namespace,
        labels: { [RESERVATION_LABEL]: 'true', [WORKSPACE_GROUP_LABEL]: labelId(input.groupId), [WORKSPACE_SESSION_LABEL]: labelId(input.sessionId) },
        annotations: { [WORKSPACE_GROUP_ANNOTATION]: input.groupId, [WORKSPACE_SESSION_ANNOTATION]: input.sessionId, [WORKSPACE_TIER_ANNOTATION]: input.runtimeTier, 'nanoco.ai/workspace-generation': String(generation) },
      }, spec: { holderIdentity: input.sessionId, leaseDurationSeconds: RESERVATION_SECONDS, renewTime: leaseTime() },
    });
  }

  async #startCustodian(
    groupId: string,
    tier: Tier,
    nodeName: string,
    generation: number,
    relay?: WorkspaceRelay,
  ): Promise<void> {
    const suffix = resourceSuffix(groupId);
    const serviceAccount = `nanoclaw-custodian-${suffix}`;
    const tokenSecret = `nanoclaw-custodian-token-${suffix}`;
    const relaySecret = `nanoclaw-custodian-relay-${suffix}`;
    const service = `nanoclaw-custodian-${suffix}`;
    const roleArn = this.#roleTemplate ? this.#roleTemplate.replaceAll('{groupId}', groupId) : '';
    await this.#kube.apply({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: {
      name: serviceAccount, namespace: this.#namespace,
      labels: { [WORKSPACE_GROUP_LABEL]: labelId(groupId) },
      ...(roleArn ? { annotations: { 'eks.amazonaws.com/role-arn': roleArn } } : {}),
    }, automountServiceAccountToken: false });
    if (!await this.#kube.get('secret', tokenSecret, this.#namespace)) {
      const token = randomBytes(32).toString('base64url');
      await this.#kube.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: tokenSecret, namespace: this.#namespace }, type: 'Opaque', data: { token: Buffer.from(token).toString('base64') } });
    }
    if (relay) {
      await this.#kube.apply({
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: relaySecret, namespace: this.#namespace, labels: { [WORKSPACE_GROUP_LABEL]: labelId(groupId) } },
        type: 'Opaque',
        data: {
          claim: Buffer.from(relay.claim).toString('base64'),
          'request-capability': Buffer.from(relay.requestCapability).toString('base64'),
        },
      });
    }
    await this.#kube.apply({ apiVersion: 'v1', kind: 'Service', metadata: { name: service, namespace: this.#namespace }, spec: {
      publishNotReadyAddresses: true,
      selector: { [WORKSPACE_GROUP_LABEL]: labelId(groupId), [WORKSPACE_GENERATION_LABEL]: String(generation) }, ports: [{ name: 'api', port: 8788, targetPort: 'api' }],
    } });
    await this.#kube.apply(custodianPod({
      namespace: this.#namespace, image: this.#image, groupId, tier, nodeName, generation,
      hostRoot: this.#hostRoot, serviceAccount, tokenSecret, relaySecret, relay, sourceRoot: this.#sourceRoot,
    }));
    await this.#kube.run(['-n', this.#namespace, 'wait', '--for=condition=Ready', `pod/${custodianPodName(groupId, generation)}`, '--timeout=180s']);
  }

  async #checkpoint(groupId: string, lease: Json): Promise<void> {
    let generation = Number(lease.metadata?.annotations?.['nanoco.ai/workspace-generation']);
    let pod = await this.#kube.get('pod', custodianPodName(groupId, generation), this.#namespace);
    if (!podReady(pod)) {
      // Starting a Custodian here WITHOUT a relay is how an orphan is born: under
      // Gateway transport every AWS call is signed by the egress sidecar, which
      // only exists when a relay identity was supplied. A relay-less generation
      // therefore cannot reach KMS or S3 at all — it dies on
      // `CredentialsProviderError: Could not load credentials from any providers`,
      // is never Ready, and the next reconcile starts another one. Refuse instead
      // of manufacturing a Pod that is guaranteed to fail.
      if (process.env.NANOCLAW_WORKSPACE_S3_TRANSPORT === 'gateway') {
        throw new Error(
          `workspace Custodian for ${groupId} is not Ready and a checkpoint cannot mint one: ` +
            'Gateway transport requires a relay identity, which only a session ensure() carries',
        );
      }
      const previousGeneration = generation;
      generation += 1;
      const tier = lease.metadata.annotations[WORKSPACE_TIER_ANNOTATION] as Tier;
      const nodeName = lease.metadata.annotations['nanoco.ai/workspace-node'];
      lease = await this.#applyGroupLease(groupId, tier, nodeName, generation);
      await this.#startCustodian(groupId, tier, nodeName, generation);
      await this.#kube.delete('pod', custodianPodName(groupId, previousGeneration), this.#namespace);
      pod = await this.#kube.get('pod', custodianPodName(groupId, generation), this.#namespace);
    }
    if (!podReady(pod)) throw new Error(`workspace Custodian is not Ready for ${groupId}`);
    const result = await this.#custodianRequest(groupId, '/v1/checkpoint');
    await this.#annotateLease(lease, {
      'nanoco.ai/workspace-last-checkpoint': new Date().toISOString(),
      'nanoco.ai/workspace-snapshot': String(result.snapshotId ?? ''),
    });
  }

  async #stopCustodian(groupId: string, lease: Json): Promise<void> {
    const generation = Number(lease.metadata?.annotations?.['nanoco.ai/workspace-generation']);
    const pod = await this.#kube.get('pod', custodianPodName(groupId, generation), this.#namespace);
    // An idle Ready Custodian gets a graceful unmount. A missing or terminal
    // one cannot answer the API and is already safe to reap because this path
    // is reached only after all writers and reservations are gone.
    if (podReady(pod)) await this.#custodianRequest(groupId, '/v1/shutdown').catch(() => undefined);
    await this.#kube.delete('pod', custodianPodName(groupId, generation), this.#namespace);
    await this.#kube.delete('service', `nanoclaw-custodian-${resourceSuffix(groupId)}`, this.#namespace);
    await this.#kube.delete('secret', `nanoclaw-custodian-token-${resourceSuffix(groupId)}`, this.#namespace);
    await this.#kube.delete('secret', `nanoclaw-custodian-relay-${resourceSuffix(groupId)}`, this.#namespace);
    await this.#kube.delete('serviceaccount', `nanoclaw-custodian-${resourceSuffix(groupId)}`, this.#namespace);
    await this.#annotateLease(lease, { 'nanoco.ai/workspace-last-idle-at': '' });
  }

  async #custodianRequest(groupId: string, route: string, body?: Json): Promise<Json> {
    const suffix = resourceSuffix(groupId);
    const secret = await this.#kube.get('secret', `nanoclaw-custodian-token-${suffix}`, this.#namespace);
    const token = Buffer.from(secret?.data?.token ?? '', 'base64').toString('utf8');
    if (token.length < 32) throw new Error(`Custodian API token is missing for ${groupId}`);
    const response = await fetch(`http://nanoclaw-custodian-${suffix}.${this.#namespace}.svc.cluster.local:8788${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000),
    });
    const result = await response.json().catch(() => ({})) as Json;
    if (!response.ok) throw new Error(result.error || `Custodian returned HTTP ${response.status}`);
    return result;
  }

  async #removeFinalizer(pod: Json): Promise<void> {
    const finalizers = (pod.metadata?.finalizers ?? []).filter((value: string) => value !== WORKSPACE_FINALIZER);
    await this.#kube.patch('pod', pod.metadata.name, pod.metadata.namespace, { metadata: { finalizers } });
  }

  async #annotateLease(lease: Json, annotations: Record<string, string>): Promise<void> {
    await this.#kube.patch('lease', lease.metadata.name, this.#namespace, { metadata: { annotations } });
  }

  async #serialized<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(groupId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => {}, () => {});
    this.#operations.set(groupId, tail);
    try { return await current; }
    finally { if (this.#operations.get(groupId) === tail) this.#operations.delete(groupId); }
  }
}

export class Kube {
  async run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`kubectl ${args[0]} failed: ${stderr.trim()}`)));
      child.stdin.end(input);
    });
  }
  async get(kind: string, name: string, namespace?: string): Promise<Json | null> {
    try { return JSON.parse(await this.run([...(namespace ? ['-n', namespace] : []), 'get', kind, name, '-o', 'json'])); }
    catch (error) { if ((error as Error).message.includes('NotFound')) return null; throw error; }
  }
  async list(kind: string, namespace?: string, selector?: string): Promise<Json[]> {
    const result = JSON.parse(await this.run([...(namespace ? ['-n', namespace] : []), 'get', kind, ...(selector ? ['-l', selector] : []), '-o', 'json']));
    return result.items ?? [];
  }
  async apply(value: Json): Promise<Json> {
    const out = await this.run(['apply', '--server-side', '--field-manager=nanoco-workspace-controller', '-f', '-', '-o', 'json'], JSON.stringify(value));
    return JSON.parse(out);
  }
  async patch(kind: string, name: string, namespace: string, value: Json): Promise<void> {
    await this.run(['-n', namespace, 'patch', kind, name, '--type=merge', '-p', JSON.stringify(value)]);
  }
  async delete(kind: string, name: string, namespace: string): Promise<void> {
    await this.run(['-n', namespace, 'delete', kind, name, '--ignore-not-found=true', '--wait=false']);
  }
}

function custodianPod(input: {
  namespace: string; image: string; groupId: string; tier: Tier; nodeName: string; generation: number;
  hostRoot: string; serviceAccount: string; tokenSecret: string; relaySecret: string;
  relay?: WorkspaceRelay; sourceRoot: string;
}): Json {
  const groupRoot = `${input.hostRoot}/${input.groupId}`;
  const runAsUser = runtimeId(process.env.NANOCO_WORKSPACE_RUN_AS_UID ?? '10001');
  const runAsGroup = runtimeId(process.env.NANOCO_WORKSPACE_RUN_AS_GID ?? '10001');
  const relaySecurity = {
    runAsNonRoot: true, runAsUser, runAsGroup, allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] },
  };
  const relayMounts = [
    { name: 'relay-identity', mountPath: '/run/nanoco/identity' },
    { name: 'relay-trust', mountPath: '/run/nanoco/trust', readOnly: true },
    { name: 'relay-tmp', mountPath: '/tmp' },
  ];
  return {
    apiVersion: 'v1', kind: 'Pod', metadata: { name: custodianPodName(input.groupId, input.generation), namespace: input.namespace,
      labels: { 'app.kubernetes.io/name': 'nanoclaw-workspace-custodian', [WORKSPACE_GROUP_LABEL]: labelId(input.groupId), [WORKSPACE_GENERATION_LABEL]: String(input.generation) },
      annotations: { [WORKSPACE_GROUP_ANNOTATION]: input.groupId, [WORKSPACE_TIER_ANNOTATION]: input.tier } },
    spec: { restartPolicy: 'Never', nodeName: input.nodeName, serviceAccountName: input.serviceAccount, automountServiceAccountToken: false,
      enableServiceLinks: false, terminationGracePeriodSeconds: 120,
      securityContext: { fsGroup: runAsGroup, fsGroupChangePolicy: 'OnRootMismatch' },
      ...(input.relay ? { initContainers: [
        {
          name: 'workspace-identity-manager', image: input.image, imagePullPolicy: 'IfNotPresent', restartPolicy: 'Always',
          command: ['node', `${input.sourceRoot}/dist/stateless-k8s/identity-manager.js`],
          env: [
            { name: 'HOME', value: '/tmp' },
            { name: 'NANOCO_IDENTITY_CLAIM_URL', value: input.relay.claimUrl },
            { name: 'NANOCO_IDENTITY_SERVER_NAME', value: input.relay.claimServerName },
            { name: 'NANOCO_IDENTITY_GATEWAY_CA', value: '/run/nanoco/trust/gateway-server-ca.pem' },
            { name: 'NANOCO_IDENTITY_CLAIM_FILE', value: '/run/nanoco/relay/claim' },
            { name: 'NANOCO_IDENTITY_DIR', value: '/run/nanoco/identity' },
            { name: 'NANOCO_IDENTITY_DEPLOYMENT_ID', value: input.relay.deploymentId },
            { name: 'NANOCO_IDENTITY_AGENT_ID', value: input.relay.agentId },
            { name: 'NANOCO_IDENTITY_SESSION_ID', value: input.relay.sessionId },
            { name: 'NANOCO_IDENTITY_CONTAINER_INSTANCE_ID', value: input.relay.containerInstanceId },
            { name: 'NANOCO_IDENTITY_CHANNEL_ID', value: input.relay.channelId },
          ],
          startupProbe: { exec: { command: ['sh', '-c', 'test -s /run/nanoco/identity/session-cert.pem -a -s /run/nanoco/identity/session-key.pem'] }, periodSeconds: 1, failureThreshold: 30 },
          securityContext: relaySecurity,
          resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { memory: '128Mi' } },
          volumeMounts: [...relayMounts, { name: 'relay-secret', mountPath: '/run/nanoco/relay', readOnly: true }],
        },
        {
          name: 'workspace-egress-sidecar', image: input.relay.sidecarImage, imagePullPolicy: 'IfNotPresent', restartPolicy: 'Always',
          env: [
            { name: 'NANOCO_SIDECAR_LISTEN_ADDR', value: '0.0.0.0:15001' },
            { name: 'NANOCO_SIDECAR_GATEWAY_ADDR', value: input.relay.gatewayAddress },
            { name: 'NANOCO_SIDECAR_GATEWAY_SERVER_NAME', value: input.relay.gatewayServerName },
            { name: 'NANOCO_SIDECAR_GATEWAY_CA', value: '/run/nanoco/trust/gateway-server-ca.pem' },
            { name: 'NANOCO_SIDECAR_CLIENT_CERT', value: '/run/nanoco/identity/session-cert.pem' },
            { name: 'NANOCO_SIDECAR_CLIENT_KEY', value: '/run/nanoco/identity/session-key.pem' },
          ],
          startupProbe: { tcpSocket: { port: 15001 }, periodSeconds: 1, failureThreshold: 30 },
          securityContext: relaySecurity,
          resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { memory: '128Mi' } },
          volumeMounts: relayMounts,
        },
      ] } : {}),
      containers: [{ name: 'custodian', image: input.image, imagePullPolicy: 'IfNotPresent',
        command: ['node', `${input.sourceRoot}/dist/storage/workspace-custodian-service.js`],
        envFrom: [{ configMapRef: { name: 'nanoclaw-workspace-storage' } }],
        env: [
          { name: 'NANOCO_WORKSPACE_GROUP_ID', value: input.groupId }, { name: 'NANOCO_WORKSPACE_GENERATION', value: String(input.generation) },
          { name: 'NANOCO_WORKSPACE_GROUP_ROOT', value: '/workspace-group' }, { name: 'NANOCO_WORKSPACE_TOKEN_FILE', value: '/run/nanoco/api/token' },
          { name: 'NANOCO_WORKSPACE_RUN_AS_UID', value: String(runAsUser) },
          { name: 'NANOCO_WORKSPACE_RUN_AS_GID', value: String(runAsGroup) },
          { name: 'AWS_EC2_METADATA_DISABLED', value: input.relay || process.env.NANOCO_WORKSPACE_DISABLE_IMDS === '1' ? 'true' : 'false' },
          ...(input.relay ? [
            { name: 'NANOCLAW_WORKSPACE_S3_TRANSPORT', value: 'gateway' },
            { name: 'NANOCLAW_MAILBOX_GATEWAY_PROXY', value: 'http://127.0.0.1:15001' },
            { name: 'NANOCLAW_MAILBOX_GATEWAY_CA', value: '/run/nanoco/trust/proxy-ca.pem' },
            { name: 'NANOCLAW_STORAGE_CAPABILITY_FILE', value: '/run/nanoco/relay/request-capability' },
          ] : [{ name: 'NANOCLAW_WORKSPACE_S3_TRANSPORT', value: 'role' }]),
        ], ports: [{ name: 'api', containerPort: 8788 }],
        startupProbe: { httpGet: { path: '/ready', port: 'api' }, periodSeconds: 2, failureThreshold: 90 },
        readinessProbe: { httpGet: { path: '/ready', port: 'api' }, periodSeconds: 2, failureThreshold: 30 },
        livenessProbe: { httpGet: { path: '/live', port: 'api' }, periodSeconds: 2, failureThreshold: 15 },
        securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0 },
        resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '512Mi' } },
        volumeMounts: [
          { name: 'group', mountPath: '/workspace-group', mountPropagation: 'Bidirectional' },
          { name: 'fuse', mountPath: '/dev/fuse' }, { name: 'run', mountPath: '/run/nanoco' }, { name: 'token', mountPath: '/run/nanoco/api', readOnly: true }, { name: 'tmp', mountPath: '/tmp' },
          ...(input.relay ? [
            { name: 'relay-trust', mountPath: '/run/nanoco/trust', readOnly: true },
            { name: 'relay-secret', mountPath: '/run/nanoco/relay', readOnly: true },
          ] : []),
        ] }],
      volumes: [
        { name: 'group', hostPath: { path: groupRoot, type: 'DirectoryOrCreate' } }, { name: 'fuse', hostPath: { path: '/dev/fuse', type: 'CharDevice' } },
        { name: 'run', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } }, { name: 'token', secret: { secretName: input.tokenSecret, defaultMode: 0o400 } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
        ...(input.relay ? [
          { name: 'relay-identity', emptyDir: { medium: 'Memory', sizeLimit: '4Mi' } },
          { name: 'relay-trust', secret: { secretName: 'nanoclaw-session-public', defaultMode: 0o444 } },
          { name: 'relay-secret', secret: { secretName: input.relaySecret, defaultMode: 0o400 } },
          { name: 'relay-tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
        ] : []),
      ] },
  };
}

function runtimeId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1 << 30) throw new Error('invalid workspace runtime uid/gid');
  return parsed;
}

function podActive(pod: Json): boolean {
  if (pod.metadata?.deletionTimestamp || pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') return false;
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  return !statuses.length || statuses.some((status: Json) => !status.state?.terminated);
}
function podReady(pod: Json | null): boolean { return Boolean(pod?.status?.conditions?.some((condition: Json) => condition.type === 'Ready' && condition.status === 'True')); }
function podUsesImage(pod: Json | null, image: string): boolean { return pod?.spec?.containers?.some((container: Json) => container.name === 'custodian' && container.image === image) === true; }
function podStopped(pod: Json | null): boolean { return !pod || pod.metadata?.deletionTimestamp != null || pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed'; }
function reservationExpired(lease: Json, now: number): boolean {
  const renewed = Date.parse(lease.spec?.renewTime ?? lease.metadata?.creationTimestamp ?? '');
  return !Number.isFinite(renewed) || now - renewed > Number(lease.spec?.leaseDurationSeconds ?? 0) * 1000;
}
function resourceSuffix(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
function leaseTime(): string { return new Date().toISOString().replace(/Z$/, '000Z'); }
function groupLeaseName(groupId: string): string { return `workspace-group-${resourceSuffix(groupId)}`; }
function reservationName(groupId: string, sessionId: string): string { return `workspace-reservation-${resourceSuffix(`${groupId}/${sessionId}`)}`; }
function custodianPodName(groupId: string, generation: number): string { return `nanoclaw-custodian-${resourceSuffix(groupId)}-g${generation}`; }
function dns(value: string): string { if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)) throw new Error('invalid namespace'); return value; }
function workspaceNode(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value)) throw new Error('invalid workspace node');
  return value;
}
function sourceRoot(value: string): string {
  if (!value.startsWith('/') || value === '/' || value.includes('..')) throw new Error('invalid workspace source root');
  return value.replace(/\/$/, '');
}
function validateInput(value: EnsureRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.groupId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) throw new Error('invalid workspace request ID');
  if (value.runtimeTier !== 'container' && value.runtimeTier !== 'vm') throw new Error('invalid workspace runtime tier');
}

async function body(req: IncomingMessage): Promise<Json> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error('request too large'); }
  return JSON.parse(raw || '{}');
}
function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); }

/**
 * Run the workspace plane INSIDE the Host process.
 *
 * Same controller, same reconcile cadence — only the transport and the
 * lifecycle change. The HTTP hop disappears (it is the call that times out),
 * the companion namespace and its cross-namespace RoleBinding stop being
 * needed (the Host's RBAC is already a strict superset), and the reconciler can
 * no longer outlive the Host that owns it.
 *
 * Returns a stop function so the caller owns shutdown; the loop unrefs its
 * timer, so it never holds the process open by itself.
 */
export async function startEmbeddedWorkspaceController(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ controller: WorkspaceController; stop: () => void }> {
  const tokenFile = env.NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE ?? '';
  const controller = new WorkspaceController({
    namespace: env.NANOCO_WORKSPACE_NAMESPACE ?? 'system',
    agentsNamespace: env.NANOCLAW_POD_NAMESPACE ?? 'agents',
    hostRoot: env.NANOCO_WORKSPACE_HOST_ROOT ?? '',
    image: env.NANOCO_WORKSPACE_IMAGE ?? '',
    // In-process there is no wire to authenticate, but the constructor still
    // demands a token: keep reading the file when it exists so a split
    // deployment and an embedded one validate identically, and synthesise one
    // otherwise rather than weakening the check for everybody.
    token: tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : randomBytes(32).toString('base64url'),
    roleTemplate: env.NANOCO_WORKSPACE_ROLE_ARN_TEMPLATE,
    nodeName: env.NANOCO_WORKSPACE_NODE_NAME,
    sourceRoot: env.NANOCO_HOST_SOURCE_ROOT,
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reconcile = (): void => {
    if (stopped) return;
    controller.reconcile()
      .catch((error) => process.stderr.write(`workspace reconcile failed: ${(error as Error).message}\n`))
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(reconcile, 5_000);
        timer.unref();
      });
  };
  reconcile();
  return { controller, stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

async function main(): Promise<void> {
  const tokenFile = process.env.NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE ?? '';
  const controller = new WorkspaceController({
    namespace: process.env.NANOCO_WORKSPACE_NAMESPACE ?? 'system', agentsNamespace: process.env.NANOCLAW_POD_NAMESPACE ?? 'agents',
    hostRoot: process.env.NANOCO_WORKSPACE_HOST_ROOT ?? '', image: process.env.NANOCO_WORKSPACE_IMAGE ?? '',
    token: (await readFile(tokenFile, 'utf8')).trim(), roleTemplate: process.env.NANOCO_WORKSPACE_ROLE_ARN_TEMPLATE,
    nodeName: process.env.NANOCO_WORKSPACE_NODE_NAME,
    sourceRoot: process.env.NANOCO_HOST_SOURCE_ROOT,
  });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/ready' && req.method === 'GET') return send(res, 200, { ready: true });
      if (!controller.authenticate(req)) return send(res, 401, { error: 'unauthorized' });
      if (req.url === '/v1/workspaces/ensure' && req.method === 'POST') return send(res, 200, await controller.ensure(await body(req) as EnsureRequest));
      if (req.url === '/v1/workspaces/paths' && req.method === 'POST') { await controller.ensurePaths(await body(req) as WorkspaceAssignment & { paths: string[] }); return send(res, 200, { ready: true }); }
      if (req.url === '/v1/workspaces/release' && req.method === 'POST') { await controller.release(await body(req) as WorkspaceAssignment); return send(res, 200, { released: true }); }
      send(res, 404, { error: 'not found' });
    } catch (error) { send(res, 409, { error: (error as Error).message }); }
  });
  server.listen(8787, '0.0.0.0');
  const reconcile = (): void => {
    controller.reconcile()
      .catch((error) => process.stderr.write(`workspace reconcile failed: ${(error as Error).message}\n`))
      .finally(() => setTimeout(reconcile, 5_000).unref());
  };
  reconcile();
}

if (process.argv[1]?.endsWith('/workspace-controller.js')) void main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exit(1); });
