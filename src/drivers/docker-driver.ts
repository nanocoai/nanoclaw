/**
 * Docker driver — the permanent OSS/dev realization.
 *
 * Everything an orchestrator-backed driver would get for free (ordering, GC,
 * admission) is done here explicitly, in code. That asymmetry is the point:
 * same spec in, same observable semantics out, different amount of
 * choreography.
 *
 * This file is where `container-runtime.ts`'s helpers and the runtime half of
 * `container-runner.ts` (argv assembly, kill/stop, orphan listing) end up.
 * `container-runner.ts` keeps composition and lifecycle policy only.
 *
 * Network topology note: on Docker the containers of a session do NOT share a
 * network namespace — an auxiliary container's uplink here is a routable bridge, so
 * a netns-join would hand the agent the whole internet and delete the lockdown
 * the private network provides. `capabilities.sharedNetworkNamespace = false`
 * is how an egress overlay learns to address such a container by name here rather
 * than by localhost.
 */
import { createHash } from 'crypto';
import fs from 'fs';

import { log } from '../log.js';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from './cli.js';
import { JsonDocumentStream } from './json-stream.js';
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
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

export interface DockerDriverOptions extends MountPolicy {
  cli?: Cli;
  /** Docker network the session's containers attach to, resolved by the overlay. */
  networkArgsFor?: (spec: SessionSpec) => string[];
}

/** Watch reconnection: bounded backoff, never give up (see `watchSessions`). */
const WATCH_RECOVERY_BASE_MS = 1_000;
const WATCH_RECOVERY_MAX_MS = 30_000;

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  attempt: number;
}

export class DockerSessionDriver implements SessionDriver {
  readonly kind = 'docker' as const;
  readonly #cli: Cli;
  readonly #policy: MountPolicy;
  /** One `docker events` subscription per install slug — never per session. */
  readonly #watches = new Map<string, InstallWatch>();
  /**
   * Every key this driver ever handed out (prepare or list), per install.
   * `#reconcileWatchGap` hints these on watch reconnect: a `--rm` container
   * that died while the subscription was down is gone from `ps -a` too, so
   * the re-list alone cannot name it — only this registry can.
   */
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();

