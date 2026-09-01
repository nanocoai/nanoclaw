/**
 * Thin kubectl layer for the k8s dev-env driver.
 *
 * Everything the driver says to the cluster goes through here: one place to
 * normalize kubectl failures into the seam taxonomy, one place that knows the
 * watch protocol. Rides the session seam's `Cli` so the conformance harness
 * can stand a fake cluster underneath (the same move the docker driver made).
 *
 * Failure opacity is contractual: raw kubectl stderr never crosses the seam,
 * but an unclassified failure with no log line is an undiagnosable incident —
 * so unknowns log their detail here, at the boundary, before the opaque
 * failure is thrown.
 */
import { log } from '../log.js';

import type { Cli, SupervisedProcess } from '../drivers/cli.js';
import { JsonDocumentStream } from '../drivers/json-stream.js';

import { asDevEnvFailureError, type DevEnvFailure, type DevEnvFailureError } from './types.js';

/** kubectl's CAS rejection when --resource-version no longer matches. */
export function isConflict(error: unknown): boolean {
  return /the object has been modified|Conflict|Operation cannot be fulfilled/i.test(String(error));
}

export function isNotFound(error: unknown): boolean {
  return /NotFound|not found/i.test(String(error));
}

export function isAlreadyExists(error: unknown): boolean {
  return /AlreadyExists|already exists/i.test(String(error));
}

/**
 * kubectl phrasings → seam taxonomy. Ported from the session pod driver's
 * normalizer (including the measured VAP 422 shape); the taxonomy differs —
 * dev-env has capacity/driver-unavailable where sessions have resources/runtime.
 */
export function normalizeK8sFailure(error: unknown): DevEnvFailureError {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
  const text = `${message}\n${stderr}`;

  // Order matters: real quota rejections phrase as `... is forbidden: exceeded
  // quota ...` — capacity must win over the policy-denial match or every
  // genuine capacity signal becomes a permanent denial.
  const failure: DevEnvFailure =
    /exceeded quota|Insufficient (cpu|memory|ephemeral-storage)|OutOf(cpu|memory)|Unschedulable/i.test(text)
      ? { kind: 'capacity-exhausted', retryable: true }
      : /ValidatingAdmissionPolicy '[^']*' with binding '[^']*' denied request|admission webhook .* denied|is forbidden/i.test(
            text,
          )
        ? { kind: 'denied-by-policy', retryable: false, detail: 'admission refused the instance' }
        : /connection refused|connection to the server .* was refused|Unable to connect|no such host|i\/o timeout|TLS handshake timeout|error: EOF|etcdserver|ETIMEDOUT/i.test(
              text,
            )
          ? { kind: 'driver-unavailable', retryable: true }
          : { kind: 'unknown', retryable: false, opaqueRef: `kubectl:${Date.now().toString(36)}` };

  if (failure.kind === 'unknown') {
    // The opaqueRef in the log is what lets an operator join a seam-shaped
    // failure back to its raw cause.
    log.warn('Dev-env kubectl failure (unclassified)', {
      opaqueRef: failure.opaqueRef,
      detail: text.slice(0, 300),
    });
  }
  return asDevEnvFailureError(failure);
}

export interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object: KubeObject;
}

export interface KubeObject {
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    /** Namespaces: when the instance was born — the boot budget's anchor across host restarts. */
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    clusterIP?: string;
    /** Services: what the object actually serves — the exposure target's qualifying test (C14). */
    ports?: Array<{ port?: number; protocol?: string; name?: string }>;
    /** `local`-type PersistentVolumes: the node path the volume realizes. */
    local?: { path?: string };
    /** PersistentVolumeClaims: the PV the binder settled on — the dev flavor's fidelity signal. */
    volumeName?: string;
    /** Deployments: the pod template — the fidelity gate's variant evidence (C16). */
    template?: { spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> } };
  };
  status?: {
    phase?: string;
    conditions?: Array<{ type: string; status: string }>;
    readyReplicas?: number;
    /** Jobs: completion counters — the placement poll's verdict (C15). */
    succeeded?: number;
    failed?: number;
    /** Nodes: what kubelet reports present in the store — the re-probe's leg (C15). */
    images?: Array<{ names?: string[] }>;
  };
  data?: Record<string, string>;
  items?: KubeObject[];
}

