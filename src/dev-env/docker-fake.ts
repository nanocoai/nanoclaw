/**
 * A stateful fake docker daemon for the docker dev-env driver's tests.
 *
 * Implements the session seam's `Cli` and interprets the exact docker
 * vocabulary the driver speaks — so tests drive real claims through real
 * realization logic and assert on what the driver DID, never on what its
 * source text looks like. Unlike `FakeCli`'s scripted responses, this fake
 * holds state: it is the thing that SURVIVES a "host restart" (the
 * `MockDevEnvRuntime` / `FakeKube` role) while driver objects die, which is
 * what makes the adoption story provable without special hooks.
 *
 * NOTHING HERE TALKS TO A DAEMON. That is the point: the suite must pass on a
 * machine with no Docker at all, and a driver change that needs a new docker
 * verb has to arrive with its fake semantics — an argv shape this fake does
 * not recognize THROWS rather than quietly returning empty, which would let a
 * new call silently pass.
 */
import { FakeSupervisedProcess } from '../drivers/fake-cli.js';

import type { Cli, SupervisedProcess } from '../drivers/cli.js';

export interface FakeDockerNetwork {
  name: string;
  created: string;
  internal: boolean;
  labels: Record<string, string>;
  /** Container names attached — the driver's own AND the claimant's. */
  members: Set<string>;
  /**
   * Member name -> the endpoint's IPv4, in the CIDR form the daemon reports.
   * Handed out per ATTACH from this network's own pool and taken back on
   * detach, which is the fact the exposure seam rests on: a container that
   * re-attaches is a new endpoint with a new address, so an address that was
   * written down anywhere is already a lie.
   */
  addresses: Map<string, string>;
  /** This network's own /16, so two envs never hand out the same address. */
  subnet: string;
  /** The pool's next host octet. Never reused, exactly like the daemon's. */
  nextHost: number;
}

export interface FakeDockerContainer {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  binds: Array<{ hostPath: string; containerPath: string }>;
  user: string | null;
  command: string[];
  /** created | running | exited. */
  state: string;
  /** Whether a TCP probe of this container answers — "the process is listening". */
  serving: boolean;
}

export interface FakeDockerCall {
  args: string[];
}

export class FakeDocker implements Cli {
  readonly bin = 'docker';
  readonly calls: FakeDockerCall[] = [];
  readonly networks = new Map<string, FakeDockerNetwork>();
  readonly containers = new Map<string, FakeDockerContainer>();
  /** What `docker image inspect` finds. Seeded with the ref the builtin stamp and the prober use. */
  readonly images = new Set<string>(['mirror.gcr.io/library/alpine:3.20']);
  /** Ordered network-membership trace, e.g. `connect denv-ins-1 agent-1`. */
  readonly networkLog: string[] = [];

  #events: FakeSupervisedProcess[] = [];
  /** Monotonic, so no two envs of one run are ever handed the same subnet. */
  #nextSubnet = 0;
  #failNext: string | null = null;
  #daemonDown = false;
  #attachOnRemove: { network: string; container: string } | null = null;

  /**
   * The daemon's clock, injectable so a suite can share ONE clock with the
   * driver. A network's `Created` is the boot budget's anchor across a host
   * restart, and that only means anything if both sides read the same time.
   */
  constructor(private readonly now: () => number = Date.now) {}

  // ---------- the runtime-side mutations tests drive ----------

  /** Finish an instance's boot: its workloads start answering, and the daemon says so. */
  completeBoot(instanceId: string): void {
    const workloads = this.workloadsOf(instanceId);
    if (workloads.length === 0) throw new Error(`fake docker: no workload for instance ${instanceId}`);
    for (const container of workloads) {
      container.state = 'running';
      container.serving = true;
      this.emit('start', container);
    }
  }

  /**
   * A boot that ended in a corpse: the workload exited and its remains stay
   * for the residue sweep to find, exactly like a Failed pod's namespace.
   */
  failBoot(instanceId: string): void {
    const workloads = this.workloadsOf(instanceId);
    if (workloads.length === 0) throw new Error(`fake docker: no workload for instance ${instanceId}`);
    for (const container of workloads) {
      container.state = 'exited';
      container.serving = false;
      this.emit('die', container);
    }
  }