  constructor(private readonly opts: DockerDriverOptions) {
    this.#cli = opts.cli ?? realCli('docker');
    this.#policy = opts;
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false, // mount pinning is enforced in code, not structurally
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      sharedNetworkNamespace: false,
      // Realizes the agent container only, and REFUSES specs carrying more —
      // see the role check in `prepare`. Flips only when this driver actually
      // manages auxiliary containers, never before.
      auxiliaryContainers: false,
      // The daemon this driver shells for sessions is the same one
      // buildAgentGroupImage builds against; rebuild-in-place is real here.
      imageBuild: true,
    };
  }

  async ensureReady(): Promise<void> {
    ensureDockerRunning(this.#cli);
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());

    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      // Refusal, not omission. This driver realizes the agent container only,
      // and a spec is a statement of what the session IS — realizing a subset
      // would validate containers that never exist, leaving (say) a dead proxy
      // address in the agent's env to be discovered at first egress instead of
      // here. Composition gates on capabilities().auxiliaryContainers, so this
      // is the backstop for a composer that did not.
      throw specInvalid(
        `docker driver does not manage container role '${extra[0].role}'; ` +
          `auxiliary containers require a driver with capabilities().auxiliaryContainers`,
      );
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = validateRuntimeName(agentContainerName(spec), 'container');

    this.#remember(spec.key);

    // Idempotency on key: an existing live container for this key is the session.
    if (this.#existingSession(name, spec.key)) {
      return new DockerHandle(spec.key, name, this.#cli, null, this.#emit);
    }

    // Composition existsSync-gates mount sources; re-check here so a
    // realization cannot silently invent one (Docker mounts a missing source
    // as a fresh empty directory — see `assertMountSourcesExist`). After the
    // idempotency return: an existing container's mounts are already bound,
    // and a source deleted since must not refuse adoption of a live session.
    assertMountSourcesExist(agent.mounts);

    const args = ['create', '--rm', '--name', name];
    args.push(...labelArgs(labelsForKey(spec.key, 'agent', { ...spec.labels, ...(agent.labels ?? {}) })));
    args.push(...resourceArgs(spec));
    args.push(...hardeningArgs(spec));
    args.push(...userArgs(spec));
    // Composed env first, contributed env second: on a duplicate `-e` key
    // Docker's last flag wins, which realizes the contract rule that the
    // contributed lane overrides composed literals (see ContainerSpec).
    args.push(...envArgs(agent.env));
    args.push(...envArgs(agent.contributedEnv ?? {}));
    args.push(...mountArgs(agent.mounts));
    // Network topology is driver-private: injected at registration (see
    // `drivers/index.ts`), never carried on the spec. Argv-shaped input has no
    // remaining channel through composition.
    args.push(...(this.opts.networkArgsFor?.(spec) ?? []));
    if (agent.command && agent.command.length > 0) {
      // Docker splits PID 1 across --entrypoint (argv[0] + fixed flags) and the
      // post-image argv. Keeping the split in the spec is what lets another
      // realization preserve tini as PID 1 rather than inventing an entrypoint.
      args.push('--entrypoint', agent.command[0]);
      args.push(agent.image, ...agent.command.slice(1), ...(agent.args ?? []));
    } else {
      args.push(agent.image, ...(agent.args ?? []));
    }

    try {
      this.#cli.run(args);
    } catch (error) {
      try {
        this.#cli.run(['rm', '--force', name]);
      } catch {
        /* prepare is atomic: allocate all or leave nothing */
      }
      throw normalizeDockerError(error);
    }
    return new DockerHandle(spec.key, name, this.#cli, spec, this.#emit);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    // Adoption contract: reconstruct handles from labels alone. `{{.State}}`
    // rides along because `ps -a` includes exited/created containers, and a
    // caller must be able to tell an adoptable session from a corpse without
    // a per-handle status() round trip.
    let out: string;
    try {
      out = this.#cli.run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        `label=${LABELS.role}=agent`,
        '--format',
        `{{.Names}}|{{.State}}|{{.Label "${LABELS.group}"}}|{{.Label "${LABELS.session}"}}`,
      ]);
    } catch (error) {
      throw normalizeDockerError(error);
    }
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, state, agentGroupId, sessionId] = line.split('|');
        const key: SessionKey = { installSlug, agentGroupId, sessionId };
        this.#remember(key);
        return {
          handle: new DockerHandle(key, name, this.#cli, null, this.#emit),
          phase: dockerStatePhase(state),
        };
      });
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      // Lazy: the subscription process exists only once someone is listening.
      watch = { subscribers: new Set(), attempt: 0 };
      this.#watches.set(installSlug, watch);
      this.#connectWatch(installSlug, watch);
    }
    watch.subscribers.add(onEvent);
    return {
      stop: () => {
        watch.subscribers.delete(onEvent);
      },
    };
  }

  /**
   * The one driver-level watch: a `docker events` subscription filtered by the
   * install and agent-role labels. Emits best-effort hints for every observed
   * transition — including ends the host itself requested; intent filtering is
   * the session-events hub's job, not this driver's.
   */
  #connectWatch(installSlug: string, watch: InstallWatch, reconnected = false): void {
    const stream = new JsonDocumentStream();
    const proc = this.#cli.start(
      [
        'events',
        '--filter',
        'type=container',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        `label=${LABELS.role}=agent`,
        '--format',
        '{{json .}}',
      ],
      { captureStdout: true },
    );
    proc.onStdout((chunk) => {
      // Data flowing means the subscription is healthy again.
      watch.attempt = 0;
      for (const doc of stream.push(chunk)) {
        const event = dockerEventToSessionEvent(doc, installSlug);
        if (!event) continue;
        for (const subscriber of watch.subscribers) subscriber(event);
      }
    });
    proc.onExit(() => {
      if (this.#watches.get(installSlug) !== watch) return;
      // Bounded backoff, never give up: an unrecovered drop would end
      // supervision for every session of the install at once.
      const delay = Math.min(WATCH_RECOVERY_BASE_MS * 2 ** watch.attempt, WATCH_RECOVERY_MAX_MS);
      watch.attempt += 1;
      const timer = setTimeout(() => this.#connectWatch(installSlug, watch, true), delay);
      timer.unref?.();
    });
    if (reconnected) void this.#reconcileWatchGap(installSlug, watch);
  }

  /**
   * A dropped subscription is a gap: the fresh `docker events` stream starts
   * from now, so a terminal that happened while it was down was never emitted
   * — and for an adopted session the stream is the ONLY terminal source (no
   * attach process backstop). Close the gap with synthetic hints: re-list
   * once, hint every corpse the list shows and every known key it no longer
   * shows (`--rm` already removed it), and let the hub's truth reads sort
   * spurious from real — hints may duplicate, never fire directly. Gated on
   * the re-list succeeding so a daemon that is still down (where inspect
   * cannot tell removed from unreachable) produces no false terminals; that
   * same dead daemon exits the events process too, and the next reconnect
   * retries this.
   */
  async #reconcileWatchGap(installSlug: string, watch: InstallWatch): Promise<void> {
    if (this.#watches.get(installSlug) !== watch) return;
    let snapshots: SessionSnapshot[];
    try {
      snapshots = await this.listSessions(installSlug);
    } catch {
      return;
    }
    const listed = new Set(snapshots.map((s) => keyId(s.handle.key)));
    const gapKeys = snapshots.filter((s) => s.phase === 'terminal').map((s) => s.handle.key);
    for (const [id, key] of this.#knownKeys.get(installSlug) ?? []) {
      if (!listed.has(id)) gapKeys.push(key);
    }
    for (const key of gapKeys) this.#emit({ key, kind: 'terminal' });
  }

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(keyId(key), key);
  }

  /** Handle-observed transitions (the `start --attach` exit) ride the same stream. */
  readonly #emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  /**
   * Residue a stopped session cannot clean up itself: install-labeled networks
   * whose containers are already gone. `stop()` is full teardown for a live
   * session; this covers a host that died between the two.
   */
  async reapResidue(installSlug: string): Promise<void> {
    // Containers first: an auxiliary container whose host died has no owner left
    // to close it. Only non-running ones — an adopted session's are still serving it.
    try {
      const out = this.#cli.run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        'status=exited',
        '--filter',
        'status=created',
        '--filter',
        'status=dead',
        '--format',
        '{{.Names}}',
      ]);
      const stale = out.trim().split('\n').filter(Boolean);
      for (const name of stale) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(name, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (stale.length > 0) log.info('Removed orphaned containers', { count: stale.length, names: stale });
    } catch (err) {
      log.warn('Failed to clean up orphaned containers', { err });
    }

    // Pre-seam residue: containers spawned before the driver seam carry the
    // install label but not the session label, so `listSessions` cannot see
    // them — they can be neither adopted nor matched to a session. Left alone
    // they would run forever AND race a freshly-named replacement for the same
    // session directory. Stopping them is exactly what the old
    // `cleanupOrphans()` did to every container on every start.
    try {
      const out = this.#cli.run([
        'ps',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        `{{.Names}}|{{.Label "${LABELS.session}"}}`,
      ]);
      const preSeam = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|'))
        .filter(([, sessionId]) => !sessionId)
        .map(([name]) => name);
      for (const name of preSeam) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(name, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (preSeam.length > 0) log.info('Stopped pre-seam containers', { count: preSeam.length, names: preSeam });
    } catch (err) {
      log.warn('Failed to clean up pre-seam containers', { err });
    }

    let names: string[] = [];
    try {
      const out = this.#cli.run([
        'network',
        'ls',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        '{{.Name}}',
      ]);
      names = out.trim().split('\n').filter(Boolean);
    } catch (err) {
      log.warn('Failed to list install-owned networks', { err });
      return;
    }
    const removed: string[] = [];
    for (const name of names) {
      try {
        this.#cli.run(['network', 'rm', validateRuntimeName(name, 'network')]);
        removed.push(name);
      } catch {
        /* still in use by a live session, or already gone */
      }
    }
    if (removed.length > 0) log.info('Removed orphaned networks', { count: removed.length, names: removed });
  }

  /**
   * Name-existence alone cannot answer "is this MY session": the name is
   * key-derived, but a foreign container can wear it — another install sharing
   * this daemon whose truncated identity collides, or an operator's hand-made
   * container. Adopting one by name would attach this session to a runtime it
   * does not own, so the canonical labels are verified and a mismatch refuses
   * loudly instead of aliasing.
   */
  #existingSession(name: string, key: SessionKey): boolean {
    let out: string;
    try {
      out = this.#cli.run([
        'inspect',
        '--format',
        `{{index .Config.Labels "${LABELS.install}"}}|{{index .Config.Labels "${LABELS.group}"}}|{{index .Config.Labels "${LABELS.session}"}}`,
        name,
      ]);
    } catch {
      return false;
    }
    const [install, group, session] = out.trim().split('|');
    if (install === key.installSlug && group === key.agentGroupId && session === key.sessionId) return true;
    log.warn('Container name collision: existing container is not this session', {
      containerName: name,
      wanted: key,
      found: { install, group, session },
    });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }
}

