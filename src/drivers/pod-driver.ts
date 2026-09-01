/**
 * Pod driver — the K8s realization.
 *
 * The thin-driver claim, visible: almost everything the Docker driver
 * choreographs is a property of the Pod object. Netns sharing is the pod.
 * Sidecar-before-agent ordering is a native sidecar (an initContainer with
 * `restartPolicy: Always`). Teardown is one delete.
 *
 * The one genuinely elegant mapping: two-phase prepare/start realizes as
 * server-side dry-run + create. Admission runs at prepare time, so
 * `denied-by-policy` surfaces before anything is allocated — earlier and more
 * faithfully than the Docker driver's in-code checks.
 *
 * It speaks to the apiserver through `kubectl` rather than a client library,
 * for the same reason the Docker driver shells `docker`: it adds no dependency,
 * it inherits the kubeconfig the operator already proved works, and every
 * command it issues is one an operator can paste back.
 */
import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import { realCli, type Cli, type SupervisedProcess } from './cli.js';
import { JsonDocumentStream } from './json-stream.js';
import { kataRuntimeClass } from './runtime-class.js';
import {
  GROUP_FOLDER_LABEL,
  LABELS,
  asFailureError,
  deniedByPolicy,
  labelsForKey,
  specInvalid,
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type MountPolicy,
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

const DEFAULT_NAMESPACE = 'agents';

/**
 * The agent container's name in a composed pod. `composePod` names containers
 * by role (`name: spec_.role`), so the agent's is this literal — the same
 * string `terminalFailureOf` keys on and `execSpec` targets with `-c`. The
 * sidecar rides beside it as an initContainer, so without `-c` a kubectl exec
 * would still land on the agent today, but only by the accident of it being
 * the sole `containers[]` entry.
 */
const AGENT_CONTAINER_NAME = 'agent';
const HEARTBEAT_VOLUME_NAME = 'agent-heartbeat';
const HEARTBEAT_PATH = '/workspace/.heartbeat';

const AGENT_STORAGE_ENV_KEYS = [
  'NANOCLAW_MAILBOX_S3_BUCKET',
  'NANOCLAW_MAILBOX_S3_ENDPOINT',
  'NANOCLAW_MAILBOX_S3_PREFIX',
  'NANOCLAW_MAILBOX_S3_REGION',
] as const;

/**
 * Project only the non-secret storage coordinates into the agent container.
 * The host does not export its target-custody `.env`, so the Pod realization
 * has to read it explicitly; an exact allowlist keeps Slack/AWS credentials
 * out. Recipe composition still selects and installs the implementations.
 */
function agentStorageEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const dotenv = readEnvFile([...AGENT_STORAGE_ENV_KEYS]);
  const values: Record<string, string> = {};
  for (const key of AGENT_STORAGE_ENV_KEYS) {
    const value = env[key]?.trim() || dotenv[key]?.trim();
    if (value) values[key] = value;
  }
  const present = Object.keys(values).length;
  if (present !== 0 && present !== AGENT_STORAGE_ENV_KEYS.length) {
    throw specInvalid(
      `partial agent storage runtime configuration (${present}/${AGENT_STORAGE_ENV_KEYS.length} values)`,
    );
  }
  return values;
}

/**
 * The namespace this driver creates pods in.
 *
 * Read here, by the code that uses it, and never added to the seam's own
 * settings list: `NANOCLAW_POD_NAMESPACE` is meaningless to a host without this
 * driver, and a skill that grew trunk's SETTINGS array would own a patch of
 * trunk forever. Same precedence as every other NanoClaw setting —
 * `process.env`, then `.env` — because the host service has no
 * `EnvironmentFile=` and parses `.env` in-process, so a value written where
 * every other NanoClaw setting lives has to be seen.
 */
export function podNamespace(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.NANOCLAW_POD_NAMESPACE?.trim() ||
    readEnvFile(['NANOCLAW_POD_NAMESPACE']).NANOCLAW_POD_NAMESPACE?.trim() ||
    DEFAULT_NAMESPACE
  );
}
/* ─────────────────────────────────────────────────────────────────────────────
 * INTERIM — PVC VOLUME MODE. DELETE THIS, DO NOT PORT IT FORWARD.
 *
 * Owner of the replacement: `engineering/k8s/plans/agent-materializer` (Zvi),
 * "Stateless Kubernetes Materialization". That plan replaces this driver's
 * canonical node-path mount realization outright with state, image, control and
 * memory volumes, and its acceptance criterion #1 is "rendered Host and agent
 * Pods contain zero hostPath volumes". Its appendix rules on this exact code:
 * "Whole Host tree through hostPath and node pinning — Drop." So when that plan
 * lands, this block and its call site are deleted, not migrated.
 *
 * WHY IT EXISTS MEANWHILE. A host running AS A POD keeps its tree on a PVC, so
 * the paths it hands the driver are pod paths, not node paths. Measured on the
 * governed child: the session pod carried 15 hostPath volumes naming
 * `/nanoclaw/host/...`, and `/nanoclaw` DOES NOT EXIST on the node. They were
 * not merely forbidden by PodSecurity `baseline` on the instance namespace —
 * they were wrong. kubelet would resolve them against the node and fail the
 * `type: File` check, or, under a create-type, silently mount empty directories.
 * Relaxing PSA would not have helped and would have cost the isolation control
 * that makes a claimed child a tenancy boundary.
 *
 * Mounting the same claim that backs the host's tree, by subPath, is therefore
 * the CORRECT realization for a pod-hosted host — not a workaround for PSA. It
 * is interim only because the materializer plan removes the need for these
 * mounts altogether.
 *
 * ONE HAZARD KNOWINGLY ACCEPTED IN THIS ARM. LANDMINE B below says subPath is
 * NOT an alternative for `container.json`, the group `CLAUDE.md` and
 * `/app/CLAUDE.md`, because the host rewrites those files fresh on every spawn
 * and a subPath mount does not pick up the replacement inode. This arm mounts
 * every source by subPath, those three included. It is safe AT SPAWN — a
 * session pod is created after the rewrite and its subPath resolves at mount
 * time — but a host that rewrites one of those files MID-SESSION, without
 * respawning, will not be seen by a pod-hosted child the way it is by a
 * node-process one. Accepted rather than fixed: the materializer plan deletes
 * the host-as-writer entirely (its composer writes them in-pod), so building a
 * per-file exception here would be work with a known expiry. If a mid-session
 * rewrite path appears before that plan lands, this is where it breaks.
 *
 * Lifted from the sibling `nanoco-session-sidecar-k8s`, which has carried it
 * since 2026-08-17 ("pod-driver PVC volume mode ... for the ungoverned child")
 * and which the 2026-08-21 extraction of this skill did not bring across —
 * invisible for four days because all four consuming recipes run the host as a
 * NODE PROCESS, where hostPath is both legal and correct.
 * ────────────────────────────────────────────────────────────────────────── */

/** Set together or not at all; unset leaves hostPath emission byte-identical. */
export interface PodVolumePvc {
  claimName: string;
  root: string;
}

