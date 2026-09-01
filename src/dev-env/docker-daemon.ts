/**
 * Thin docker layer for the docker dev-env driver.
 *
 * Everything the driver says to the daemon goes through here: one place that
 * builds argv, one place that normalizes docker's phrasings into the seam
 * taxonomy, one place that knows the events protocol. Rides the session
 * seam's `Cli` so the conformance harness can stand a fake daemon underneath
 * — the same move the k8s driver made with `Kube`.
 *
 * Two rules this file exists to hold:
 *
 * - RAW DOCKER TEXT NEVER CROSSES THE SEAM. An unclassified failure becomes
 *   an opaque ref and its detail is logged HERE, at the boundary, because
 *   everything above records failure text on the env row and pushes it into
 *   the claiming agent's chat. Docker quotes argv in several of its errors,
 *   and argv is where mounts, env values and image refs live.
 * - THE DAEMON SOCKET IS THE HOST'S, AND ONLY THE HOST'S. Nothing here ever
 *   builds a `-v /var/run/docker.sock`, a `--privileged`, or a
 *   `--network host`; the whole vocabulary below is bounded so that a
 *   reviewer can read the argv builders and see the clamp rather than trust
 *   it. `docker-driver.test.ts` pins the same property from outside. The
 *   POSITIVE half of that clamp is `hardeningArgs`, which every container
 *   this file creates carries.
 */
import { log } from '../log.js';

import type { Cli, SupervisedProcess } from '../drivers/cli.js';
import { JsonDocumentStream } from '../drivers/json-stream.js';

import { asDevEnvFailureError, type DevEnvFailure, type DevEnvFailureError } from './types.js';

/** Bounded reads: every call on a request or callback path carries one. */
export const DOCKER_TIMEOUT_MS = 20_000;

/** `docker network inspect` of one network, reduced to what the driver reads. */
export interface DockerNetwork {
  Name: string;
  Created: string;
  Internal: boolean;
  Labels: Record<string, string>;
  /** Endpoint id -> member. Teardown reads `Name`; an exposure reads the address too. */
  Containers: Record<string, DockerNetworkMember>;
}

/**
 * One live endpoint on a network. The address is the ONLY one a claimed env
 * has — an `--internal` network publishes nothing — and it exists only while
 * the member is attached, which is what makes reading it per connection a
 * resolution rather than a memory.
 */
export interface DockerNetworkMember {
  Name?: string;
  /** CIDR, the way the daemon reports it: `172.20.0.2/16`. */
  IPv4Address?: string;
}

/**
 * The dialable half of an endpoint, or null when it has none. Docker reports a
 * member's address with its prefix length attached and a member that holds no
 * IPv4 endpoint (detached, or attached and not yet started) reports an empty
 * string — both answer null here, because the caller's next move is to dial
 * this string and a mangled one dials somebody else.
 */
export function endpointAddress(member: DockerNetworkMember): string | null {
  const address = (member.IPv4Address ?? '').split('/')[0];
  return address.length > 0 ? address : null;
}

/** `docker ps -a` of one container, reduced the same way. */
export interface DockerContainer {
  name: string;
  /** created | running | paused | restarting | exited | dead | removing. */
  state: string;
  labels: Record<string, string>;
}

/** One `docker events` document, reduced to the two fields the driver keys on. */
export interface DockerEvent {
  Action: string;
  Attributes: Record<string, string>;
}

export function isNoSuchObject(error: unknown): boolean {
  return /No such |not found|is not connected to network|network .* not found/i.test(String(error));
}

/**
 * Below this, binding a listening socket needs `CAP_NET_BIND_SERVICE` on
 * Linux, whatever uid the container runs as.
 */
export const PRIVILEGED_PORT_CEILING = 1024;