  /**
   * External teardown — the end the host did not request. The whole instance
   * goes: on docker the SCOPE is the network, so an instance the runtime no
   * longer holds is a network that is no longer there.
   */
  crash(instanceId: string): void {
    for (const container of this.workloadsOf(instanceId)) {
      this.containers.delete(container.name);
      this.emit('die', container);
      this.emit('destroy', container);
    }
    for (const [name, network] of this.networks) {
      if (network.labels['nanoclaw-dev-instance'] === instanceId) this.networks.delete(name);
    }
  }

  /**
   * Simulate host death: a dead host's events stream stops. Without this a
   * "restarted" test host races its own ghost — the old driver's handles
   * would still observe transitions and settle them first.
   */
  severEvents(): void {
    this.#events = [];
  }

  /** The next network create throws this — a claim-time realization failure. */
  failNextWith(message: string): void {
    this.#failNext = message;
  }

  /** Every call throws the daemon-unreachable phrasing, until cleared. */
  setDaemonDown(down: boolean): void {
    this.#daemonDown = down;
  }

  /**
   * Someone else attaches a container to `network` in the instant the driver
   * asks to remove it — an operator's own `docker network connect`, which is
   * the one attach a host-side driver cannot see coming (its own re-attach
   * cannot interleave: `Cli.run` is synchronous). The daemon then refuses the
   * removal for active endpoints, and whether the network survives that is
   * exactly what teardown's second pass decides.
   */
  attachOnNextRemove(network: string, container: string): void {
    this.#attachOnRemove = { network, container };
  }

  /** Seed a claimant: an agent container of some session driver, wearing its labels. */
  seedContainer(name: string, labels: Record<string, string>, state = 'running'): FakeDockerContainer {
    const container: FakeDockerContainer = {
      name,
      image: 'agent:latest',
      labels,
      env: {},
      binds: [],
      user: null,
      command: [],
      state,
      serving: false,
    };
    this.containers.set(name, container);
    return container;
  }

  /** A session respawn: a NEW container of the same group starts. */
  respawnContainer(name: string, labels: Record<string, string>): FakeDockerContainer {
    const container = this.seedContainer(name, labels);
    this.emit('start', container);
    return container;
  }

  // ---------- reads the suites assert on ----------

  /** True while the runtime still holds anything allocated for this instance. */
  holds(instanceId: string): boolean {
    return this.networkOf(instanceId) !== undefined;
  }

  networkOf(instanceId: string): FakeDockerNetwork | undefined {
    for (const network of this.networks.values()) {
      if (network.labels['nanoclaw-dev-instance'] === instanceId) return network;
    }
    return undefined;
  }

  /** The claim options the runtime actually realized, read back off the network. */
  optionsOf(instanceId: string): Record<string, string> | undefined {
    const network = this.networkOf(instanceId);
    if (!network) return undefined;
    const options: Record<string, string> = {};
    for (const [key, value] of Object.entries(network.labels)) {
      if (key.startsWith('nanoclaw-dev-option.')) options[key.slice('nanoclaw-dev-option.'.length)] = value;
    }
    return options;
  }

  workloadsOf(instanceId: string): FakeDockerContainer[] {
    return [...this.containers.values()].filter(
      (container) =>
        container.labels['nanoclaw-dev-instance'] === instanceId &&
        container.labels['nanoclaw-dev-role'] === 'workload',
    );
  }

  /** Every argv this fake was asked to run, joined — convenient for clamp assertions. */
  joined(): string[] {
    return this.calls.map((call) => call.args.join(' '));
  }

  // ---------- Cli ----------

