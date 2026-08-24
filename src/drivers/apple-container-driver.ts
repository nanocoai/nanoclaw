/**
 * Apple Container driver — the macOS microVM realization (kind 'container').
 *
 * Port of this install's pre-seam Apple Container support (the
 * `CONTAINER_RUNTIME=container` branches that lived in `container-runtime.ts`
 * and `container-runner.ts`) onto the session-driver seam. Selected via
 * `NANOCLAW_RUNTIME_DRIVER=container` in `.env`; registered from
 * `installed.ts` like any overlay driver.
 *
 * Where the grammar matches Docker's, this driver reuses the docker driver's
 * exported arg builders. The Apple-specific knowledge it adds:
 *
 * - `--security-opt` and `--pids-limit` are rejected (exit 64, EX_USAGE);
 *   `--ulimit nproc=` carries the pids-cap intent. Each container is its own
 *   microVM, so the isolation boundary is stronger by default anyway.
 * - VMs cannot resolve `host.docker.internal` and there is no `--add-host`:
 *   env values carrying that hostname (OneCLI's injected proxy URL) are
 *   rewritten to the bridge gateway IP, resolved from
 *   `container network inspect default` (version-agnostic) with a
 *   `CONTAINER_HOST_GATEWAY` override escape hatch.
 * - A single-FILE bind whose destination sits INSIDE another share does not
 *   layer — it REPLACES the parent share in the guest (apple/container#2148).
 *   Nested file mounts are dropped; the real file is visible through the
 *   parent share. Nested DIRECTORY mounts layer fine.
 *
 *   DECLARED DEVIATION from "realizes every declared mount": dropping is the
 *   only viable realization on this runtime today. Refusing (the
 *   auxiliary-container rule's shape) would brick stock composition, whose
 *   container.json nested-RO mount is unconditional; faking (mounting and
 *   letting the share collapse) silently destroys the parent mount, which is
 *   strictly worse. The drop is loud (one warn per dropped mount, every
 *   spawn), the file stays readable through the parent share, and the only
 *   loss is the nested mount's RO protection — bounded by per-spawn host-side
 *   re-materialization. Revisit when apple/container#2148 is fixed.
 *
 *   The host.docker.internal env rewrite is the same class of deviation from
 *   "declared env passes through byte-identical": the hostname is
 *   UNRESOLVABLE in this runtime (no --add-host exists), so a byte-identical
 *   pass-through ships a value that can never work (upstream nanoclaw#2589).
 *   The rewrite preserves the value's meaning — reach the host — the way a
 *   resolver would, touches only values that carry the hostname, and runs on
 *   both env lanes.
 * - `list`/`inspect` have no `--filter` or go-template `--format`; listing
 *   parses `--format json` and filters by label client-side. The `status`
 *   field was a plain string through 0.12.x and became `{ state }` in 1.0.0 —
 *   both shapes are accepted.
 * - There is no `events` stream (the plugin is not installed by default), so
 *   `watchSessions` is realized as a driver-level poll: one interval per
 *   install, diffing listed phases and emitting terminal hints. Events are
 *   best-effort hints by contract; supervision of self-started sessions rides
 *   the `start --attach` exit like the docker driver.
 * - `ensureReady` runs `container system status` and starts the runtime when
 *   it is down — the runtime black-holes egress when its vmnet state is stale
 *   (apple/container#2051), and a cold start after reboot is routine.
 */
import fs from 'fs';
import os from 'os';