export function podVolumePvc(env: NodeJS.ProcessEnv = process.env): PodVolumePvc | null {
  const dotenv = readEnvFile(['NANOCLAW_POD_VOLUME_PVC', 'NANOCLAW_POD_VOLUME_ROOT']);
  const claimName = env.NANOCLAW_POD_VOLUME_PVC?.trim() || dotenv.NANOCLAW_POD_VOLUME_PVC?.trim() || '';
  const root = env.NANOCLAW_POD_VOLUME_ROOT?.trim() || dotenv.NANOCLAW_POD_VOLUME_ROOT?.trim() || '';
  if (!claimName && !root) return null;
  if (!claimName || !root) {
    throw new Error(
      'NANOCLAW_POD_VOLUME_PVC and NANOCLAW_POD_VOLUME_ROOT select the PVC volume mode together; only ' +
        `${claimName ? 'NANOCLAW_POD_VOLUME_PVC' : 'NANOCLAW_POD_VOLUME_ROOT'} is set`,
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`NANOCLAW_POD_VOLUME_ROOT must be an absolute path, got '${root}'`);
  }
  return { claimName, root: path.normalize(root) };
}

/** One claim per driver, so the pod carries at most one PVC volume under this fixed name. */
const PVC_VOLUME_NAME = 'nanoclaw-pvc';

/**
 * The mount source's path inside the claim (`null` = the claim root itself).
 *
 * A source OUTSIDE the root is refused, never fallen back to hostPath. Two
 * reasons, and the second is why the refusal earns its keep: a fallback would
 * emit the PSA-baseline violation this mode exists to make impossible, visible
 * only as an admission denial naming no cause — and a null-subPath mount would
 * put the WHOLE CLAIM over a single file path. The governed child hits this
 * immediately with its two gateway CAs, which are Secret-projected at
 * /etc/nanoco/pki and therefore outside the tree; they are copied into the tree
 * by an init container rather than special-cased here.
 */
function pvcSubPath(pvc: PodVolumePvc, hostPath: string): string | null {
  const rel = path.relative(pvc.root, path.normalize(hostPath));
  if (rel === '') return null;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw specInvalid(
      `mount source ${hostPath} is outside the PVC volume root ${pvc.root} ` +
        '(NANOCLAW_POD_VOLUME_ROOT); PVC volume mode never falls back to hostPath',
    );
  }
  return rel;
}

/** The sidecar image declares USER 65532; a 64Mi cap matches the reference realization. */
const SIDECAR_MEMORY_MB = 64;
/** gocryptfs needs headroom above 64Mi while unlocking the workspace key. */
const WORKSPACE_MOUNTER_MEMORY_MB = 128;
/** A VM-tier agent needs a stated request: Kata sizes the guest from pod
 * resources, and an unstated main container produced a 224MiB VM that the
 * agent kernel OOM-killed before its first turn. Container-tier behavior stays
 * unbounded unless the operator explicitly sets memoryMb. */
const KATA_AGENT_MEMORY_MB = 4096;
/** What the scheduler RESERVES for a vm-tier agent, distinct from the limit
 * that sizes the Kata guest. Sessions observe ~0.6Gi real use; reserving the
 * full 4Gi capped a 30Gi node at six concurrent agents and left waking
 * sessions OutOfMemory at admission (nancy-v3, 2026-09-01). An operator who
 * sets memoryMb explicitly still gets request == limit — an explicit number
 * is a guarantee, the default is a ceiling. */
const KATA_AGENT_MEMORY_REQUEST_MB = 1024;
// The composer runs the host's composition code once at pod start; it needs
// runtime headroom, not sidecar headroom.
const WORKSPACE_COMPOSER_MEMORY_MB = 256;

export interface PodDriverOptions extends MountPolicy {
  cli?: Cli;
  namespace?: string;
  kataAvailable?: boolean;
  /** Injected for tests; the driver stats hostPaths to choose `File` vs `Directory`. */
  statHostPath?: (hostPath: string) => 'File' | 'Directory' | null;
  /** INTERIM (see the PVC banner above). `undefined` = read the env; `null` forces hostPath. */
  volumePvc?: PodVolumePvc | null;
  /** Injected for tests so the terminating-predecessor wait costs no real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long a delete may take before we stop claiming the pod is gone. */
const DELETE_TIMEOUT_MS = 60_000;
/**
 * How long `prepare` will wait for a terminating predecessor to clear.
 *
 * This is the driver retrying transient infrastructure inside a declared
 * budget, which the seam assigns to drivers; the host owns semantic retries and
 * is not involved. Generous relative to a 1s grace period: the only thing that
 * makes it slow is a node in trouble, and failing fast there would just move the
 * problem to the host as a spurious respawn.
 */
const PREDECESSOR_WAIT_MS = 30_000;
const PREDECESSOR_POLL_MS = 250;
const WATCH_RECOVERY_BASE_MS = 1_000;
const WATCH_RECOVERY_MAX_MS = 30_000;

function sessionKeyId(key: SessionKey): string {
  return `${key.agentGroupId}\0${key.sessionId}`;
}

function activityKeyId(key: SessionKey): string {
  return `${key.installSlug}\0${sessionKeyId(key)}`;
}

export class PodSessionDriver implements SessionDriver {
  readonly kind = 'pod' as const;
  readonly #cli: Cli;
  readonly #ns: string;
  readonly #policy: MountPolicy;
  readonly #stat: (hostPath: string) => 'File' | 'Directory' | null;
  /** INTERIM — see the PVC banner. null = hostPath emission, unchanged. */
  readonly #pvc: PodVolumePvc | null;
  readonly #kata: boolean;
  readonly #kataRuntimeClass: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();
  readonly #activity = new Map<string, boolean>();
  readonly #activityKnown = new Set<string>();

  /** Kubelet activity readiness. `undefined` means the LIST/WATCH source is unavailable. */
  readonly activityStatus = (key: SessionKey): boolean | undefined =>
    this.#activityKnown.has(key.installSlug) ? this.#activity.get(activityKeyId(key)) : undefined;

  /** Kubelet owns destructive liveness for Pod sessions. */
  readonly delegatesLiveness = true;