  run(args: string[]): string {
    this.calls.push({ args });
    if (this.#daemonDown) {
      throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    }
    const [verb, ...rest] = args;
    switch (verb) {
      case 'info':
        return '99.0.0\n';
      case 'image':
        return this.imageVerb(rest);
      case 'network':
        return this.networkVerb(rest);
      case 'create':
        return this.createContainer(rest);
      case 'start':
        return this.startContainer(rest);
      case 'run':
        return this.runOnce(rest);
      case 'ps':
        return this.ps(rest);
      case 'rm':
        return this.rm(rest);
      default:
        throw new Error(`fake docker: unhandled verb '${args.join(' ')}'`);
    }
  }

  start(args: string[]): SupervisedProcess {
    this.calls.push({ args });
    if (args[0] !== 'events') throw new Error(`fake docker: unhandled supervised argv '${args.join(' ')}'`);
    const proc = new FakeSupervisedProcess();
    this.#events.push(proc);
    return proc;
  }

  // ---------- verbs ----------

  private imageVerb(args: string[]): string {
    if (args[0] !== 'inspect') throw new Error(`fake docker: unhandled image verb '${args.join(' ')}'`);
    const ref = args[args.length - 1];
    if (!this.images.has(ref)) throw new Error(`Error: No such image: ${ref}`);
    return 'sha256:deadbeef\n';
  }

  private networkVerb(args: string[]): string {
    const [verb, ...rest] = args;
    if (verb === 'create') return this.createNetwork(rest);
    if (verb === 'ls') return this.listNetworks(rest);
    if (verb === 'inspect') return this.inspectNetworks(rest);
    if (verb === 'rm') return this.removeNetwork(rest);
    if (verb === 'connect') return this.connect(rest);
    if (verb === 'disconnect') return this.disconnect(rest);
    throw new Error(`fake docker: unhandled network verb '${args.join(' ')}'`);
  }

  private createNetwork(args: string[]): string {
    if (this.#failNext) {
      const message = this.#failNext;
      this.#failNext = null;
      throw new Error(message);
    }
    const internal = args.includes('--internal');
    const labels = parseLabels(args);
    const name = args[args.length - 1];
    if (this.networks.has(name)) throw new Error(`Error response from daemon: network with name ${name} already exists`);
    this.networks.set(name, {
      name,
      created: new Date(this.now()).toISOString(),
      internal,
      labels,
      members: new Set(),
      addresses: new Map(),
      subnet: `172.20.${this.#nextSubnet++ % 254}`,
      nextHost: 2,
    });
    return `${name}\n`;
  }

  private listNetworks(args: string[]): string {
    const filters = parseFilters(args);
    return (
      [...this.networks.values()]
        .filter((network) => filters.every((filter) => labelMatches(network.labels, filter)))
        .map((network) => network.name)
        .join('\n') + '\n'
    );
  }

  private inspectNetworks(args: string[]): string {
    const names = args.filter((arg) => arg !== 'inspect' && arg !== '--format' && arg !== '{{json .}}');
    const docs: string[] = [];
    for (const name of names) {
      const network = this.networks.get(name);
      if (!network) throw new Error(`Error response from daemon: network ${name} not found`);
      docs.push(
        JSON.stringify({
          Name: network.name,
          Created: network.created,
          Internal: network.internal,
          Labels: network.labels,
          Containers: Object.fromEntries(
            // Membership is the truth and the address rides it: a member the
            // pool never gave an address to reports the empty string, the way
            // the daemon reports an endpoint with no IPv4.
            [...network.members].map((member, index) => [
              `endpoint-${index}`,
              { Name: member, IPv4Address: network.addresses.get(member) ?? '' },
            ]),
          ),
        }),
      );
    }
    return docs.join('\n') + '\n';
  }