class DockerHandle implements SessionHandle {
  #proc: SupervisedProcess | null = null;
  /** Log hygiene only — events are never intent-filtered here (that is the hub's job). */
  #stopping = false;
  /** Exit code the attach process observed; undefined until it exits. */
  #attachExitCode: number | null | undefined;
  readonly #stderrTail: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: Cli,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly pendingSpec: SessionSpec | null,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    if (this.#proc) return; // idempotent
    // `start --attach` is the supervision channel: it exits with the container's
    // exit code and streams the stderr that explains a boot failure. A container
    // that dies at boot (unknown provider, missing binary, bad config) explains
    // itself only here, so keep a tail and surface it at warn on a non-zero exit.
    const proc = this.cli.start(['start', '--attach', this.name]);
    this.#proc = proc;
    proc.onStderr((line) => {
      log.debug(line, { container: this.name });
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
    proc.onExit((code) => {
      this.#attachExitCode = code;
      if (!this.#stopping && code !== 0 && code !== null && this.#stderrTail.length > 0) {
        log.warn('Container exited non-zero', { containerName: this.name, code, stderrTail: this.#stderrTail });
      }
      // Every observed terminal transition rides the driver-level stream —
      // even ends the host requested. Intent filtering is the hub's job.
      this.emit({ key: this.key, kind: 'terminal' });
    });
  }

  async status(): Promise<SessionStatus> {
    let state: string;
    try {
      state = this.cli.run(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', this.name]).trim();
    } catch {
      // `--rm` means an exited container has already been removed; the attach
      // exit code is the only record of how it ended. A host-requested stop is
      // not a failure, whatever code the runtime used to end the process.
      if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
        return {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
        };
      }
      if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) {
        // The container is gone but the attach process has not exited yet —
        // and that process holds the only record of HOW the session ended. The
        // events stream can outrun it (a 'die' event lands before the attach
        // exit), and concluding 'stopped' here would let the hub spend its
        // at-most-once terminal delivery without the exit code. Report running:
        // the attach exit always emits its own hint, so deferral converges
        // within one process exit.
        return { phase: 'running' };
      }
      return this.pendingSpec && !this.#proc ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const [status, exit] = state.split('|');
    if (status === 'running') return { phase: 'running' };
    if (status === 'created') return { phase: 'ready' };
    if (status === 'exited' && exit !== '0') {
      return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: Number(exit) } };
    }
    return { phase: 'stopped' };
  }

  /**
   * Full teardown. That this blocks until the container is gone is an
   * implementation behavior (it happens to serialize workspace single-writer
   * during termination), not a contract guarantee — see `SessionHandle.stop`.
   */
  async stop(reason: string): Promise<void> {
    this.#stopping = true;
    log.info('Stopping session container', { containerName: this.name, reason });
    const grace = String(this.pendingSpec?.stopGraceSeconds ?? 1);
    try {
      this.cli.run(['stop', '-t', grace, this.name]);
    } catch {
      // Already gone, or the daemon refused: fall back to killing the attach
      // process so supervision never hangs waiting for an exit that cannot come.
      this.#proc?.kill();
    }
    try {
      this.cli.run(['rm', '--force', this.name]);
    } catch {
      /* `--rm` usually got there first */
    }
  }

  /** `docker exec` against this session's container — see `SessionExecSpec`. */
  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: 'docker',
      argsTty: ['exec', '-it', this.name, ...command],
      argsPlain: ['exec', '-i', this.name, ...command],
    };
  }
}