  constructor(opts: PodDriverOptions) {
    this.#cli = opts.cli ?? realCli('kubectl');
    this.#ns = opts.namespace ?? podNamespace();
    this.#policy = opts;
    this.#stat = opts.statHostPath ?? statHostPath;
    this.#pvc = opts.volumePvc !== undefined ? opts.volumePvc : podVolumePvc();
    // Kata is a declared capability, never a probe result: the flag is set
    // only after the deployment has proved the RuntimeClass, and an unset
    // flag fails closed to the container tier — a vm spec then refuses at
    // prepare instead of silently running un-isolated on runc.
    this.#kata = opts.kataAvailable ?? false;
    this.#kataRuntimeClass = kataRuntimeClass();
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: this.#kata ? ['container', 'vm'] : ['container'],
      // Pod shape, secret-freedom and mount pinning are enforced by admission
      // policy, not by this file — which is why `prepare` is a server-side dry-run.
      admissionEnforced: true,
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      // A pod has no per-pod pids cap: kubelet's PodPidsLimit is node-wide.
      // Recorded as a real hardening reduction rather than faked.
      unrealized: ['pidsLimit'],
      sharedNetworkNamespace: true,
      auxiliaryContainers: true,
      // `buildAgentGroupImage` shells `docker build`; this driver's node has
      // no Docker daemon and its images are imported into containerd out of
      // band (no registry to push a rebuild through either). Declared false
      // so both call sites refuse up front — per the seam rule, features
      // gate on capabilities(), never on `kind`.
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    try {
      this.#cli.run(['version', '--output=json'], { timeoutMs: 10_000 });
      // Only a deployment that declared Kata must hold the class; the probe
      // turns a wrong declaration into a boot-time refusal instead of a
      // per-session apiserver error.
      if (this.#kata) this.#cli.run(['get', 'runtimeclass', this.#kataRuntimeClass, '-o', 'name'], { timeoutMs: 10_000 });
    } catch (error) {
      log.error('Kubernetes API server (or the declared Kata RuntimeClass) is unavailable', { err: error });
      throw new Error('Kubernetes API server (and the declared Kata RuntimeClass) are required', { cause: error });
    }
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    this.#remember(spec.key);
    const pod = this.composePod(spec);
    const name = pod.metadata.name;

    // Idempotency on key: an existing LIVE pod for this key is the session.
    //
    // "Live" is load-bearing and was the bug: the runtime name is derived from
    // the session key, so a pod and its replacement are the same name, and a
    // predecessor stays readable for the whole of its termination. Treating
    // found-by-name as "this session already exists" made a respawn adopt the
    // corpse — no pod was created, and the new runtime's watch then reported the
    // predecessor's own SIGTERM exit as its own death, ~100ms after spawn.
    // `listSessions` already filtered terminating pods; this did not.
    const existing = this.#readPod(name);
    if (existing && !existing.metadata?.deletionTimestamp) {
      if (!podIsTerminal(existing)) {
        return new PodHandle(spec.key, name, this.#ns, this.#cli, null, this.#sleep);
      }
      // D14: terminal-but-undeleted is a corpse, not a session. restartPolicy
      // is Never and the host's finish path deletes nothing, so a runtime that
      // exits BY ITSELF (measured: code mode's clean exit 0 on lease expiry)
      // parks at phase Succeeded with no deletionTimestamp. Adopting it handed
      // back a handle whose watch fired terminal immediately, host-sweep woke
      // for the still-pending mail, and prepare adopted the same corpse again
      // — a one-way respawn loop. Clear it non-blocking and fall into the one
      // predecessor-must-be-gone path below, which owns the wait budget.
      try {
        this.#cli.run(['delete', 'pod', name, '-n', this.#ns, '--ignore-not-found', '--wait=false']);
      } catch (error) {
        throw normalizeKubectlError(error);
      }
    }
    if (existing) {
      // A predecessor is still terminating under our name. Wait it out rather
      // than colliding with it — this is transient infrastructure, which the
      // seam makes the driver's to absorb within a declared budget.
      await this.#awaitPredecessorGone(name);
    }
    this.#activity.delete(activityKeyId(spec.key));

    try {
      // Server-side dry-run runs the full admission chain (our own policy
      // included) and persists nothing. Denials fail prepare, pre-allocation.
      this.#cli.run(['create', '-n', this.#ns, '--dry-run=server', '-o', 'name', '-f', '-'], {
        input: JSON.stringify(pod),
      });
    } catch (error) {
      throw normalizeKubectlError(error);
    }
    return new PodHandle(spec.key, name, this.#ns, this.#cli, pod, this.#sleep);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    let parsed: { items?: V1Pod[] };
    try {
      const out = this.#cli.run([
        'get',
        'pods',
        '-n',
        this.#ns,
        '-l',
        `${LABELS.install}=${installSlug},${LABELS.role}=agent`,
        '-o',
        'json',
      ]);
      parsed = JSON.parse(out) as { items?: V1Pod[] };
    } catch (error) {
      throw normalizeKubectlError(error);
    }
    const listed = new Set<string>();
    const snapshots = (parsed.items ?? []).map((pod): SessionSnapshot => {
        const labels = pod.metadata?.labels ?? {};
        const key: SessionKey = {
          installSlug,
          agentGroupId: labels[LABELS.group] ?? '',
          sessionId: labels[LABELS.session] ?? '',
        };
        this.#remember(key);
        listed.add(activityKeyId(key));
        const terminal = pod.metadata?.deletionTimestamp != null || podIsTerminal(pod);
        this.#rememberActivity(key, pod, terminal);
        const failure = terminal ? terminalFailureOf(pod) : undefined;
        return {
          handle: new PodHandle(key, pod.metadata!.name!, this.#ns, this.#cli, null),
          phase: terminal ? 'terminal' : pod.status?.phase === 'Running' ? 'running' : 'starting',
          ...(failure ? { failure } : {}),
        };
      });
    for (const id of this.#activity.keys()) {
      if (id.startsWith(`${installSlug}\0`) && !listed.has(id)) this.#activity.delete(id);
    }
    this.#activityKnown.add(installSlug);
    return snapshots;
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let process: SupervisedProcess | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;

    const reconcile = async (): Promise<void> => {
      let snapshots: SessionSnapshot[];
      try {
        snapshots = await this.listSessions(installSlug);
      } catch {
        return;
      }
      const listed = new Set(snapshots.map(({ handle }) => sessionKeyId(handle.key)));
      for (const snapshot of snapshots) {
        if (snapshot.phase === 'terminal') onEvent({ key: snapshot.handle.key, kind: 'terminal' });
      }
      for (const [id, key] of this.#knownKeys.get(installSlug) ?? []) {
        if (!listed.has(id)) onEvent({ key, kind: 'terminal' });
      }
    };

    const connect = (reconnected = false): void => {
      const stream = new JsonDocumentStream();
      process = this.#cli.start(
        [
          'get',
          'pods',
          '-n',
          this.#ns,
          '-l',
          `${LABELS.install}=${installSlug},${LABELS.role}=agent`,
          '--watch',
          '--output-watch-events',
          '-o',
          'json',
        ],
        { captureStdout: true },
      );
      process.onStdout((chunk) => {
        attempt = 0;
        this.#activityKnown.add(installSlug);
        for (const doc of stream.push(chunk)) {
          const event = doc as { type?: string; object?: V1Pod };
          const pod = event.object;
          const labels = pod?.metadata?.labels ?? {};
          const agentGroupId = labels[LABELS.group];
          const sessionId = labels[LABELS.session];
          if (!pod || !agentGroupId || !sessionId) continue;
          const key = { installSlug, agentGroupId, sessionId };
          this.#remember(key);
          this.#rememberActivity(key, pod, event.type === 'DELETED' || podIsTerminal(pod));
          onEvent({
            key,
            kind:
              event.type === 'DELETED' || podIsTerminal(pod) || workspaceMounterRestarted(pod)
                ? 'terminal'
                : 'phase',
          });
        }
      });
      process.onExit(() => {
        process = null;
        if (stopped) return;
        this.#activityKnown.delete(installSlug);
        const delay = Math.min(WATCH_RECOVERY_BASE_MS * 2 ** attempt, WATCH_RECOVERY_MAX_MS);
        attempt += 1;
        retry = setTimeout(() => connect(true), delay);
        retry.unref?.();
      });
      if (reconnected) void reconcile();
    };