  private removeNetwork(args: string[]): string {
    const name = args[0];
    const network = this.networks.get(name);
    if (!network) throw new Error(`Error response from daemon: network ${name} not found`);
    if (this.#attachOnRemove?.network === name) {
      network.members.add(this.#attachOnRemove.container);
      this.#attachOnRemove = null;
    }
    // The real daemon refuses while endpoints remain, which is exactly what
    // makes teardown ORDER load-bearing — so the fake refuses too.
    if (network.members.size > 0) {
      throw new Error(`Error response from daemon: error while removing network: network ${name} has active endpoints`);
    }
    this.networks.delete(name);
    return '';
  }

  private connect(args: string[]): string {
    const [networkName, containerName] = args;
    const network = this.networks.get(networkName);
    if (!network) throw new Error(`Error response from daemon: network ${networkName} not found`);
    if (!this.containers.has(containerName)) {
      throw new Error(`Error response from daemon: No such container: ${containerName}`);
    }
    if (network.members.has(containerName)) {
      throw new Error(`Error response from daemon: endpoint with name ${containerName} already exists in network`);
    }
    this.attach(network, containerName);
    this.networkLog.push(`connect ${networkName} ${containerName}`);
    return '';
  }

  private disconnect(args: string[]): string {
    const [, networkName, containerName] = args; // ['-f', net, container]
    const network = this.networks.get(networkName);
    if (!network || !network.members.has(containerName)) {
      throw new Error(`Error response from daemon: container ${containerName} is not connected to network`);
    }
    this.detach(network, containerName);
    this.networkLog.push(`disconnect ${networkName} ${containerName}`);
    return '';
  }

  /** One endpoint, with one address out of this network's pool. */
  private attach(network: FakeDockerNetwork, container: string): void {
    network.members.add(container);
    network.addresses.set(container, `${network.subnet}.${network.nextHost}/16`);
    network.nextHost += 1;
  }

  /** The endpoint goes and its address goes with it — there is nothing left to dial. */
  private detach(network: FakeDockerNetwork, container: string): void {
    network.members.delete(container);
    network.addresses.delete(container);
  }

  private createContainer(args: string[]): string {
    const name = valueAfter(args, '--name')!;
    const networkName = valueAfter(args, '--network')!;
    const network = this.networks.get(networkName);
    if (!network) throw new Error(`Error response from daemon: network ${networkName} not found`);
    if (this.containers.has(name)) {
      throw new Error(`Error response from daemon: Conflict. The container name "/${name}" is already in use`);
    }
    const image = positionalImage(args);
    if (!this.images.has(image)) throw new Error(`Error response from daemon: No such image: ${image}`);
    for (const bind of parseBinds(args)) {
      if (!bind.hostPath.startsWith('/')) {
        throw new Error(`Error response from daemon: invalid mount config: ${bind.hostPath}`);
      }
    }
    this.containers.set(name, {
      name,
      image,
      labels: parseLabels(args),
      env: parseEnv(args),
      binds: parseBinds(args),
      user: valueAfter(args, '--user') ?? null,
      command: args.slice(args.indexOf(image) + 1),
      state: 'created',
      serving: false,
    });
    this.attach(network, name);
    return `${name}\n`;
  }

  private startContainer(args: string[]): string {
    const container = this.containers.get(args[0]);
    if (!container) throw new Error(`Error response from daemon: No such container: ${args[0]}`);
    container.state = 'running';
    this.emit('start', container);
    return '';
  }

  /**
   * The readiness prober, run to completion. Resolves the target the way the
   * daemon's embedded DNS does — by container name, on that network only —
   * and answers with the same two-valued vocabulary busybox `nc -z` does.
   */
  private runOnce(args: string[]): string {
    const networkName = valueAfter(args, '--network')!;
    const image = positionalImage(args);
    if (!this.images.has(image)) throw new Error(`Error response from daemon: No such image: ${image}`);
    const network = this.networks.get(networkName);
    if (!network) throw new Error(`Error response from daemon: network ${networkName} not found`);
    const command = args.slice(args.indexOf(image) + 1);
    const host = command[command.length - 2];
    const target = this.containers.get(host);
    if (!target || !network.members.has(host)) throw new Error(`nc: bad address '${host}'`);
    if (target.state !== 'running' || !target.serving) throw new Error('nc: connect refused');
    return '';
  }

  private ps(args: string[]): string {
    const filters = parseFilters(args);
    const labelFilters = filters.filter((filter) => filter.startsWith('label='));
    const statuses = filters.filter((filter) => filter.startsWith('status=')).map((filter) => filter.slice(7));
    const format = valueAfter(args, '--format') ?? '{{.Names}}|{{.State}}';
    const keys = [...format.matchAll(/\{\{\.Label "([^"]+)"\}\}/g)].map((match) => match[1]);
    return (
      [...this.containers.values()]
        .filter((container) => labelFilters.every((filter) => labelMatches(container.labels, filter)))
        // Repeated same-key filters OR on the real daemon.
        .filter((container) => statuses.length === 0 || statuses.includes(container.state))
        .map((container) =>
          [container.name, container.state, ...keys.map((key) => container.labels[key] ?? '')].join('|'),
        )
        .join('\n') + '\n'
    );
  }

  private rm(args: string[]): string {
    const names = args.filter((arg) => arg !== '--force');
    for (const name of names) {
      const container = this.containers.get(name);
      if (!container) throw new Error(`Error response from daemon: No such container: ${name}`);
      this.containers.delete(name);
      for (const network of this.networks.values()) this.detach(network, name);
      this.emit('destroy', container);
    }
    return '';
  }

  // ---------- events ----------

  private emit(action: string, container: FakeDockerContainer): void {
    const doc = JSON.stringify({
      Type: 'container',
      Action: action,
      Actor: { Attributes: { name: container.name, ...container.labels } },
    });
    // A killed subscription hears nothing more — dispose() has to mean it.
    for (const proc of [...this.#events]) if (!proc.killed) proc.emitStdout(doc);
  }
}

// ---------- argv parsing, deliberately narrow ----------

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseLabels(args: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== '--label') return;
    const raw = args[index + 1] ?? '';
    const split = raw.indexOf('=');
    if (split > 0) labels[raw.slice(0, split)] = raw.slice(split + 1);
  });
  return labels;
}

function parseEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== '-e') return;
    const raw = args[index + 1] ?? '';
    const split = raw.indexOf('=');
    if (split > 0) env[raw.slice(0, split)] = raw.slice(split + 1);
  });
  return env;
}