/** Collision-proof key identity for driver-internal maps (NUL cannot appear in a key part). */
function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

// ---------- realization helpers (absorbed from container-runtime.ts) ----------

/**
 * `docker ps` state → seam phase. 'created' is prepared-not-started — an
 * adoption-adjacent incarnation, NOT a corpse; treating it as terminal would
 * have adoption tear down freshly-prepared sessions.
 */
export function dockerStatePhase(state: string): SessionPhase {
  if (state === 'running' || state === 'paused' || state === 'restarting') return 'running';
  if (state === 'created') return 'starting';
  // exited, dead, removing — self-ended corpses awaiting cleanup.
  return 'terminal';
}

interface DockerEventDoc {
  Action?: string;
  Actor?: { Attributes?: Record<string, string> };
}

/**
 * One `docker events` document → one best-effort hint, keyed from the labels
 * the event carries (the adoption contract, again: labels are the identity).
 * Unknown actions and label-less events are dropped — hints may drop.
 */
export function dockerEventToSessionEvent(doc: unknown, installSlug: string): SessionEvent | null {
  const event = doc as DockerEventDoc;
  const attrs = event.Actor?.Attributes ?? {};
  const agentGroupId = attrs[LABELS.group];
  const sessionId = attrs[LABELS.session];
  if (!agentGroupId || !sessionId) return null;
  const action = event.Action ?? '';
  const kind =
    action === 'die' || action === 'destroy'
      ? ('terminal' as const)
      : action === 'create' || action === 'start' || action === 'restart'
        ? ('phase' as const)
        : action === 'kill' || action === 'stop' || action === 'oom' || action === 'pause' || action === 'unpause'
          ? ('hint' as const)
          : null;
  if (!kind) return null;
  return { key: { installSlug, agentGroupId, sessionId }, kind };
}