/**
 * The 'standard' hardening posture, docker dialect — the SAME clamps this
 * repo's session driver puts on every agent container on this same daemon
 * (`hardeningArgs` in `src/drivers/docker-driver.ts`), deliberately copied
 * rather than re-invented.
 *
 * ON A SHARED DAEMON THIS IS THE ISOLATION STORY. A claimed env is containers
 * on the claimant's own kernel, reached through the claimant's own daemon, so
 * a stamp workload that can gain a capability, or fork without bound, is a
 * hole in the HOST and not merely in the env. The k8s driver can point at a
 * vcluster for this; this driver has only these flags, so it must not ship
 * without them.
 *
 * What is copied and why: `--cap-drop=ALL` plus `no-new-privileges` are depth
 * against a root-in-container path (both are inert while a container runs
 * under `--user`, which only the C16 dev flavor does); `--init` gives PID 1 a
 * signal handler, without which Linux discards default-action signals to PID 1
 * and every stop ends in SIGKILL after the full grace period; the pid cap is
 * the install-wide one the session driver reads.
 *
 * ONE CAPABILITY COMES BACK, AND ONLY WHERE THE STAMP'S OWN DECLARATION ASKS
 * FOR IT: a workload whose declared port is below 1024 gets
 * `--cap-add=NET_BIND_SERVICE`. The posture above was copied from the AGENT
 * container's role, which never binds a privileged port; an arbitrary stamp
 * is a different role, and a blanket `--cap-drop=ALL` breaks a whole class of
 * them — the platform's own acceptance stamp is whoami on port 80 — with an
 * EACCES from inside an image whose author never sees this file. Granting
 * exactly the capability the declaration requires is honest; dropping ALL and
 * letting the author guess is not. Nothing else comes back, the prober never
 * asks for it (it connects, it does not bind), and `no-new-privileges` still
 * stops any container gaining anything beyond what is granted here.
 *
 * What is NOT copied: `--read-only`. That is the SIDECAR's rootfs policy in
 * the same posture; a stamp workload is the agent-shaped role, whose rootfs is
 * writable. Changing that is a new posture, not a flag.
 */
export function hardeningArgs(pidsLimit: number | undefined, declaredPort?: number): string[] {
  const args = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--init'];
  if (typeof declaredPort === 'number' && declaredPort > 0 && declaredPort < PRIVILEGED_PORT_CEILING) {
    args.push('--cap-add=NET_BIND_SERVICE');
  }
  // Test > 0, not truthiness: cgroups v2 rejects `--pids-limit 0` with EINVAL
  // and kills the create — the same guard `parsePidsLimit` applies host-side.
  if (typeof pidsLimit === 'number' && Number.isFinite(pidsLimit) && pidsLimit > 0) {
    args.push('--pids-limit', String(Math.floor(pidsLimit)));
  }
  return args;
}

/**
 * Docker's phrasings → the seam taxonomy. Same construction as the k8s
 * normalizer, different vocabulary and one different judgement: docker has no
 * admission controller, so `denied-by-policy` is NEVER emitted here. Saying
 * that plainly is more useful than inventing a mapping for a gate that does
 * not exist.
 */
export function normalizeDockerFailure(error: unknown): DevEnvFailureError {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
  const text = `${message}\n${stderr}`;

  const failure: DevEnvFailure =
    /Cannot connect to the Docker daemon|Is the docker daemon running|daemon is not running|dial unix/i.test(text)
      ? { kind: 'driver-unavailable', retryable: true }
      : // The address-pool ceiling is real and LOW — the default pools run out
        // somewhere around thirty concurrent networks — and it looks nothing
        // like a quota message, so it is named explicitly or it reads as
        // weather forever.
        /non-overlapping IPv4 address pool|no space left on device|cannot allocate memory|too many open files/i.test(
            text,
          )
        ? { kind: 'capacity-exhausted', retryable: true }
        : // Deterministic realization faults: the same claim fails the same
          // way next time, so retrying is a lie. The DETAILS are fixed
          // strings, never docker's own text — see the file header.
          /No such image|manifest unknown|pull access denied/i.test(text)
          ? {
              kind: 'instantiation-failed',
              retryable: false,
              detail: "the stamp's image is not in this daemon's image store, and a claim never pulls",
            }
          : /Conflict\. The container name|already in use by container|already exists/i.test(text)
            ? {
                kind: 'instantiation-failed',
                retryable: false,
                detail: 'a runtime object of this name already exists and is not this instance',
              }
            : /invalid mount|bind source path does not exist|are you trying to mount a directory onto a file/i.test(
                  text,
                )
              ? {
                  kind: 'instantiation-failed',
                  retryable: false,
                  detail: 'a declared mount source is not a directory this host can bind',
                }
              : { kind: 'unknown', retryable: false, opaqueRef: `docker:${Date.now().toString(36)}` };

  if (failure.kind === 'unknown') {
    // The opaqueRef in the log is what lets an operator join a seam-shaped
    // failure back to its raw cause without the raw cause reaching chat.
    log.warn('Dev-env docker failure (unclassified)', {
      opaqueRef: failure.opaqueRef,
      detail: text.slice(0, 300),
    });
  }
  return asDevEnvFailureError(failure);
}

export interface CreateContainerSpec {
  name: string;
  network: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  command?: string[];
  /** Bind mounts. The dev tree (C16) is the only one anything in-tree asks for. */
  binds?: Array<{ hostPath: string; containerPath: string }>;
  /** `uid:gid`, set for a dev-flavor container so it runs as the tree's owner. */
  user?: string;
  /**
   * The port the stamp declared this workload serves on. Read for exactly one
   * decision — whether the bind needs `CAP_NET_BIND_SERVICE` back — and never
   * published, because an `--internal` network publishes nothing.
   */
  port?: number;
}