    connect();
    return {
      stop: () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        process?.kill();
      },
    };
  }

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(sessionKeyId(key), key);
  }

  #rememberActivity(key: SessionKey, pod: V1Pod, terminal: boolean): void {
    const id = activityKeyId(key);
    if (terminal) {
      this.#activity.delete(id);
      return;
    }
    const status = pod.status?.containerStatuses?.find(({ name }) => name === AGENT_CONTAINER_NAME);
    if (status?.ready === undefined) this.#activity.delete(id);
    else this.#activity.set(id, status.ready);
  }

  /** A pod delete is total teardown — hostPath volumes and the netns die with it. */
  async reapResidue(): Promise<void> {}

  async #awaitPredecessorGone(name: string): Promise<void> {
    const deadline = Date.now() + PREDECESSOR_WAIT_MS;
    for (;;) {
      if (!this.#readPod(name)) return;
      if (Date.now() >= deadline) {
        // Never create over a predecessor that will not die: the replacement
        // would inherit its name and, on the next watch event, its death.
        throw asFailureError({
          kind: 'resources-exhausted',
          retryable: true,
        });
      }
      await this.#sleep(PREDECESSOR_POLL_MS);
    }
  }

  #readPod(name: string): V1Pod | null {
    try {
      return JSON.parse(this.#cli.run(['get', 'pod', name, '-n', this.#ns, '-o', 'json'])) as V1Pod;
    } catch {
      return null;
    }
  }

  // ---------- realization: spec → Pod ----------

  composePod(spec: SessionSpec): ComposedPod {
    const agent = spec.containers.find((c) => c.role === 'agent');
    const sidecar = spec.containers.find((c) => c.role === 'egress-sidecar');
    const workspaceMounters = spec.containers.filter((c) => c.role === 'workspace-mounter');
    const workspaceReadyGates = spec.containers.filter((c) => c.role === 'workspace-ready');
    const workspaceComposers = spec.containers.filter((c) => c.role === 'workspace-composer');
    if (workspaceMounters.length > 1 || workspaceReadyGates.length > 1 || workspaceMounters.length !== workspaceReadyGates.length) {
      throw specInvalid('spec requires exactly one workspace mounter and one ready gate');
    }
    if (workspaceComposers.length > 1) {
      throw specInvalid('spec requires at most one workspace composer');
    }
    const workspaceMounter = workspaceMounters[0];
    const workspaceReady = workspaceReadyGates[0];
    const workspaceComposer = workspaceComposers[0];
    const workspaceComposerDbInits = spec.containers.filter((c) => c.role === 'workspace-composer-db');
    if (workspaceComposerDbInits.length > 1) throw specInvalid('spec has more than one workspace composer DB init');
    const workspaceComposerDbInit = workspaceComposerDbInits[0];
    const identityManagers = spec.containers.filter((c) => c.role === 'identity-manager');
    if (identityManagers.length > 1) throw specInvalid('spec has more than one identity manager');
    const identityManager = identityManagers[0];
    if ((workspaceMounter || workspaceReady) && spec.runtimeTier !== 'vm') {
      throw specInvalid('encrypted workspace requires the Kata runtime tier');
    }
    if (!agent) throw deniedByPolicy('spec has no agent container');
    // Fail-closed belt for LANDMINE A: the posture comes from the spec, never
    // from a host-uid heuristic here — only the composer knows the uid that
    // owns the material. A spec that mounts 0600 identity material with no
    // runAs would compose a pod whose sidecar (image USER 65532) dies at mTLS
    // with an EACCES visible only in container logs that do not survive; refuse
    // it at prepare (the server dry-run path), where the error can say what is
    // actually wrong.
    if (!spec.runAs && spec.containers.some((c) => c.mounts.some((m) => m.class === 'identity-material'))) {
      throw specInvalid(
        'spec mounts identity-material but carries no runAs posture; the uid that owns the 0600 material ' +
          'must be explicit in the spec — compose runAs from the host identity for every non-root uid',
      );
    }

    // One volume per unique hostPath. Classes survive as annotations so the
    // admission policy can check class+groupScope against the mount path.
    const volumes = new Map<string, V1Volume>();
    const annotations: Record<string, string> = {};

    const volumeMounts = (container: ContainerSpec): V1VolumeMount[] =>
      orderByMountDepth(container.mounts).map((mount, index) => {
        const volName = mount.source?.name ?? volumeName(mount.hostPath);
        // LANDMINE B: three of these mounts are regular files (container.json,
        // the group CLAUDE.md, /app/CLAUDE.md) plus the cert/CA files. A
        // hardcoded `type: Directory` fails the pod at mount time with a
        // kubelet error that reads nothing like a spec bug. `subPath` is NOT an
        // alternative: the host rewrites those files fresh on every spawn, and a
        // subPath mount does not pick up the replacement inode.
        if (mount.source?.kind === 'emptyDir') {
          volumes.set(volName, {
            name: volName,
            emptyDir: {
              ...(mount.source.medium ? { medium: mount.source.medium } : {}),
              ...(mount.source.sizeLimit ? { sizeLimit: mount.source.sizeLimit } : {}),
            },
          });
        } else if (mount.source?.kind === 'secret') {
          volumes.set(volName, {
            name: volName,
            secret: {
              secretName: mount.source.secretName,
              items: [{ key: mount.source.key, path: mount.source.key }],
              ...(mount.source.mode !== undefined ? { defaultMode: mount.source.mode } : {}),
            },
          });
        } else if (mount.source?.kind === 'hostPath') {
          if (mount.hostPath !== mount.source.path) throw specInvalid('workspace hostPath source disagrees with mount path');
          volumes.set(volName, { name: volName, hostPath: { path: mount.source.path, type: mount.source.type } });
        } else {
          const type = this.#stat(mount.hostPath);
          if (type === null) throw specInvalid(`mount source missing on node: ${mount.hostPath}`);
          if (this.#pvc) {
            const subPath = pvcSubPath(this.#pvc, mount.hostPath);
            volumes.set(PVC_VOLUME_NAME, {
              name: PVC_VOLUME_NAME,
              persistentVolumeClaim: { claimName: this.#pvc.claimName },
            });
            annotations[`nanoclaw.dev/mount.${container.role}.${index}`] =
              `${mount.class}:${mount.groupScope}:${mount.containerPath}:${mount.mode}`;
            return {
              name: PVC_VOLUME_NAME,
              mountPath: mount.containerPath,
              ...(subPath !== null ? { subPath } : {}),
              readOnly: mount.mode === 'ro',
            };
          }
          volumes.set(volName, { name: volName, hostPath: { path: mount.hostPath, type } });
        }
        annotations[`nanoclaw.dev/mount.${container.role}.${index}`] =
          `${mount.class}:${mount.groupScope}:${mount.containerPath}:${mount.mode}`;
        return {
          name: volName,
          mountPath: mount.containerPath,
          readOnly: mount.mode === 'ro',
          ...(mount.subPath ? { subPath: mount.subPath } : {}),
        };
      });

    if (spec.resources.shmSizeMb) {
      // Docker's `--shm-size`; without it /dev/shm is 64Mi and a browser
      // launcher silently short-writes past that.
      volumes.set('dev-shm', {
        name: 'dev-shm',
        emptyDir: { medium: 'Memory', sizeLimit: `${spec.resources.shmSizeMb}Mi` },
      });
    }

    const container = (spec_: ContainerSpec): V1Container => {
      const storageEnvironment = spec_.role === 'agent' ? agentStorageEnvironment() : {};
      const storageCollision =
        spec_.role === 'agent' &&
        AGENT_STORAGE_ENV_KEYS.find((key) => key in spec_.env && spec_.env[key] !== storageEnvironment[key]);
      if (storageCollision) {
        throw specInvalid(`agent spec env conflicts with host-managed storage coordinate ${storageCollision}`);
      }
      const mounts = volumeMounts(spec_);
      const role = spec_.role;
      // A legacy in-guest workspace mounter publishes this shared mount. The
      // trusted-node Custodian design binds the composer's hostPath mounts
      // directly, so this branch is normally absent there.
      if (workspaceMounter && ['agent', 'workspace-mounter', 'workspace-ready', 'workspace-composer'].includes(role)) {
        mounts.push({
          name: 'workspace-group',
          mountPath: '/workspace/group',
          mountPropagation: role === 'workspace-mounter' ? 'Bidirectional' : 'HostToContainer',
        });
      }
      if (spec_.role === 'agent' && spec.resources.shmSizeMb) {
        mounts.push({ name: 'dev-shm', mountPath: '/dev/shm' });
      }
      const memoryMb = spec_.role === 'agent'
        ? spec.resources.memoryMb ?? (spec.runtimeTier === 'vm' && this.#kata ? KATA_AGENT_MEMORY_MB : undefined)
        : spec_.role === 'workspace-mounter'
          ? WORKSPACE_MOUNTER_MEMORY_MB
          : spec_.role === 'workspace-composer'
            ? WORKSPACE_COMPOSER_MEMORY_MB
            : SIDECAR_MEMORY_MB;
      const limits: Record<string, string> = {};
      const requests: Record<string, string> = {};
      // Deliberate: the Docker path leaves memory unbounded unless an operator
      // opted in, so an unconditional limit here would be a behavior change
      // dressed up as a port.
      if (memoryMb) limits.memory = `${memoryMb}Mi`;
      if (memoryMb && spec.runtimeTier === 'vm' && this.#kata) {
        const reservedMb = spec_.role === 'agent' && spec.resources.memoryMb === undefined
          ? Math.min(memoryMb, KATA_AGENT_MEMORY_REQUEST_MB)
          : memoryMb;
        requests.memory = `${reservedMb}Mi`;
      }
      if (spec_.role === 'agent' && spec.resources.cpus) limits.cpu = spec.resources.cpus;
      return {
        name: spec_.role,
        image: spec_.image,
        // LANDMINE C: the agent image's real entrypoint is
        // ["/usr/bin/tini","--","/app/entrypoint.sh"]. A bare ["bash","-c",...]
        // makes the runtime PID 1 with no signal handler, and at
        // terminationGracePeriodSeconds: 1 every stop degrades to SIGKILL.
        // Reaping and signal forwarding are part of the 'standard' posture —
        // Docker realizes them as `--init`, and a pod has no equivalent, so this
        // driver realizes them by keeping the image's own tini as PID 1.
        ...(spec_.command
          ? { command: role === 'workspace-mounter' ? spec_.command : withInit(spec.hardening, spec_.command) }
          : {}),
        ...(spec_.args ? { args: spec_.args } : {}),
        env: [
          // LANDMINE D — identity without a passwd entry. `runAs` pins the
          // host uid onto the pod (LANDMINE A), and the agent image's
          // /etc/passwd does not know that uid, so HOME resolves to '/' and
          // the first provider that writes under ~ dies EACCES at boot (first
          // contact: the Claude SDK's mkdir ~/.claude killed every
          // provisioned-agent session in ~100ms). Docker never hits this: it
          // runs the image's own USER, whose passwd row carries a real HOME.
          // Same fix as the governance manifest's HOME=/tmp — point HOME at
          // the agent's writable ephemeral scratch, which matches the Docker
          // path's ephemerality. A composition-provided HOME wins.
          ...(spec_.role === 'agent' && spec.runAs && !('HOME' in spec_.env) ? [{ name: 'HOME', value: '/tmp' }] : []),
          ...Object.entries({
            ...spec_.env,
            ...spec_.contributedEnv,
            ...spec_.sensitiveEnv,
            ...storageEnvironment,
          }).map(([name, value]) => ({ name, value })),
        ],
        volumeMounts: mounts,
        securityContext: {
          ...(role === 'workspace-mounter'
            ? {
                privileged: true,
                allowPrivilegeEscalation: true,
                capabilities: { add: ['MKNOD', 'SYS_ADMIN'], drop: ['ALL'] },
                seccompProfile: { type: 'Unconfined' },
              }
            : {
                allowPrivilegeEscalation: false,
                capabilities:
                  role === 'workspace-composer-db' ? { add: ['CHOWN'], drop: ['ALL'] } : { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              }),
          // Posture by role: the sidecar's rootfs is read-only, the agent's is
          // writable ephemeral scratch.
          readOnlyRootFilesystem: role === 'egress-sidecar' || role === 'identity-manager' || role === 'workspace-composer-db',
          // LANDMINE A: fsGroup does not apply to hostPath volumes, so ordinary
          // containers inherit the host identity. The trusted mounter starts as
          // guest root only to create Kata's missing /dev/fuse device.
          ...(['workspace-mounter', 'workspace-composer-db'].includes(role)
            ? { runAsNonRoot: false, runAsUser: 0, runAsGroup: 0 }
            : spec.runAs
              ? { runAsUser: spec.runAs.uid, runAsGroup: spec.runAs.gid }
              : {}),
        },
        ...(Object.keys(limits).length > 0
          ? { resources: { limits, ...(Object.keys(requests).length > 0 ? { requests } : {}) } }
          : {}),
      };
    };

    const agentContainer = container(agent);
    agentContainer.readinessProbe = {
      exec: { command: ['/usr/local/bin/nanoclaw-agent-health', 'readiness'] },
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 1,
      successThreshold: 1,
    };
    agentContainer.livenessProbe = {
      exec: { command: ['/usr/local/bin/nanoclaw-agent-health', 'liveness'] },
      periodSeconds: 60,
      timeoutSeconds: 10,
      failureThreshold: 3,
      successThreshold: 1,
    };
    const sidecarContainer = sidecar ? container(sidecar) : null;
    if (sidecarContainer) {
      // Gate on the LISTENER, not on the process: `restartPolicy: Always`
      // alone lets the agent start as soon as this container is running, and
      // the agent's first call goes through it. tcpSocket is the same check
      // the Custodian's sidecar uses, at the same cadence.
      sidecarContainer.startupProbe = {
        tcpSocket: { port: 15001 },
        periodSeconds: 1,
        failureThreshold: 30,
      };
    }
    const workspaceMounterContainer = workspaceMounter ? container(workspaceMounter) : null;
    const workspaceReadyContainer = workspaceReady ? container(workspaceReady) : null;
    const workspaceComposerContainer = workspaceComposer ? container(workspaceComposer) : null;
    const workspaceComposerDbInitContainer = workspaceComposerDbInit ? container(workspaceComposerDbInit) : null;
    const identityManagerContainer = identityManager ? container(identityManager) : null;
    if (identityManagerContainer) {
      identityManagerContainer.startupProbe = {
        exec: { command: ['/bin/sh', '-c', 'test -s /run/nanoco/identity/session-cert.pem && test -s /run/nanoco/identity/session-key.pem'] },
        periodSeconds: 1,
        failureThreshold: 30,
      };
    }
    if (workspaceMounterContainer) {
      volumes.set('workspace-group', { name: 'workspace-group', emptyDir: {} });
    }
    // The volume stays; the workspace composer seeds it (materializer.ts
    // seedHeartbeat) instead of a dedicated `heartbeat-init` container.
    volumes.set(HEARTBEAT_VOLUME_NAME, { name: HEARTBEAT_VOLUME_NAME, emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
    agentContainer.volumeMounts.push({ name: HEARTBEAT_VOLUME_NAME, mountPath: HEARTBEAT_PATH, subPath: '.heartbeat' });

    const labels = labelsForKey(spec.key, 'agent', { ...spec.labels, ...(agent.labels ?? {}) });
    // The group-folder label must reach the pod VERBATIM — deliberately the
    // OPPOSITE of the 63-byte projection every other label gets below. The
    // projection exists for lineage labels nothing joins on; this label is
    // an admission JOIN KEY: the policy pins `groups/<folder>` hostPaths by
    // string-concatenating the label into the required prefix
    // (`path.startsWith(GROUPS + '/' + label + '/')`), and CEL cannot invert
    // a hash-suffix projection. A projected value would have the policy
    // compare the real folder against a truncated stand-in and deny every
    // session of that group — surfacing "this folder name cannot be a k8s
    // label" as an admission denial that names the wrong culprit. So an
    // unlabelable folder refuses here, loudly and non-retryably, where the
    // error can say what is actually wrong.
    const folder = labels[GROUP_FOLDER_LABEL];
    if (folder !== undefined && !k8sLabelValueLegal(folder)) {
      throw specInvalid(
        `group folder '${folder}' cannot be carried verbatim as the ${GROUP_FOLDER_LABEL} label ` +
          `(k8s label values: <=63 bytes of [A-Za-z0-9._-], alphanumeric at both ends); admission joins ` +
          `on this label verbatim so it is never projected — rename the group folder`,
      );
    }

    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName(spec),
        namespace: this.#ns,
        labels: k8sLegalLabels(labels),
        annotations: {
          ...annotations,
          ...(spec.workspace ? {
            'nanoco.ai/workspace-group-id': spec.workspace.groupId,
            'nanoco.ai/workspace-session-id': spec.workspace.sessionId,
            'nanoco.ai/workspace-runtime-tier': spec.workspace.runtimeTier,
          } : {}),
        },
        ...(spec.workspace ? { finalizers: ['nanoco.ai/workspace-checkpoint'] } : {}),
      },
      spec: {
        // Restart policy belongs to the host, never the runtime.
        restartPolicy: 'Never',
        terminationGracePeriodSeconds: spec.stopGraceSeconds,
        enableServiceLinks: false,
        automountServiceAccountToken: false,
        ...(spec.workspace ? { nodeName: spec.workspace.nodeName } : {}),
        // The class is named only when the spec asks for the vm tier AND the
        // deployment declared it available; composition never invents one.
        ...(spec.runtimeTier === 'vm' && this.#kata ? { runtimeClassName: this.#kataRuntimeClass } : {}),
        securityContext: {
          runAsNonRoot: true,
          ...(spec.runAs
            ? { runAsUser: spec.runAs.uid, runAsGroup: spec.runAs.gid, fsGroup: spec.runAs.gid }
            : {}),
        },
        // Workspace mounter and egress sidecar start before the agent. The
        // ready gate is a regular init container so it blocks until the FUSE
        // mount is visible through the shared emptyDir. The workspace composer
        // is a regular init container too: it materializes the workspace and
        // exits before the agent starts (ordered after the mount is published
        // on tiers that have one).
        initContainers: [
          ...(workspaceComposerDbInitContainer ? [workspaceComposerDbInitContainer] : []),
          ...(workspaceMounterContainer ? [{ ...workspaceMounterContainer, restartPolicy: 'Always' }] : []),
          ...(workspaceReadyContainer ? [workspaceReadyContainer] : []),
          ...(workspaceComposerContainer ? [workspaceComposerContainer] : []),
          ...(identityManagerContainer ? [{ ...identityManagerContainer, restartPolicy: 'Always' }] : []),
          ...(sidecarContainer ? [{ ...sidecarContainer, restartPolicy: 'Always' }] : []),
        ],
        containers: [agentContainer],
        volumes: [...volumes.values()],
        // spec.network 'shared-private' is inherent: one pod, one netns,
        // localhost between containers. Reachability is the NetworkPolicy's job.
      },
    };
  }
}

class PodHandle implements SessionHandle {
  #terminalCb: ((failure?: SessionFailure) => void) | null = null;
  #terminalFired = false;
  #stopping = false;
  #started = false;
  #watch: SupervisedProcess | null = null;

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly ns: string,
    private readonly cli: Cli,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly pendingPod: V1Pod | null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  ) {}

  execSpec(command: string[]): SessionExecSpec {
    const target = ['-n', this.ns, this.name, '-c', AGENT_CONTAINER_NAME, '--', ...command];
    return {
      bin: 'kubectl',
      argsTty: ['exec', '-i', '-t', ...target],
      argsPlain: ['exec', '-i', ...target],
    };
  }

  async start(): Promise<void> {
    if (this.pendingPod && !this.#started) {
      try {
        this.cli.run(['create', '-n', this.ns, '-o', 'name', '-f', '-'], { input: JSON.stringify(this.pendingPod) });
      } catch (error) {
        throw normalizeKubectlError(error);
      }
    }
    this.#started = true;
    this.watchForTerminal();
  }

  /** Supervision: terminal only after the whole pod (including native sidecars) has stopped. */
  watchForTerminal(): void {
    if (this.#watch) return;
    const stream = new JsonDocumentStream();
    const watch = this.cli.start(
      ['get', 'pod', this.name, '-n', this.ns, '--watch', '--output-watch-events', '-o', 'json'],
      { captureStdout: true },
    );
    this.#watch = watch;
    watch.onStdout((chunk) => {
      for (const doc of stream.push(chunk)) {
        const event = doc as { type?: string; object?: V1Pod };
        if (this.#stopping || this.#terminalFired) return;
        if (event.type === 'DELETED') {
          this.fireTerminal(undefined);
          return;
        }
        if (event.object && workspaceMounterRestarted(event.object)) {
          void this.stop('workspace-mounter-restarted').then(
            () => this.fireTerminal({ kind: 'started-then-died', retryable: false }),
            () => {
              // The writer may still be alive. Keep supervising instead of
              // reporting a terminal event that would let the host checkpoint.
              this.#stopping = false;
              void this.recoverWatch();
            },
          );
          return;
        }
        const phase = event.object?.status?.phase;
        if (event.object && (phase === 'Succeeded' || phase === 'Failed')) {
          this.fireTerminal(terminalFailureOf(event.object));
        }
      }
    });
    watch.onExit(() => {
      this.#watch = null;
      // The watch closing is not itself terminal — the apiserver drops long
      // watches routinely. But nothing polls: `status()` has exactly one caller
      // in the tree, at startup. So an unrecovered drop ends supervision for the
      // life of the session just as surely as never arming it.
      if (this.#stopping || this.#terminalFired) return;
      void this.recoverWatch();
    });
  }

  /**
   * Re-establish supervision after a dropped watch, or report the end we missed
   * while it was down. Backs off so a persistently failing watch cannot spin,
   * and never gives up: blindness is worse than retrying.
   */
  private async recoverWatch(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.sleep(Math.min(WATCH_RECOVERY_BASE_MS * 2 ** attempt, WATCH_RECOVERY_MAX_MS));
      if (this.#stopping || this.#terminalFired) return;
      const status = await this.status().catch(() => null);
      if (!status) continue;
      if (status.phase === 'stopped') {
        this.fireTerminal(undefined);
        return;
      }
      if (status.phase === 'failed') {
        if (status.failure.kind === 'started-then-died') {
          try {
            await this.stop('terminal-failure');
          } catch {
            // A failed delete does not prove the writer is gone. Retry through
            // the bounded watch-recovery backoff without firing terminal.
            this.#stopping = false;
            continue;
          }
        }
        this.fireTerminal(status.failure);
        return;
      }
      this.watchForTerminal();
      if (this.#watch) return;
    }
  }

  async status(): Promise<SessionStatus> {
    let pod: V1Pod;
    try {
      pod = JSON.parse(this.cli.run(['get', 'pod', this.name, '-n', this.ns, '-o', 'json'])) as V1Pod;
    } catch {
      // Before start, an absent pod means prepared-but-not-created. After it,
      // the same absence means the session is gone — reporting 'ready' there
      // told watch recovery to re-arm on a pod that no longer exists, so a
      // death during a watch gap was never reported at all.
      return this.pendingPod && !this.#started ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const settled = pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed';
    const failure =
      (settled || workspaceMounterRestarted(pod) ? terminalFailureOf(pod) : undefined) ?? pendingFailureOf(pod);
    if (failure) return { phase: 'failed', failure };
    switch (pod.status?.phase) {
      case 'Running':
        return { phase: 'running' };
      case 'Pending':
        return { phase: 'preparing' };
      case 'Succeeded':
      case 'Failed':
        return { phase: 'stopped' };
      default:
        return { phase: 'preparing' };
    }
  }

  async stop(reason: string): Promise<void> {
    // Full teardown is one operation: the pod is the only allocated object
    // (volumes are hostPath; the netns dies with the pod).
    this.#stopping = true;
    this.#watch?.kill();
    this.#watch = null;
    log.info('Deleting session pod', { pod: this.name, reason });
    try {
      // This delete BLOCKS until the pod is gone, deliberately: `stop()` must
      // mean gone, not accepted. The host fires its exit callbacks — including
      // the respawn — when this resolves, so returning early hands the
      // replacement a name its predecessor still holds. A non-blocking delete
      // is the better default nearly everywhere, which is exactly why this
      // needs saying. Verify by reading the argv below, not by grepping this
      // file for the flag that is absent from it.
      this.cli.run(['delete', 'pod', this.name, '-n', this.ns, '--ignore-not-found'], {
        timeoutMs: DELETE_TIMEOUT_MS,
      });
    } catch (error) {
      // A delete that did not complete must not be reported as a completed
      // stop, or the ordering guarantee is silently false again — and worse:
      // the host's kill path revokes the session's lease after a completed
      // stop, so a swallowed failure here inverted teardown into
      // revoke-without-delete, the exact crash shape D1 forbids (measured: a
      // dying host revoked the surviving session's lease but never deleted its
      // pod, and the successor adopted a Running pod whose egress was dead).
      // Rejecting lets the caller finalize WITHOUT revocation: the unrevoked
      // lease of a still-running pod is re-adopted or expires on its own
      // horizon, and the un-deleted pod is handled by prepare's
      // terminating-predecessor logic on the next wake.
      log.error('Session pod delete did not complete; it may still be terminating', {
        pod: this.name,
        reason,
        err: error,
      });
      throw normalizeKubectlError(error);
    }
  }

  onTerminal(cb: (failure?: SessionFailure) => void): void {
    this.#terminalCb = cb;
    // Arm supervision here ONLY for an adopted handle, whose pod already exists
    // and for which start() is never called.
    //
    // Doing it unconditionally was a deterministic bug, not a race: the host
    // arms onTerminal before start(), so for a prepared handle the pod does not
    // exist yet. Watching a name with no object behind it does not block — it
    // prints NotFound and exits within ~100ms — but the doomed process is
    // assigned to #watch synchronously, and `start()` creates the pod with a
    // BLOCKING call, so the event loop cannot turn and deliver that exit. The
    // guard at the top of watchForTerminal then sees a live #watch and declines
    // to start the real one. The doomed process exits, nulls #watch, and the
    // session runs unsupervised for the rest of its life: no terminal event, so
    // it is never removed from the registry, isContainerRunning stays true, and
    // no replacement is ever spawned.
    if (!this.pendingPod) this.watchForTerminal();
  }

  private fireTerminal(failure?: SessionFailure): void {
    if (this.#terminalFired) return;
    this.#terminalFired = true;
    this.#watch?.kill();
    this.#watch = null;
    this.#terminalCb?.(failure);
  }
}

// ---------- failure normalization ----------

export function normalizeKubectlError(error: unknown): Error & SessionFailure {
  const msg = errorText(error);
  // The ValidatingAdmissionPolicy alternative is MEASURED, not guessed: a VAP
  // denial at `create --dry-run=server` comes back as a 422 Invalid —
  //   `The pods "x" is invalid: : ValidatingAdmissionPolicy 'name' with
  //    binding 'name-binding' denied request: <message>`
  // — so neither `is forbidden` (403 phrasing) nor `denied the request`
  // (webhook phrasing, with the article) ever matches it, and without this
  // alternative every admission denial classified as `unknown`. Keyed on the
  // full `ValidatingAdmissionPolicy … denied request` shape rather than bare
  // `denied request` so ordinary permission errors cannot ride it.
  const failure: SessionFailure = /admission webhook .* denied|is forbidden|violates PodSecurity|denied the request|ValidatingAdmissionPolicy '[^']*' with binding '[^']*' denied request/i.test(
    msg,
  )
    ? { kind: 'denied-by-policy', retryable: false, detail: msg.slice(0, 200) }
    : /ImagePullBackOff|ErrImagePull|not found: manifest|failed to pull/i.test(msg)
      ? { kind: 'image-unavailable', retryable: true }
      : /connection (to the server was )?refused|couldn't get current server API group list|Unable to connect to the server|no such host|i\/o timeout|TLS handshake timeout|EOF/i.test(
            msg,
          )
        ? { kind: 'runtime-unavailable', retryable: true }
        : /Insufficient|exceeded quota|Unschedulable/i.test(msg)
          ? { kind: 'resources-exhausted', retryable: true }
          : { kind: 'unknown', retryable: false, opaqueRef: `k8s-${Date.now()}` };
  if (failure.kind === 'denied-by-policy') {
    // The typed seam keeps the detail, but Error serializers normally emit
    // only message/stack. Without this line the policy name and failed rule
    // disappear from the only durable runtime log.
    log.warn('Pod driver: Kubernetes admission denied the session pod', { detail: failure.detail });
  }
  if (failure.kind === 'unknown') {
    // The seam stays opaque for unrecognized errors BY CONTRACT (the raw text
    // can carry sensitive strings — the test pins it), but the raw text must
    // land SOMEWHERE or an unclassified kubectl failure is undiagnosable from
    // the only log that survives. This driver-side line, keyed by the same
    // opaqueRef that crosses the seam, is that somewhere. First contact: a
    // provisioned-agent spawn failed 'unknown' on every wake and the real
    // kubectl stderr existed nowhere on the node.
    log.warn('Pod driver: unclassified kubectl failure', { opaqueRef: failure.opaqueRef, detail: msg.slice(0, 300) });
  }
  return asFailureError(failure);
}

export function terminalFailureOf(pod: V1Pod): SessionFailure | undefined {
  if (pod.metadata?.annotations?.['nanoco.ai/workspace-recovery'] === 'true') {
    return { kind: 'runtime-unavailable', retryable: true };
  }
  if (workspaceMounterRestarted(pod)) return { kind: 'started-then-died', retryable: false };
  const agent = pod.status?.containerStatuses?.find((s) => s.name === AGENT_CONTAINER_NAME);
  const terminated = agent?.state?.terminated;
  if (terminated && terminated.exitCode !== 0) {
    return { kind: 'started-then-died', retryable: false, exitCode: terminated.exitCode };
  }
  if (terminated) return { kind: 'started-then-died', retryable: false, exitCode: 0 };
  if (pod.status?.phase === 'Failed') return { kind: 'started-then-died', retryable: false };
  return undefined;
}

/**
 * A pod whose run has ENDED, whatever `status.phase` reads at this instant:
 * Succeeded/Failed are the settled forms, and an agent container that has
 * already terminated counts even while the phase is still catching up —
 * `terminalFailureOf` reads exactly that gap. Used by `prepare` to tell a
 * corpse from a live session; a merely Pending/Running pod is never terminal.
 */
export function podIsTerminal(pod: V1Pod): boolean {
  const phase = pod.status?.phase;
  return phase === 'Succeeded' || phase === 'Failed' || terminalFailureOf(pod) !== undefined;
}

function workspaceMounterRestarted(pod: V1Pod): boolean {
  return Boolean(pod.status?.initContainerStatuses?.some(
    (status) => ['workspace-mounter', 'identity-manager', 'egress-sidecar'].includes(status.name ?? '') &&
      (status.restartCount ?? 0) > 0,
  ));
}

export function pendingFailureOf(pod: V1Pod): SessionFailure | undefined {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  for (const status of statuses) {
    const reason = status.state?.waiting?.reason;
    if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') {
      return { kind: 'image-unavailable', retryable: true };
    }
  }
  const unschedulable = pod.status?.conditions?.some((c) => c.type === 'PodScheduled' && c.reason === 'Unschedulable');
  if (unschedulable) return { kind: 'resources-exhausted', retryable: true };
  return undefined;
}

// ---------- small helpers ----------

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const withStderr = error as { stderr?: Buffer | string; message?: string };
    const stderr = withStderr.stderr ? String(withStderr.stderr) : '';
    return `${withStderr.message ?? ''} ${stderr}`.trim();
  }
  return String(error);
}

/** The blessed image's own init, at the path its real entrypoint already uses. */
export const TINI_PATH = '/usr/bin/tini';

export function withInit(hardening: SessionSpec['hardening'], command: string[]): string[] {
  if (hardening !== 'standard') return command;
  if (command[0] === TINI_PATH) return command;
  return [TINI_PATH, '--', ...command];
}

export function orderByMountDepth<T extends { containerPath: string }>(mounts: readonly T[]): T[] {
  const depth = (p: string): number => p.split('/').filter(Boolean).length;
  return [...mounts].sort((a, b) => depth(a.containerPath) - depth(b.containerPath));
}

/**
 * `statSync`, and it MUST NOT go back to `lstatSync`.
 *
 * Kubernetes projects a Secret or ConfigMap volume as a directory of SYMLINKS
 * into a timestamped `..data/` sibling — that indirection is how it swaps a
 * whole volume atomically on update. `lstatSync` does not follow a symlink, so
 * for every secret-mounted file it reports neither file nor directory, this
 * returns null, and the caller concludes the material is absent.
 *
 * Measured in a live child, on a file that is present and readable:
 *
 *   /etc/nanoco/pki/gateway-server-ca.pem -> ..data/gateway-server-ca.pem
 *   lstatSync : isSymbolicLink=true  -> null      <- refused
 *   statSync  : File, readable, 1537 bytes        <- correct
 *
 * The consequence was not a bad error message. `PodSessionSidecarDriver`
 * pre-stats its three mounts and throws "session channel material is not
 * present on the node"; the sidecar manager then catches that, discards it, and
 * rethrows "NanoCo session sidecar failed to start". So a governed child could
 * accept a turn, provision a session channel, mint its material, and then never
 * spawn a session pod — retrying every 60s, blaming the sidecar for a stat.
 *
 * It never bit the parent because a host running outside the cluster reads real
 * files from disk. It bites every host that runs AS A POD, which is exactly what
 * a child is. The sibling `nanoco-session-sidecar-k8s` already had it right;
 * this copy diverged.
 *
 * A dangling symlink still answers null, because `statSync` throws on one — the
 * check keeps refusing material that genuinely is not there.
 */
export function statHostPath(hostPath: string): 'File' | 'Directory' | null {
  try {
    const entry = fs.statSync(hostPath);
    if (entry.isDirectory()) return 'Directory';
    if (entry.isFile()) return 'File';
    return null;
  } catch {
    return null;
  }
}

/**
 * Project one label value onto Kubernetes' 63-byte cap. The seam's labels
 * carry no length contract — Docker accepts any value, and the composer's
 * `nanoclaw-container-name` lineage label is `nanoclaw-v2-<folder>-<epochms>`,
 * which clears 63 only while group folders are short. First contact: the
 * governance-minted group's uuid folder pushed it to 69 bytes and the API
 * server rejected every pod at prepare's dry-run ("must be no more than 63
 * bytes"), so no provisioned agent could ever spawn. An overlong value keeps
 * its readable prefix and gains a deterministic hash suffix, so two long
 * values cannot collapse into the same truncation; values already legal pass
 * through byte-identical (the adoption-contract labels — uuid group ids,
 * session ids — are all far under the cap).
 */
export function k8sLabelValue(value: string): string {
  if (value.length <= 63) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${value.slice(0, 54)}-${digest}`;
}

/**
 * A legal Kubernetes label VALUE, verbatim: <=63 bytes, `[A-Za-z0-9._-]`,
 * alphanumeric at both ends (empty is legal). The charset is ASCII-only, so
 * for any value that passes, `length` counts bytes. Used to decide when a
 * value may NOT be projected: `GROUP_FOLDER_LABEL` is an admission join key
 * and must be refused, not capped, when it fails this (see composePod).
 */
export function k8sLabelValueLegal(value: string): boolean {
  return value.length <= 63 && /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(value);
}

export function k8sLegalLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, k8sLabelValue(value)]));
}

/** RFC 1123 label: lowercase alphanumeric and '-', 63 chars, must start/end alphanumeric. */
export function podName(spec: SessionSpec): string {
  const base = `ncl-${dnsSafe(spec.key.installSlug)}-${dnsSafe(spec.key.sessionId)}`;
  return base.slice(0, 63).replace(/-+$/, '');
}

function dnsSafe(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 24) || 'x';
}

export function volumeName(hostPath: string): string {
  let hash = 0;
  for (let i = 0; i < hostPath.length; i++) hash = ((hash << 5) - hash + hostPath.charCodeAt(i)) | 0;
  return `v-${Math.abs(hash).toString(36)}`;
}

// ---------- the slice of the Pod API this driver touches ----------

export interface V1VolumeMount {
  name: string;
  mountPath: string;
  /** INTERIM — PVC volume mode only; see the banner above `podVolumePvc`. */
  subPath?: string;
  readOnly?: boolean;
  mountPropagation?: 'HostToContainer' | 'Bidirectional';
}
export interface V1Volume {
  name: string;
  hostPath?: { path: string; type: 'File' | 'Directory' };
  /** INTERIM — PVC volume mode only; see the banner above `podVolumePvc`. */
  persistentVolumeClaim?: { claimName: string };
  emptyDir?: { medium?: string; sizeLimit?: string };
  secret?: { secretName: string; items: Array<{ key: string; path: string }>; defaultMode?: number };
}
export interface V1Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env: Array<{ name: string; value: string }>;
  volumeMounts: V1VolumeMount[];
  securityContext: Record<string, unknown>;
  resources?: { limits: Record<string, string>; requests?: Record<string, string> };
  restartPolicy?: string;
  startupProbe?: { exec?: { command: string[] }; tcpSocket?: { port: number }; periodSeconds: number; failureThreshold: number };
  readinessProbe?: V1ExecProbe;
  livenessProbe?: V1ExecProbe;
}
interface V1ExecProbe {
  exec: { command: string[] };
  periodSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
}
/** A pod this driver composed: name and metadata are known present. */
export type ComposedPod = V1Pod & { metadata: { name: string } };

export interface V1Pod {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
  };
  spec?: Record<string, unknown>;
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; reason?: string }>;
    containerStatuses?: V1ContainerStatus[];
    initContainerStatuses?: V1ContainerStatus[];
  };
}
interface V1ContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string }; terminated?: { exitCode: number } };
}