export function podIsReady(pod: KubeObject): boolean {
  return pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
}

/** A rollout that has landed: the Available condition, or a replica that reports ready. */
export function deploymentAvailable(deployment: KubeObject | null): boolean {
  if (!deployment) return false;
  if (deployment.status?.conditions?.some((c) => c.type === 'Available' && c.status === 'True')) return true;
  return (deployment.status?.readyReplicas ?? 0) >= 1;
}

/**
 * The same `Cli`, pointed at another apiserver: every argv gets these flags
 * prepended (kubectl takes globals before the verb, whatever follows).
 *
 * This is how the driver reaches a CHILD cluster without a second kubectl
 * integration — one seam, one failure normalizer, one fake underneath in
 * tests. The flags are the caller's business: a child kubeconfig alone is not
 * enough, because the syncer exports it with the in-cluster service DNS as its
 * server, which a node-hosted host cannot resolve.
 */
export function withKubectlFlags(cli: Cli, flags: string[]): Cli {
  return {
    bin: cli.bin,
    run: (args, opts) => cli.run([...flags, ...args], opts),
    start: (args, opts) => cli.start([...flags, ...args], opts),
  };
}

/**
 * A deadline for ONE call, on both sides of it: kubectl gets
 * `--request-timeout` so it gives up on the apiserver itself, and the process
 * gets a hard stop a second later as the backstop for a kubectl that ignores
 * it. Probes run inside watch callbacks and poll loops, where the default
 * 30s-per-exec budget is how one unreachable apiserver becomes a stalled host.
 */
export interface KubeCallOptions {
  timeoutMs?: number;
}

function callOpts(opts: KubeCallOptions | undefined): { args: string[]; timeoutMs?: number } {
  if (!opts?.timeoutMs) return { args: [] };
  return { args: [`--request-timeout=${opts.timeoutMs}ms`], timeoutMs: opts.timeoutMs + 1_000 };
}

export class Kube {
  constructor(private readonly cli: Cli) {}