import { log } from '../log.js';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from './cli.js';
import {
  agentContainerName,
  assertMountSourcesExist,
  envArgs,
  labelArgs,
  resourceArgs,
  userArgs,
} from './docker-driver.js';
import {
  LABELS,
  asFailureError,
  labelsForKey,
  specInvalid,
  validateSpec,
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

export interface AppleContainerDriverOptions extends MountPolicy {
  cli?: Cli;
}

/** Shape of one entry in `container list --format json` / `container inspect`. */
interface AppleContainerEntry {
  status: string | { state?: string };
  configuration: { id: string; labels?: Record<string, string> };
}

function stateOf(entry: AppleContainerEntry): string | undefined {
  return typeof entry.status === 'string' ? entry.status : entry.status?.state;
}

function applePhase(state: string | undefined): SessionPhase {
  if (state === 'running') return 'running';
  if (state === 'created') return 'starting';
  return 'terminal';
}

/** Poll cadence for the events-substitute watch. */
const WATCH_POLL_MS = 15_000;

function isIPv4(addr: string): boolean {
  const parts = addr.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * IP address containers use to reach the host machine. Resolved through the
 * driver's `Cli` seam (never an ad-hoc child_process call) and only when an
 * env value actually needs the rewrite. Precedence, each step logged so a
 * future breakage is visible:
 *   1. `CONTAINER_HOST_GATEWAY` override — operator escape hatch.
 *   2. `container network inspect default` → `[0].status.ipv4Gateway`
 *      (authoritative and VERSION-AGNOSTIC across bridge-subnet moves).
 *   3. bridge100/bridge0 interface scan — back-compat with 0.12.x.
 *   4. Throw. Deliberately NO hardcoded fallback: a plausible-but-stale
 *      constant hands every container a dead gateway and produces a silent,
 *      total outage with no error anywhere.
 */
export function resolveAppleHostGateway(cli: Cli, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CONTAINER_HOST_GATEWAY?.trim();
  if (override) {
    log.info('Host gateway resolved from CONTAINER_HOST_GATEWAY override', { gateway: override });
    return override;
  }
  try {
    const output = cli.run(['network', 'inspect', 'default'], { timeoutMs: 5000 });
    const parsed = JSON.parse(String(output)) as Array<{ status?: { ipv4Gateway?: string } }>;
    const gateway = parsed?.[0]?.status?.ipv4Gateway;
    if (typeof gateway === 'string' && isIPv4(gateway)) {
      log.debug('Host gateway resolved via `network inspect default`', { gateway });
      return gateway;
    }
    log.warn('`network inspect default` returned no usable ipv4Gateway, falling back', { parsed });
  } catch (err) {
    log.debug('`network inspect default` failed, falling back to interface scan', { err });
  }
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  const ipv4 = bridge?.find((a) => a.family === 'IPv4');
  if (ipv4) {
    log.debug('Host gateway resolved via bridge interface scan', { gateway: ipv4.address });
    return ipv4.address;
  }
  const message =
    'Could not detect the container host gateway: no CONTAINER_HOST_GATEWAY override, ' +
    '`network inspect default` returned no usable ipv4Gateway, and no bridge100/bridge0 ' +
    'interface with an IPv4 address was found. Set CONTAINER_HOST_GATEWAY as an escape hatch.';
  log.error(message);
  throw new Error(message);
}

/**
 * Rewrite `host.docker.internal` to the bridge gateway IP in env values.
 * Apple Container VMs cannot resolve that hostname and the runtime has no
 * `--add-host`, so the proxy URL OneCLI injects would be unreachable and
 * every credentialed call would fail silently (upstream nanoclaw#2589).
 * Scoped to env values on purpose — never mount paths or names.
 */
export function rewriteHostDockerInternalEnv(env: Record<string, string>, gateway: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.includes('host.docker.internal') ? v.replaceAll('host.docker.internal', gateway) : v;
  }
  return out;
}

/**
 * Apple Container: a single-FILE share nested INSIDE another share REPLACES
 * the parent share in the guest (apple/container#2148, observed and minimally
 * reproduced 2026-08-14; re-verified on 1.2.2 2026-08-23). Drop nested file
 * mounts — the real file is visible through the parent share. The cost is the
 * RO protection those file mounts carried; per-spawn re-materialization and
 * host-side authority (DB config, command gates) bound the tamper impact.
 */
export function dropClobberingFileMounts(
  mounts: readonly MountSpec[],
  isFile: (p: string) => boolean = defaultIsFile,
): MountSpec[] {
  const shareRoots = mounts.filter((m) => !isFile(m.hostPath)).map((m) => m.containerPath.replace(/\/+$/, ''));
  return mounts.filter((mount) => {
    if (!isFile(mount.hostPath)) return true;
    const dest = mount.containerPath;
    const clobbers = shareRoots.some((root) => root !== dest && dest.startsWith(`${root}/`));
    if (clobbers) {
      log.warn('Dropping nested file mount — Apple Container file shares replace the parent share', {
        hostPath: mount.hostPath,
        containerPath: dest,
      });
    }
    return !clobbers;
  });
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Hardening for the Apple runtime. `--security-opt` and `--pids-limit` are
 * rejected as unknown options (exit 64) before the agent starts — verified
 * against 1.1.0. `--ulimit nproc` carries the pids-cap intent;
 * no-new-privileges has no equivalent, but each container is its own microVM,
 * so the isolation boundary is stronger by default than a shared-kernel
 * namespace. `--init` is not optional: the entrypoint override defeats the
 * image's tini, leaving bun as PID 1 with no signal handler.
 */
export function appleHardeningArgs(spec: SessionSpec): string[] {
  const args = ['--cap-drop=ALL', '--init'];
  const pids = spec.resources.pidsLimit;
  if (typeof pids === 'number' && Number.isFinite(pids) && pids > 0) {
    args.push('--ulimit', `nproc=${Math.floor(pids)}`);
  }
  return args;
}

/** Ensure the runtime is up, starting it when down — a cold start after reboot is routine. */
export function ensureAppleContainerRunning(cli: Cli = realCli('container')): void {
  try {
    cli.run(['system', 'status'], { timeoutMs: 10_000 });
    log.debug('Apple Container runtime already running');
  } catch {
    log.info('Starting Apple Container runtime');
    try {
      cli.run(['system', 'start'], { timeoutMs: 30_000 });
    } catch (err) {
      log.error('Failed to start Apple Container', { err });
      throw new Error('Container runtime is required but failed to start', { cause: err });
    }
  }
}

function normalizeAppleError(error: unknown): Error & SessionFailure {
  const msg = error instanceof Error ? error.message : String(error);
  const failure: SessionFailure = /not found|no such image|manifest/i.test(msg)
    ? { kind: 'image-unavailable', retryable: true }
    : /system services are not running|XPC connection|connection refused/i.test(msg)
      ? { kind: 'runtime-unavailable', retryable: true }
      : /no space left|cannot allocate memory/i.test(msg)
        ? { kind: 'resources-exhausted', retryable: true }
        : { kind: 'unknown', retryable: false, opaqueRef: `apple-container-${Date.now()}` };
  return asFailureError(failure);
}

interface InstallPollWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  timer: ReturnType<typeof setInterval>;
  /** Last observed phase per keyId — terminal transitions are edges in this map. */
  lastPhases: Map<string, { key: SessionKey; phase: SessionPhase }>;
}

function keyId(key: SessionKey): string {
  return `${key.installSlug} ${key.agentGroupId} ${key.sessionId}`;
}

export class AppleContainerSessionDriver implements SessionDriver {
  readonly kind = 'container' as const;
  readonly #cli: Cli;
  readonly #policy: MountPolicy;
  readonly #watches = new Map<string, InstallPollWatch>();
  #gateway: string | undefined;

  /** Handle-observed transitions (the `start --attach` exit) ride the same stream as poll hints. */
  readonly #emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  /** Lazily resolved and instance-cached: only a spec whose env actually
   *  carries `host.docker.internal` pays for the lookup. */
  #hostGateway(): string {
    if (this.#gateway === undefined) this.#gateway = resolveAppleHostGateway(this.#cli);
    return this.#gateway;
  }

  constructor(opts: AppleContainerDriverOptions) {
    this.#cli = opts.cli ?? realCli('container');
    this.#policy = opts;
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      // Each session is a microVM with its own kernel; nothing shares a netns.
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      // `container build` targets the same store sessions run from.
      imageBuild: true,
    };
  }

  async ensureReady(): Promise<void> {
    ensureAppleContainerRunning(this.#cli);
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      throw specInvalid(
        `apple-container driver does not manage container role '${extra[0].role}'; ` +
          `auxiliary containers require a driver with capabilities().auxiliaryContainers`,
      );
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = validateRuntimeName(agentContainerName(spec), 'container');

    if (this.#existingSession(name, spec.key)) {
      return new AppleHandle(spec.key, name, this.#cli, null, this.#emit);
    }

    const mounts = dropClobberingFileMounts(agent.mounts);
    assertMountSourcesExist(mounts);

    const composedEnv = agent.env;
    const contributedEnv = agent.contributedEnv ?? {};
    const needsGateway = [...Object.values(composedEnv), ...Object.values(contributedEnv)].some((v) =>
      v.includes('host.docker.internal'),
    );
    const gateway = needsGateway ? this.#hostGateway() : '';
    const args = ['create', '--rm', '--name', name];
    args.push(...labelArgs(labelsForKey(spec.key, 'agent', { ...spec.labels, ...(agent.labels ?? {}) })));
    args.push(...resourceArgs(spec));
    args.push(...appleHardeningArgs(spec));
    args.push(...userArgs(spec));
    // Composed env first, contributed env second — same override lane order as
    // the docker driver. Both lanes get the host.docker.internal rewrite; the
    // gateway proxy URL rides the contributed lane.
    args.push(...envArgs(needsGateway ? rewriteHostDockerInternalEnv(composedEnv, gateway) : composedEnv));
    args.push(...envArgs(needsGateway ? rewriteHostDockerInternalEnv(contributedEnv, gateway) : contributedEnv));
    for (const m of mounts) {
      args.push('-v', m.mode === 'ro' ? `${m.hostPath}:${m.containerPath}:ro` : `${m.hostPath}:${m.containerPath}`);
    }
    if (agent.command && agent.command.length > 0) {
      args.push('--entrypoint', agent.command[0]);
      args.push(agent.image, ...agent.command.slice(1), ...(agent.args ?? []));
    } else {
      args.push(agent.image, ...(agent.args ?? []));
    }

    try {
      this.#cli.run(args, { timeoutMs: 120_000 });
    } catch (error) {
      try {
        this.#cli.run(['rm', '--force', name]);
      } catch {
        /* prepare is atomic: allocate all or leave nothing */
      }
      throw normalizeAppleError(error);
    }
    return new AppleHandle(spec.key, name, this.#cli, spec, this.#emit);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    return this.#list(installSlug).map(({ entry, key }) => ({
      handle: new AppleHandle(key, entry.configuration.id, this.#cli, null, this.#emit),
      phase: applePhase(stateOf(entry)),
    }));
  }

  #list(installSlug: string): Array<{ entry: AppleContainerEntry; key: SessionKey }> {
    let out: string;
    try {
      out = this.#cli.run(['list', '--all', '--format', 'json']);
    } catch (error) {
      throw normalizeAppleError(error);
    }
    const entries: AppleContainerEntry[] = JSON.parse(out.trim() || '[]');
    const result: Array<{ entry: AppleContainerEntry; key: SessionKey }> = [];
    for (const entry of entries) {
      const labels = entry.configuration.labels ?? {};
      if (labels[LABELS.install] !== installSlug) continue;
      if (labels[LABELS.role] !== 'agent') continue;
      const agentGroupId = labels[LABELS.group];
      const sessionId = labels[LABELS.session];
      if (!agentGroupId || !sessionId) continue;
      result.push({ entry, key: { installSlug, agentGroupId, sessionId } });
    }
    return result;
  }

  /**
   * Events substitute: Apple Container ships no `events` stream, so the one
   * driver-level subscription is a poll that emits terminal hints on observed
   * edges. Self-started sessions get exact supervision from `start --attach`;
   * this covers adopted sessions and externally-killed containers.
   */
  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      const created: InstallPollWatch = {
        subscribers: new Set(),
        lastPhases: new Map(),
        timer: setInterval(() => this.#poll(installSlug, created), WATCH_POLL_MS),
      };
      created.timer.unref?.();
      this.#watches.set(installSlug, created);
      watch = created;
    }
    watch.subscribers.add(onEvent);
    return {
      stop: () => {
        watch.subscribers.delete(onEvent);
        if (watch.subscribers.size === 0) {
          clearInterval(watch.timer);
          this.#watches.delete(installSlug);
        }
      },
    };
  }

  #poll(installSlug: string, watch: InstallPollWatch): void {
    let current: Map<string, { key: SessionKey; phase: SessionPhase }>;
    try {
      current = new Map(
        this.#list(installSlug).map(({ entry, key }) => [keyId(key), { key, phase: applePhase(stateOf(entry)) }]),
      );
    } catch {
      return; // transient runtime hiccup; next tick retries
    }
    for (const [id, prev] of watch.lastPhases) {
      const now = current.get(id);
      if (prev.phase !== 'terminal' && (!now || now.phase === 'terminal')) {
        for (const subscriber of watch.subscribers) subscriber({ key: prev.key, kind: 'terminal' });
      }
    }
    watch.lastPhases = current;
  }

  async reapResidue(installSlug: string): Promise<void> {
    try {
      let out = '';
      try {
        out = this.#cli.run(['list', '--all', '--format', 'json']);
      } catch (error) {
        throw normalizeAppleError(error);
      }
      const entries: AppleContainerEntry[] = JSON.parse(out.trim() || '[]');
      const stale = entries.filter(
        (e) => e.configuration.labels?.[LABELS.install] === installSlug && stateOf(e) !== 'running',
      );
      for (const e of stale) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(e.configuration.id, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (stale.length > 0) {
        log.info('Removed orphaned containers', { count: stale.length, names: stale.map((e) => e.configuration.id) });
      }
      // Pre-seam residue: running containers with the install label but no
      // session label can be neither adopted nor matched — stop them, exactly
      // what the old cleanupOrphans() did on every start.
      const preSeam = entries.filter(
        (e) =>
          e.configuration.labels?.[LABELS.install] === installSlug &&
          stateOf(e) === 'running' &&
          !e.configuration.labels?.[LABELS.session],
      );
      for (const e of preSeam) {
        try {
          this.#cli.run(['stop', validateRuntimeName(e.configuration.id, 'container')], { timeoutMs: 60_000 });
        } catch {
          /* already stopped */
        }
      }
      if (preSeam.length > 0) {
        log.info('Stopped pre-seam containers', {
          count: preSeam.length,
          names: preSeam.map((e) => e.configuration.id),
        });
      }
    } catch (err) {
      log.warn('Failed to clean up orphaned containers', { err });
    }
  }

  /** Same adoption safety as the docker driver: labels verified, collision refuses loudly. */
  #existingSession(name: string, key: SessionKey): boolean {
    let out: string;
    try {
      out = this.#cli.run(['inspect', name]);
    } catch {
      return false;
    }
    let entries: AppleContainerEntry[];
    try {
      entries = JSON.parse(out.trim() || '[]');
    } catch {
      return false;
    }
    const labels = entries[0]?.configuration?.labels ?? {};
    if (
      labels[LABELS.install] === key.installSlug &&
      labels[LABELS.group] === key.agentGroupId &&
      labels[LABELS.session] === key.sessionId
    ) {
      return true;
    }
    log.warn('Container name collision: existing container is not this session', {
      containerName: name,
      wanted: key,
      found: labels,
    });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }
}