/**
 * Derived from the key, never from a timestamp.
 *
 * `prepare` is idempotent on key, and it cannot be if the name it allocates
 * changes between calls. The install slug is part of the derivation because
 * the daemon is a shared namespace: two peer installs holding the same session
 * id must never alias one runtime object (`#existingSession` verifies labels
 * as the backstop). Over-length identities truncate-then-hash over the FULL
 * identity, so distinct keys that share a 39-byte prefix still get distinct
 * names, deterministically. The human-readable, timestamped name the host used
 * to generate survives as the `nanoclaw-container-name` lineage label.
 */
export function agentContainerName(spec: SessionSpec): string {
  const raw = `${spec.key.installSlug}-${spec.key.sessionId}`.replaceAll(/[^a-zA-Z0-9_.-]/g, '-');
  if (raw.length <= 48) return `ncl-${raw}`;
  const hash = createHash('sha256').update(`${spec.key.installSlug} ${spec.key.sessionId}`).digest('hex').slice(0, 8);
  return `ncl-${raw.slice(0, 39)}-${hash}`;
}

/**
 * 'standard' posture, Docker dialect.
 *
 * cap-drop and no-new-privileges are inert while containers run under the
 * `--user` mapping (the capability sets are already empty and the image carries
 * no file capabilities) — they are depth against a root-in-container path.
 * `--init` is not optional: overriding the entrypoint defeats the image's tini,
 * leaving the runtime as PID 1 with no signal handler, and Linux discards
 * default-action signals to PID 1. Without docker-init, SIGTERM is ignored and
 * every stop ends in SIGKILL after the full grace period.
 */