export interface DockerOptions {
  /**
   * `--pids-limit` for every container this file creates. Undefined means
   * uncapped, which is what the install-wide knob means when it is blank or
   * zero — see `hardeningArgs`.
   */
  pidsLimit?: number;
}

export class Docker {
  constructor(
    private cli: Cli,
    private options: DockerOptions = {},
  ) {}

  /** Reachability. The one call `ensureReady` makes. */
  info(): void {
    this.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
  }

  /**
   * Is `ref` in this daemon's image store? The C15 postcondition, answered
   * exactly — unlike the k8s driver, which must treat a possibly-truncated
   * kubelet report as "present", docker answers the real question cheaply and
   * truthfully, so nothing here has to guess.
   */
  imagePresent(ref: string): boolean {
    try {
      this.rawRun(['image', 'inspect', '--format', '{{.Id}}', ref]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `--internal` is not a parameter. A claimed env's network is the agent's
   * SECOND network, and a routable one would hand the agent a default route
   * to the internet — the host performing, on the agent's behalf, exactly the
   * escape the egress lockdown exists to prevent. See the driver header.
   */
  createNetwork(name: string, labels: Record<string, string>): void {
    this.run(['network', 'create', '--internal', ...labelArgs(labels), name]);
  }

  /** Networks matching every filter, fully inspected. One list call plus one inspect call. */
  listNetworks(filters: string[]): DockerNetwork[] {
    const ids = this.run(['network', 'ls', '-q', ...filterArgs(filters)])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length === 0) return [];
    try {
      return this.inspectNetworks(ids);
    } catch (error) {
      // A network removed between the list and the inspect is a race, not a
      // failure: retry once over what still exists rather than failing a
      // whole adoption sweep over one vanished object.
      if (!isNoSuchObject(error)) throw normalizeDockerFailure(error);
      return ids.flatMap((id) => {
        const network = this.inspectNetwork(id);
        return network ? [network] : [];
      });
    }
  }

  inspectNetwork(name: string): DockerNetwork | null {
    try {
      return this.inspectNetworks([name])[0] ?? null;
    } catch (error) {
      if (isNoSuchObject(error)) return null;
      throw normalizeDockerFailure(error);
    }
  }

  private inspectNetworks(names: string[]): DockerNetwork[] {
    const out = this.rawRun(['network', 'inspect', '--format', '{{json .}}', ...names]);
    const networks: DockerNetwork[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const doc = JSON.parse(line) as Partial<DockerNetwork>;
        networks.push({
          Name: doc.Name ?? '',
          Created: doc.Created ?? '',
          Internal: doc.Internal ?? false,
          Labels: doc.Labels ?? {},
          Containers: doc.Containers ?? {},
        });
      } catch {
        /* a daemon that answered half a document is a drop, not a crash */
      }
    }
    return networks;
  }

  /**
   * Teardown-race tolerant: the reaper and an explicit release will both run
   * this, and an already-gone network is the desired state.
   *
   * Answers `has-members` instead of throwing when the daemon refuses for
   * active endpoints. That refusal is not a failure — it is the daemon saying
   * the caller missed a member — and the only useful answer is another
   * disconnect pass over a FRESH membership read, which is the driver's
   * teardown. It has to be a return value rather than an error because the
   * normalizer would have erased the daemon's words by the time the caller
   * saw them.
   */
  removeNetwork(name: string): 'removed' | 'has-members' {
    try {
      this.rawRun(['network', 'rm', name]);
      return 'removed';
    } catch (error) {
      if (isNoSuchObject(error)) return 'removed';
      if (/has active endpoints/i.test(String(error))) return 'has-members';
      throw normalizeDockerFailure(error);
    }
  }

  /** The claimant attach (D19). The ONLY thing this driver ever does TO an agent's container. */
  connect(network: string, container: string): void {
    try {
      this.rawRun(['network', 'connect', network, container]);
    } catch (error) {
      // Already a member is the desired state — this call is the heal on a
      // replayed claim, exactly like the k8s route's AlreadyExists.
      if (!/already exists in network|endpoint with name .* already exists/i.test(String(error))) {
        throw normalizeDockerFailure(error);
      }
    }
  }

  disconnect(network: string, container: string): void {
    try {
      this.rawRun(['network', 'disconnect', '-f', network, container]);
    } catch (error) {
      if (!isNoSuchObject(error)) throw normalizeDockerFailure(error);
    }
  }

  /**
   * `--pull=never` is the mechanical half of the C15 clamp: a claim CANNOT
   * pull, whatever a stamp says and whatever the daemon could reach. Docker
   * answers a missing image with "No such image" at create, which the
   * normalizer turns into a named refusal in seconds — the whole of #22's
   * common case, without a boot budget being spent.
   */
  createContainer(spec: CreateContainerSpec): void {
    const args = [
      'create',
      '--pull=never',
      ...hardeningArgs(this.options.pidsLimit, spec.port),
      '--name',
      spec.name,
      '--network',
      spec.network,
    ];
    args.push(...labelArgs(spec.labels));
    for (const [key, value] of Object.entries(spec.env)) args.push('-e', `${key}=${value}`);
    for (const bind of spec.binds ?? []) args.push('-v', `${bind.hostPath}:${bind.containerPath}`);
    if (spec.user) args.push('--user', spec.user);
    args.push(spec.image, ...(spec.command ?? []));
    this.run(args);
  }

  startContainer(name: string): void {
    this.run(['start', name]);
  }

  /** Containers matching every filter, running or not. */
  listContainers(filters: string[], labelKeys: string[]): DockerContainer[] {
    const format = ['{{.Names}}', '{{.State}}', ...labelKeys.map((key) => `{{.Label "${key}"}}`)].join('|');
    const out = this.run(['ps', '-a', ...filterArgs(filters), '--format', format]);
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        const labels: Record<string, string> = {};
        labelKeys.forEach((key, index) => {
          const value = parts[2 + index];
          if (value) labels[key] = value;
        });
        return { name: parts[0], state: parts[1] ?? '', labels };
      });
  }

  removeContainers(names: string[]): void {
    if (names.length === 0) return;
    try {
      this.rawRun(['rm', '--force', ...names]);
    } catch (error) {
      if (!isNoSuchObject(error)) throw normalizeDockerFailure(error);
    }
  }

  /**
   * A throwaway container on `network`, run to completion — the readiness
   * probe's transport. True iff it exited zero. Deliberately swallows the
   * failure: "did not answer" is the probe's whole vocabulary, and a probe
   * that threw would take down the watch callback it runs inside.
   */
  probeRun(network: string, image: string, labels: Record<string, string>, command: string[]): boolean {
    try {
      this.rawRun([
        'run',
        '--rm',
        '--pull=never',
        // The prober is a container on the shared daemon like any other, so it
        // wears the same posture. A probe is the LAST place to make an
        // exception: it runs unattended, once per interval, for every claiming
        // env at once.
        ...hardeningArgs(this.options.pidsLimit),
        '--network',
        network,
        ...labelArgs(labels),
        image,
        ...command,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * ONE subscription per install, fanned out by the driver — the shape the
   * session docker driver already uses, and deliberately not the k8s driver's
   * watch-per-handle: docker events are a single daemon-wide firehose, and N
   * subscriptions would be N processes reading the same bytes.
   *
   * Unfiltered by label on purpose. Two different label KEYS matter here (the
   * dev-env install label on our own containers, the session install label on
   * the claimant's) and `--filter label=` ANDs across keys, so a filtered
   * stream could only ever carry one of the two.
   */
  watchEvents(onEvent: (event: DockerEvent) => void, onDrop: () => void): SupervisedProcess {
    const proc = this.cli.start(['events', '--filter', 'type=container', '--format', '{{json .}}'], {
      captureStdout: true,
    });
    const stream = new JsonDocumentStream();
    proc.onStdout((chunk) => {
      for (const doc of stream.push(chunk)) {
        const raw = doc as { Action?: unknown; Actor?: { Attributes?: unknown } };
        if (typeof raw?.Action !== 'string') continue;
        const attributes = raw.Actor?.Attributes;
        onEvent({
          Action: raw.Action,
          Attributes: (typeof attributes === 'object' && attributes !== null
            ? attributes
            : {}) as Record<string, string>,
        });
      }
    });
    proc.onExit(() => onDrop());
    return proc;
  }

  /** Normalized: the default, because only taxonomy shapes may cross the seam. */
  private run(args: string[], opts: { timeoutMs?: number } = {}): string {
    try {
      return this.rawRun(args, opts);
    } catch (error) {
      throw normalizeDockerFailure(error);
    }
  }

  /**
   * Raw: for the handful of calls whose tolerance is expressed as a PREDICATE
   * over docker's own words (already-a-member, no-such-object). Normalizing
   * first would erase exactly the text those predicates read, and every one
   * of them re-normalizes what it decides not to tolerate.
   */
  private rawRun(args: string[], opts: { timeoutMs?: number } = {}): string {
    return this.cli.run(args, { timeoutMs: opts.timeoutMs ?? DOCKER_TIMEOUT_MS });
  }
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function filterArgs(filters: string[]): string[] {
  return filters.flatMap((filter) => ['--filter', filter]);
}