class AppleHandle implements SessionHandle {
  #proc: SupervisedProcess | null = null;
  #stopping = false;
  #attachExitCode: number | null | undefined;
  readonly #stderrTail: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: Cli,
    private readonly pendingSpec: SessionSpec | null,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    if (this.#proc) return; // idempotent
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
    let state: string | undefined;
    try {
      const out = this.cli.run(['inspect', this.name]);
      const entries: AppleContainerEntry[] = JSON.parse(out.trim() || '[]');
      if (entries.length === 0) throw new Error('not found');
      state = stateOf(entries[0]);
    } catch {
      // `--rm` means an exited container is already gone; the attach exit code
      // is the only record of how it ended.
      if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
        return {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
        };
      }
      if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) {
        return { phase: 'running' };
      }
      return this.pendingSpec && !this.#proc ? { phase: 'ready' } : { phase: 'stopped' };
    }
    if (state === 'running') return { phase: 'running' };
    if (state === 'created') return { phase: 'ready' };
    return { phase: 'stopped' };
  }

  async stop(reason: string): Promise<void> {
    this.#stopping = true;
    log.info('Stopping session container', { containerName: this.name, reason });
    const grace = String(this.pendingSpec?.stopGraceSeconds ?? 1);
    try {
      this.cli.run(['stop', '-t', grace, this.name], { timeoutMs: 60_000 });
    } catch {
      this.#proc?.kill();
    }
    try {
      this.cli.run(['rm', '--force', this.name]);
    } catch {
      /* `--rm` usually got there first */
    }
  }

  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: 'container',
      argsTty: ['exec', '-it', this.name, ...command],
      argsPlain: ['exec', '-i', this.name, ...command],
    };
  }
}