  /** get -o json; NotFound returns null rather than throwing. */
  getJson(args: string[], opts?: KubeCallOptions): KubeObject | null {
    const bound = callOpts(opts);
    try {
      const out = this.cli.run(['get', ...args, '-o', 'json', ...bound.args], { timeoutMs: bound.timeoutMs });
      return out.trim() ? (JSON.parse(out) as KubeObject) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  listNamespaces(selector: string, opts?: KubeCallOptions): KubeObject[] {
    const result = this.getJson(['namespaces', '-l', selector], opts);
    return result?.items ?? [];
  }

  getNamespace(name: string): KubeObject | null {
    return this.getJson(['namespace', name]);
  }

  /**
   * Services in one namespace, by selector. The exposure resolver's only read:
   * it asks the cluster what serves a port RIGHT NOW rather than remembering
   * what did (C14), so this call happens at grant AND per connection.
   */
  listServices(namespace: string, selector: string, opts?: KubeCallOptions): KubeObject[] {
    return this.getJson(['svc', '-n', namespace, '-l', selector], opts)?.items ?? [];
  }

  /**
   * Apply concatenated YAML (or a single JSON doc); every doc carries its own
   * namespace. Idempotent — which is what makes replayed claims self-healing.
   */
  apply(docs: string, opts?: KubeCallOptions): void {
    const bound = callOpts(opts);
    this.cli.run(['apply', '-f', '-', ...bound.args], { input: docs, timeoutMs: bound.timeoutMs });
  }

  createRaw(doc: object): void {
    this.cli.run(['create', '-f', '-'], { input: JSON.stringify(doc) });
  }

  /**
   * The CAS label flip — the claim's ownership-taking step. `--resource-version`
   * makes it compare-and-swap: a concurrent claimer loses with a conflict, not
   * a silent double-claim. `sets` are key=value; `removes` are bare keys.
   */
  labelCas(namespace: string, resourceVersion: string, sets: Record<string, string>, removes: string[]): void {
    const args = ['label', 'namespace', namespace, '--overwrite', `--resource-version=${resourceVersion}`];
    for (const [k, v] of Object.entries(sets)) args.push(`${k}=${v}`);
    for (const k of removes) args.push(`${k}-`);
    this.cli.run(args);
  }

  label(namespace: string, sets: Record<string, string>, removes: string[] = []): void {
    const args = ['label', 'namespace', namespace, '--overwrite'];
    for (const [k, v] of Object.entries(sets)) args.push(`${k}=${v}`);
    for (const k of removes) args.push(`${k}-`);
    this.cli.run(args);
  }

  annotate(namespace: string, sets: Record<string, string>): void {
    const args = ['annotate', 'namespace', namespace, '--overwrite'];
    for (const [k, v] of Object.entries(sets)) args.push(`${k}=${v}`);
    this.cli.run(args);
  }

  /**
   * Namespace teardown IS instance teardown (D10: delete the scope).
   * `--wait=false` keeps release non-blocking — finalizers make namespace
   * deletion slow, and a blocking run here stalls the whole host event loop.
   */
  deleteNamespace(name: string): void {
    this.cli.run(['delete', 'namespace', name, '--ignore-not-found', '--wait=false'], { timeoutMs: 60_000 });
  }

  /**
   * Delete one namespaced object by name. `--ignore-not-found` because every
   * caller is a teardown path racing another teardown path, and both must win.
   */
  deleteObject(kind: string, name: string, namespace: string): void {
    this.cli.run(['delete', kind, name, '-n', namespace, '--ignore-not-found'], { timeoutMs: 60_000 });
  }

  /**
   * Delete one CLUSTER-SCOPED object by name (the dev-tree PersistentVolume).
   * Same teardown-race posture as deleteObject; distinct because a `-n` on a
   * cluster-scoped kind is a kubectl error, not a no-op.
   */
  deleteClusterObject(kind: string, name: string): void {
    this.cli.run(['delete', kind, name, '--ignore-not-found'], { timeoutMs: 60_000 });
  }

  getSecretData(namespace: string, name: string, key: string, opts?: KubeCallOptions): string | null {
    const secret = this.getJson(['secret', name, '-n', namespace], opts);
    const value = secret?.data?.[key];
    if (!value) return null;
    return Buffer.from(value, 'base64').toString('utf8');
  }

  version(): void {
    this.cli.run(['version', '--output=json', '--request-timeout=10s'], { timeoutMs: 15_000 });
  }

  /**
   * Tail of a workload's logs — the placement failure's registry-error leg
   * (C15: a failure without a recorded reason is a support ticket). Bounded
   * and best-effort at the CALLER: an unreadable log must degrade to a
   * reason-less failure, never fail the failure.
   */
  logs(namespace: string, target: string, tailLines: number, opts?: KubeCallOptions): string {
    const bound = callOpts(opts);
    return this.cli.run(['logs', target, '-n', namespace, `--tail=${tailLines}`, ...bound.args], {
      timeoutMs: bound.timeoutMs,
    });
  }

  /**
   * Supervise the vcluster pod of one namespace: a `--watch` process whose
   * JSON events land in `onEvent`. Drops are routine (the apiserver closes
   * long watches): `onDrop` fires on every exit so the owner can reconcile via
   * status() and re-arm — the recoverWatch pattern, never give up, owner
   * decides when it's over.
   */
  watchPods(
    namespace: string,
    selector: string,
    onEvent: (event: WatchEvent) => void,
    onDrop: () => void,
  ): SupervisedProcess {
    const proc = this.cli.start(
      ['get', 'pods', '-n', namespace, '-l', selector, '--watch', '--output-watch-events', '-o', 'json'],
      { captureStdout: true },
    );
    const stream = new JsonDocumentStream();
    proc.onStdout((chunk) => {
      for (const doc of stream.push(chunk)) {
        const event = doc as WatchEvent;
        if (event && typeof event === 'object' && 'type' in event) onEvent(event);
      }
    });
    proc.onExit(() => onDrop());
    return proc;
  }
}