export function hardeningArgs(spec: SessionSpec): string[] {
  const args = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--init'];
  // Test >0, not truthiness: cgroups v2 rejects `--pids-limit 0` with EINVAL.
  const pids = spec.resources.pidsLimit;
  if (typeof pids === 'number' && Number.isFinite(pids) && pids > 0) {
    args.push('--pids-limit', String(Math.floor(pids)));
  }
  return args;
}

/**
 * Per-container resource caps. Undefined stays unbounded — the operator opts
 * in, and a default cap here would OOM-kill workloads that run fine today.
 * Whether `--memory` is a hard cap depends on the host having no swap, which
 * is a deployment concern and not managed from here.
 */
export function resourceArgs(spec: SessionSpec): string[] {
  const args: string[] = [];
  if (spec.resources.cpus) args.push('--cpus', spec.resources.cpus);
  if (spec.resources.memoryMb) args.push('--memory', `${spec.resources.memoryMb}m`);
  // Docker defaults /dev/shm to 64m, which silently short-writes past that size.
  if (spec.resources.shmSizeMb) args.push(`--shm-size=${spec.resources.shmSizeMb}m`);
  return args;
}

export function userArgs(spec: SessionSpec): string[] {
  return spec.runAs ? ['--user', `${spec.runAs.uid}:${spec.runAs.gid}`] : [];
}

export function mountArgs(mounts: readonly MountSpec[]): string[] {
  return mounts.flatMap((m) => [
    '-v',
    m.mode === 'ro' ? `${m.hostPath}:${m.containerPath}:ro` : `${m.hostPath}:${m.containerPath}`,
  ]);
}

export function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

export function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
}

export function normalizeDockerError(error: unknown): Error & SessionFailure {
  const msg = error instanceof Error ? error.message : String(error);
  const failure: SessionFailure = /manifest unknown|pull access denied|not found: manifest|No such image/i.test(msg)
    ? { kind: 'image-unavailable', retryable: true }
    : /Cannot connect to the Docker daemon|daemon is not running/i.test(msg)
      ? { kind: 'runtime-unavailable', retryable: true }
      : /no space left|cannot allocate memory/i.test(msg)
        ? { kind: 'resources-exhausted', retryable: true }
        : // Raw runtime errors never cross the seam.
          { kind: 'unknown', retryable: false, opaqueRef: `docker-${Date.now()}` };
  return asFailureError(failure);
}

/**
 * Docker mounts a missing hostPath as a fresh empty directory, which silently
 * turns a typo'd file mount into an empty dir inside the container. Composition
 * already existsSync-gates these; the driver re-checks so a realization
 * cannot silently invent a mount source that composition never saw.
 */
export function assertMountSourcesExist(mounts: readonly MountSpec[]): void {
  for (const mount of mounts) {
    if (!fs.existsSync(mount.hostPath)) {
      throw asFailureError({
        kind: 'spec-invalid',
        retryable: false,
        detail: `mount source missing: ${mount.hostPath}`,
      });
    }
  }
}

/** Ensure the container runtime is reachable. Fatal at startup — agents cannot run without it. */
export function ensureDockerRunning(cli: Cli = realCli('docker')): void {
  try {
    cli.run(['info'], { timeoutMs: 10_000 });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', { cause: err });
  }
}

export type { ContainerSpec };