function parseBinds(args: string[]): Array<{ hostPath: string; containerPath: string }> {
  const binds: Array<{ hostPath: string; containerPath: string }> = [];
  args.forEach((arg, index) => {
    if (arg !== '-v') return;
    const [hostPath, containerPath] = (args[index + 1] ?? '').split(':');
    binds.push({ hostPath, containerPath });
  });
  return binds;
}

function parseFilters(args: string[]): string[] {
  const filters: string[] = [];
  args.forEach((arg, index) => {
    if (arg === '--filter') filters.push(args[index + 1] ?? '');
  });
  return filters;
}

/**
 * `label=k` matches presence, `label=k=v` matches equality — the daemon's own
 * two-valued filter grammar, which the driver's discovery depends on.
 */
function labelMatches(labels: Record<string, string>, filter: string): boolean {
  if (!filter.startsWith('label=')) return true;
  const term = filter.slice('label='.length);
  const split = term.indexOf('=');
  if (split < 0) return labels[term] !== undefined;
  return labels[term.slice(0, split)] === term.slice(split + 1);
}

/**
 * The image is the first positional after the flags. Every flag this driver
 * emits is either a bare switch or a `--flag value` pair, and the fake knows
 * which is which — an unrecognized flag throws rather than sliding the
 * positional, because a silently mis-parsed argv is exactly the class of bug
 * a fake exists to catch.
 */
const VALUE_FLAGS = new Set([
  '--name',
  '--network',
  '--label',
  '-e',
  '-v',
  '--user',
  '--format',
  '--filter',
  '--security-opt',
  '--pids-limit',
]);
const BARE_FLAGS = new Set([
  '--rm',
  '--pull=never',
  '--internal',
  '--force',
  '--cap-drop=ALL',
  '--cap-add=NET_BIND_SERVICE',
  '--init',
  '-a',
  '-q',
  '-f',
]);

function positionalImage(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === 'create' || arg === 'run') continue;
    if (BARE_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`fake docker: unknown flag '${arg}' in '${args.join(' ')}'`);
    return arg;
  }
  throw new Error(`fake docker: no image in '${args.join(' ')}'`);
}
