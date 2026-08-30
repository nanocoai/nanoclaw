/**
 * A stateful fake cluster for the k8s dev-env driver's tests.
 *
 * Implements the session seam's `Cli` and interprets the exact kubectl
 * vocabulary the driver speaks — so tests drive real claims through real
 * realization logic and assert on what the driver DID. Unlike `FakeCli`'s
 * scripted responses, this fake holds state: it is the thing that SURVIVES a
 * "host restart" (the MockDevEnvRuntime role) while driver objects die, which
 * is what makes the adoption story provable without special hooks.
 *
 * Deliberately interprets only what the driver says. An argv shape this fake
 * does not recognize throws — a new kubectl verb in the driver must arrive
 * with its fake semantics, or tests would silently pass over it.
 */
import { FakeSupervisedProcess } from '../drivers/fake-cli.js';

import type { Cli, SupervisedProcess } from '../drivers/cli.js';

export interface FakeNamespace {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  resourceVersion: number;
  /** Stamped at create like the real apiserver does — the boot budget's anchor across "restarts". */
  creationTimestamp: string;
  terminating: boolean;
}

export interface FakePod {
  namespace: string;
  uid: string;
  phase: 'Pending' | 'Running' | 'Failed';
  ready: boolean;
}

/**
 * A CHILD cluster: its own object store, reached through a kubeconfig the
 * driver minted rather than through the parent's argv. Keyed by the kubeconfig
 * path kubectl was actually pointed at, which is the only identity a real
 * kubectl has — a driver that passed the wrong file would land in the wrong
 * store here, exactly as it would in a real cluster.
 */
export interface FakeChildCluster {
  namespace: string;
  applied: string[];
  /**
   * Keyed `${namespace}/${name}`, like the apiserver namespaces them: a
   * multi-component stamp gates on several Deployments across several child
   * namespaces, and a name-keyed store would answer a probe for
   * `system/gateway` with whatever `gateway` was applied anywhere.
   *
   * `spec` is the last applied document's — what `get deployment` reports a
   * template from (the C16 variant evidence).
   */
  deployments: Map<string, { namespace: string; ready: boolean; spec?: Record<string, unknown> }>;
}

interface FakeWatch {
  namespace: string;
  proc: FakeSupervisedProcess;
}

export interface FakeCall {
  args: string[];
  input?: string;
}

export class FakeKube implements Cli {
  readonly bin = 'kubectl';
  readonly calls: FakeCall[] = [];
  readonly namespaces = new Map<string, FakeNamespace>();
  readonly secrets = new Map<string, Record<string, string>>(); // `${ns}/${name}` -> data (base64 values)
  readonly pods = new Map<string, FakePod>(); // ns -> the vcluster pod
  readonly rbacDocs = new Map<string, object>(); // `${ns}/${kind}/${name}` -> applied Role/RoleBinding
  /** `${ns}/${name}` -> created NetworkPolicy — the D19 per-claim routes under test. */
  readonly netpols = new Map<
    string,
    { name: string; namespace: string; labels: Record<string, string>; doc: object }
  >();
  /** Ordered open/close trace, e.g. `create agents/dev-env-route-ins-1`. */
  readonly netpolLog: string[] = [];
  /** name -> created PersistentVolume — cluster-scoped, so it survives namespace deletes on purpose. */
  readonly pvs = new Map<string, { name: string; labels: Record<string, string>; spec: Record<string, unknown> }>();
  /** Ordered create/delete trace, e.g. `create nanoclaw-dev-tree-<ns>`. */
  readonly pvLog: string[] = [];
  /** What `get nodes` answers — the single-node substrate by default. */
  nodeNames = ['fake-node'];
  /** Per-node `status.images` names — the C15 re-probe's report. Unset node = empty report. */
  readonly nodeImages = new Map<string, string[]>();
  /** `${ns}/${name}` -> created placement Job (C15). */
  readonly jobs = new Map<
    string,
    {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      doc: object;
      status: { succeeded?: number; failed?: number };
      creationTimestamp: string;
    }
  >();
  /** `${ns}/${name}` -> what `logs job/<name>` answers. */
  readonly jobLogs = new Map<string, string>();
  /** Ordered create/delete trace, e.g. `create nanoclaw-dev-place/place-x-v1`. */
  readonly jobLog: string[] = [];
  readonly children = new Map<string, FakeChildCluster>(); // kubeconfig path -> the child it reaches
  /** clusterIP the parent reports for each instance's `vc` service. */
  readonly serviceIPs = new Map<string, string>();
  /**
   * Parent-side Services the syncer materialized from child Services, keyed
   * `${parentNs}/${syncedName}` — what the C14 exposure resolver reads. They
   * carry the syncer's managed-by label, which is what tells them from the
   * control plane's own `vc` services.
   */
  readonly syncedServices = new Map<
    string,
    {
      name: string;
      namespace: string;
      labels: Record<string, string>;
      annotations: Record<string, string>;
      clusterIP: string;
      ports: number[];
    }
  >();
  /**
   * Parent-side PVCs the syncer materialized from child PVC applies, keyed
   * `${parentNs}/${syncedName}` — where the dev flavor's fidelity gate looks.
   */
  readonly syncedPvcs = new Map<
    string,
    { name: string; namespace: string; storageClassName?: string; volumeName: string }
  >();
  /** When true, synced PVCs bind a fresh provisioned volume even when a pre-bound PV names them — the §3.8 STOP shape. */
  provisionerWinsBinds = false;
  /** When true, child PVC applies materialize nothing parent-side — a green gate with no dev PVC behind it. */
  syncerDropsPvcs = false;
  /** When true, a child Deployment is Available the moment it is applied. */
  autoChildRollout = false;
  #watches: FakeWatch[] = [];
  #nextUid = 1;
  #rv = 1;
  /** Next mutating claim-path call throws this kubectl-shaped message. */
  #failNext: string | null = null;
  /** When true, created pods stay Pending until completeBoot — the D18 async path. */
  manualCompletion = true;

  // ---------- the runtime-side mutations tests drive ----------

  /** Finish an instance's boot: pod ready + the syncer's kubeconfig secret. */
  completeBoot(namespace: string): void {
    const pod = this.mustPod(namespace);
    pod.phase = 'Running';
    pod.ready = true;
    this.secrets.set(`${namespace}/vc-vc`, { config: Buffer.from(kubeconfigFor(namespace)).toString('base64') });
    this.emit(namespace, 'MODIFIED');
  }

  /** Finish the rollout of everything stamped INSIDE one instance's child cluster. */
  completeChildRollout(namespace: string): void {
    const child = this.childOf(namespace);
    if (!child) throw new Error(`fake kube: nothing has reached the child of ${namespace} yet`);
    for (const deployment of child.deployments.values()) deployment.ready = true;
  }

  childOf(namespace: string): FakeChildCluster | undefined {
    return [...this.children.values()].find((c) => c.namespace === namespace);
  }

  /**
   * Materialize a child Service parent-side, exactly as the syncer does:
   * `<name>-x-<child-ns>-x-vc`, managed-by stamped, a fresh ClusterIP. The
   * live-drift story is `syncService` twice with different IPs — a delete and
   * recreate inside the child, which is what an exposure must survive.
   */
  syncService(input: {
    namespace: string;
    childNamespace?: string;
    name: string;
    port: number;
    clusterIP: string;
  }): string {
    const childNamespace = input.childNamespace ?? 'default';
    const synced = `${input.name}-x-${childNamespace}-x-vc`;
    this.syncedServices.set(`${input.namespace}/${synced}`, {
      name: synced,
      namespace: input.namespace,
      labels: { 'vcluster.loft.sh/managed-by': 'vc' },
      annotations: {
        'vcluster.loft.sh/object-name': input.name,
        'vcluster.loft.sh/object-namespace': childNamespace,
      },
      clusterIP: input.clusterIP,
      ports: [input.port],
    });
    return synced;
  }

  /** The child deleting its Service: the parent object goes with it. */
  dropSyncedService(namespace: string, syncedName: string): void {
    this.syncedServices.delete(`${namespace}/${syncedName}`);
  }

  /** Finish a placement Job (C15) — kubelet ran the placer to completion. */
  completeJob(namespace: string, name: string): void {
    this.mustJob(namespace, name).status.succeeded = 1;
  }

  /** Fail a placement Job, with what its pod's logs would say. */
  failJob(namespace: string, name: string, logs = ''): void {
    this.mustJob(namespace, name).status.failed = 1;
    this.jobLogs.set(`${namespace}/${name}`, logs);
  }

  private mustJob(namespace: string, name: string): { status: { succeeded?: number; failed?: number } } {
    const job = this.jobs.get(`${namespace}/${name}`);
    if (!job) throw new Error(`fake kube has no job ${namespace}/${name}`);
    return job;
  }

  /** Fail a boot, leaving dead residue in the runtime. */
  failBoot(namespace: string): void {
    const pod = this.mustPod(namespace);
    pod.phase = 'Failed';
    pod.ready = false;
    this.emit(namespace, 'MODIFIED');
  }

  /** External teardown — the end the host did not request. */
  crash(namespace: string): void {
    this.namespaces.delete(namespace);
    this.pods.delete(namespace);
    this.secrets.delete(`${namespace}/vc-vc`);
    this.secrets.delete(`${namespace}/vc-config-vc`);
    this.dropChild(namespace);
    this.emit(namespace, 'DELETED');
  }

  /** Deleting the namespace deletes the child inside it — D10's teardown, as the runtime does it. */
  private dropChild(namespace: string): void {
    this.serviceIPs.delete(namespace);
    for (const [key, child] of this.children) {
      if (child.namespace === namespace) this.children.delete(key);
    }
    for (const key of [...this.syncedPvcs.keys()]) {
      if (key.startsWith(`${namespace}/`)) this.syncedPvcs.delete(key);
    }
    for (const key of [...this.syncedServices.keys()]) {
      if (key.startsWith(`${namespace}/`)) this.syncedServices.delete(key);
    }
  }

  /** Simulate host death: a dead host's watches must stop observing. */
  severWatches(): void {
    this.#watches = [];
  }

  failNextClaimWith(message: string): void {
    this.#failNext = message;
  }

  /** EVERY child apply throws this — a deterministic apiserver rejection, not weather, so it never clears itself. */
  failChildApplyWith(message: string): void {
    this.#failChildApply = message;
  }
  #failChildApply: string | null = null;

  /** The NEXT child call throws this, then the weather clears — a just-born apiserver's connection-refused blip. */
  failNextChildCallWith(message: string): void {
    this.#failNextChild = message;
  }
  #failNextChild: string | null = null;

  /** Next CAS label call loses the race — another claimer got there first. */
  conflictNextCasLabel(): void {
    this.#conflictNextCas = true;
  }
  #conflictNextCas = false;

  /** A namespace the driver did NOT create — the claimant's (`agents`), which pre-exists on a real cluster. */
  seedForeignNamespace(name: string): void {
    this.namespaces.set(name, {
      name,
      labels: {},
      annotations: {},
      resourceVersion: this.#rv++,
      creationTimestamp: new Date().toISOString(),
      terminating: false,
    });
  }

  namespaceByLabel(key: string, value: string): FakeNamespace | undefined {
    return [...this.namespaces.values()].find((ns) => ns.labels[key] === value);
  }

  watchProcs(namespace: string): FakeSupervisedProcess[] {
    return this.#watches.filter((w) => w.namespace === namespace).map((w) => w.proc);
  }

  // ---------- Cli ----------

  run(args: string[], opts?: { input?: string; timeoutMs?: number }): string {
    this.calls.push({ args, input: opts?.input });
    const joined = args.join(' ');

    // A --kubeconfig is kubectl talking to a DIFFERENT cluster; nothing about
    // the parent's stores may answer it.
    const kubeconfig = args.find((a) => a.startsWith('--kubeconfig='));
    if (kubeconfig) return this.runChild(kubeconfig.slice('--kubeconfig='.length), args, opts);

    if (args[0] === 'version') return '{"clientVersion":{},"serverVersion":{}}';

    if (args[0] === 'get') return this.handleGet(args);

    if (args[0] === 'create' && args.includes('-f')) {
      this.consumeInjectedFailure();
      const doc = JSON.parse(opts?.input ?? '{}') as {
        kind?: string;
        spec?: Record<string, unknown>;
        metadata?: {
          name?: string;
          namespace?: string;
          labels?: Record<string, string>;
          annotations?: Record<string, string>;
        };
      };
      if (doc.kind === 'PersistentVolume') {
        const pvName = doc.metadata!.name!;
        // create is NOT apply — a second create is AlreadyExists (what the
        // driver's replay-heal path tolerates on purpose).
        if (this.pvs.has(pvName)) throw new Error(`persistentvolumes "${pvName}" already exists`);
        this.pvs.set(pvName, { name: pvName, labels: { ...(doc.metadata?.labels ?? {}) }, spec: doc.spec ?? {} });
        this.pvLog.push(`create ${pvName}`);
        return `persistentvolume/${pvName} created`;
      }
      if (doc.kind === 'NetworkPolicy') {
        const namespace = doc.metadata!.namespace!;
        const policyName = doc.metadata!.name!;
        // Honest apiserver shape: a route lands in a namespace that exists...
        if (!this.namespaces.has(namespace)) throw new Error(`namespaces "${namespace}" not found (NotFound)`);
        // ...and create is NOT apply — a second create is AlreadyExists.
        if (this.netpols.has(`${namespace}/${policyName}`)) {
          throw new Error(`networkpolicies.networking.k8s.io "${policyName}" already exists`);
        }
        this.netpols.set(`${namespace}/${policyName}`, {
          name: policyName,
          namespace,
          labels: { ...(doc.metadata?.labels ?? {}) },
          doc,
        });
        this.netpolLog.push(`create ${namespace}/${policyName}`);
        return `networkpolicy.networking.k8s.io/${policyName} created`;
      }
      if (doc.kind === 'Job') {
        const namespace = doc.metadata!.namespace!;
        const jobName = doc.metadata!.name!;
        if (!this.namespaces.has(namespace)) throw new Error(`namespaces "${namespace}" not found (NotFound)`);
        const key = `${namespace}/${jobName}`;
        if (this.jobs.has(key)) throw new Error(`jobs.batch "${jobName}" already exists`);
        this.jobs.set(key, {
          name: jobName,
          namespace,
          labels: { ...(doc.metadata?.labels ?? {}) },
          doc,
          status: {},
          creationTimestamp: new Date().toISOString(),
        });
        this.jobLog.push(`create ${key}`);
        return `job.batch/${jobName} created`;
      }
      if (doc.kind !== 'Namespace') throw new Error(`fake kube: unexpected create of kind ${doc.kind}`);
      const name = doc.metadata!.name!;
      if (this.namespaces.has(name)) throw new Error(`namespaces "${name}" already exists`);
      this.namespaces.set(name, {
        name,
        labels: { ...(doc.metadata?.labels ?? {}) },
        annotations: { ...(doc.metadata?.annotations ?? {}) },
        resourceVersion: this.#rv++,
        creationTimestamp: new Date().toISOString(),
        terminating: false,
      });
      return `namespace/${name} created`;
    }

    if (args[0] === 'apply') {
      this.consumeInjectedFailure();
      const input = opts?.input ?? '';
      if (input.trimStart().startsWith('{')) {
        const doc = JSON.parse(input) as {
          kind?: string;
          metadata?: { name?: string; namespace?: string };
          stringData?: Record<string, string>;
        };
        if (doc.kind === 'Role' || doc.kind === 'RoleBinding') {
          // The minted per-namespace host access.
          if (!this.namespaces.has(doc.metadata!.namespace!)) {
            throw new Error(`namespaces "${doc.metadata!.namespace}" not found`);
          }
          this.rbacDocs.set(`${doc.metadata!.namespace}/${doc.kind}/${doc.metadata!.name}`, doc);
          return `${doc.kind!.toLowerCase()}/${doc.metadata!.name} configured`;
        }
        // The regenerated config secret.
        if (doc.kind !== 'Secret') throw new Error(`fake kube: unexpected JSON apply of kind ${doc.kind}`);
        const key = `${doc.metadata!.namespace}/${doc.metadata!.name}`;
        const data: Record<string, string> = {};
        for (const [k, v] of Object.entries(doc.stringData ?? {})) data[k] = Buffer.from(v).toString('base64');
        this.secrets.set(key, data);
        return `secret/${doc.metadata!.name} configured`;
      }
      // The rendered vcluster bundle: realize it as "a vcluster pod exists".
      const nsMatch = input.match(/namespace: ([a-z0-9-]+)/);
      if (!nsMatch) throw new Error('fake kube: applied manifests carry no namespace');
      const namespace = nsMatch[1];
      if (!this.namespaces.has(namespace)) throw new Error(`namespaces "${namespace}" not found`);
      // The bundle carries the `vc` Service, so the address of the child API
      // exists from the apply on — long before anything answers on it.
      if (!this.serviceIPs.has(namespace)) this.serviceIPs.set(namespace, `10.43.0.${this.serviceIPs.size + 10}`);
      if (!this.pods.has(namespace)) {
        const pod: FakePod = { namespace, uid: `uid-${this.#nextUid++}`, phase: 'Pending', ready: false };
        if (!this.manualCompletion) {
          pod.phase = 'Running';
          pod.ready = true;
          this.secrets.set(`${namespace}/vc-vc`, { config: Buffer.from(kubeconfigFor(namespace)).toString('base64') });
        }
        this.pods.set(namespace, pod);
        this.emit(namespace, 'ADDED');
      }
      return 'applied';
    }

    if (args[0] === 'label' && args[1] === 'namespace') return this.handleLabel(args);
    if (args[0] === 'annotate' && args[1] === 'namespace') return this.handleAnnotate(args);

    if (args[0] === 'delete' && args[1] === 'namespace') {
      const name = args[2];
      if (this.namespaces.has(name)) {
        this.namespaces.delete(name);
        this.pods.delete(name);
        this.secrets.delete(`${name}/vc-vc`);
        this.secrets.delete(`${name}/vc-config-vc`);
        this.dropChild(name);
        // Namespaced objects die with their namespace — but NOT objects in
        // OTHER namespaces, which is the whole reason routes need explicit
        // closes: a route in the claimant ns survives its child's deletion.
        for (const key of [...this.netpols.keys()]) {
          if (key.startsWith(`${name}/`)) this.netpols.delete(key);
        }
        this.emit(name, 'DELETED');
      }
      return '';
    }

    if (args[0] === 'delete' && (args[1] === 'persistentvolume' || args[1] === 'persistentvolumes')) {
      const pvName = args[2];
      // Cluster-scoped: no -n may ride this argv (kubectl would refuse it).
      if (args.includes('-n')) throw new Error(`fake kube: -n on a cluster-scoped delete: ${joined}`);
      if (!this.pvs.has(pvName) && !args.includes('--ignore-not-found')) {
        throw new Error(`persistentvolumes "${pvName}" not found (NotFound)`);
      }
      if (this.pvs.delete(pvName)) this.pvLog.push(`delete ${pvName}`);
      return '';
    }

    if (args[0] === 'delete' && (args[1] === 'job' || args[1] === 'jobs')) {
      const jobName = args[2];
      const namespace = args[args.indexOf('-n') + 1];
      const key = `${namespace}/${jobName}`;
      if (!this.jobs.has(key) && !args.includes('--ignore-not-found')) {
        throw new Error(`jobs.batch "${jobName}" not found (NotFound)`);
      }
      if (this.jobs.delete(key)) {
        this.jobLogs.delete(key);
        this.jobLog.push(`delete ${key}`);
      }
      return '';
    }

    if (args[0] === 'logs') {
      const target = args[1]; // `job/<name>`
      const namespace = args[args.indexOf('-n') + 1];
      if (!target.startsWith('job/')) throw new Error(`fake kube does not interpret logs target: ${target}`);
      const key = `${namespace}/${target.slice('job/'.length)}`;
      if (!this.jobs.has(key)) throw new Error(`jobs.batch "${target.slice('job/'.length)}" not found (NotFound)`);
      return this.jobLogs.get(key) ?? '';
    }

    if (args[0] === 'delete' && (args[1] === 'networkpolicy' || args[1] === 'networkpolicies')) {
      const policyName = args[2];
      const namespace = args[args.indexOf('-n') + 1];
      const key = `${namespace}/${policyName}`;
      if (!this.netpols.has(key) && !args.includes('--ignore-not-found')) {
        throw new Error(`networkpolicies.networking.k8s.io "${policyName}" not found (NotFound)`);
      }
      if (this.netpols.delete(key)) this.netpolLog.push(`delete ${key}`);
      return '';
    }

    throw new Error(`fake kube does not interpret: ${joined}`);
  }

  start(args: string[]): SupervisedProcess {
    this.calls.push({ args });
    const nsIdx = args.indexOf('-n');
    if (args[0] !== 'get' || args[1] !== 'pods' || nsIdx < 0 || !args.includes('--watch')) {
      throw new Error(`fake kube does not interpret watch: ${args.join(' ')}`);
    }
    const namespace = args[nsIdx + 1];
    const proc = new FakeSupervisedProcess();
    this.#watches.push({ namespace, proc });
    // kubectl emits current state first; deltas follow.
    const pod = this.pods.get(namespace);
    if (pod) queueEmit(proc, watchEventJson('ADDED', pod));
    return proc;
  }

  // ---------- internals ----------

  /**
   * kubectl pointed at a child cluster. The flags are load-bearing and checked
   * as such: the syncer's exported kubeconfig names a service DNS the host
   * cannot resolve, so a driver that forgot to redirect it at the clusterIP —
   * or aimed at the wrong IP — must fail HERE, the way it would on the node,
   * not quietly read the parent's objects.
   */
  private runChild(kubeconfig: string, args: string[], opts?: { input?: string }): string {
    if (this.#failNextChild) {
      const message = this.#failNextChild;
      this.#failNextChild = null;
      throw new Error(message);
    }
    const serverName = flagValue(args, '--tls-server-name');
    const server = flagValue(args, '--server');
    if (!server || !serverName) {
      throw new Error(`fake kube: child call without --server/--tls-server-name: ${args.join(' ')}`);
    }
    // The SAN the syncer minted: `vc.<namespace>.svc`.
    const namespace = serverName.split('.')[1] ?? '';
    const expected = this.serviceIPs.get(namespace);
    if (!expected || server !== `https://${expected}:443`) {
      throw new Error(`The connection to the server ${server} was refused - did you specify the right host or port?`);
    }
    const child: FakeChildCluster = this.children.get(kubeconfig) ?? {
      namespace,
      applied: [],
      deployments: new Map(),
    };
    this.children.set(kubeconfig, child);

    const rest = args.filter(
      (a) => !a.startsWith('--kubeconfig=') && !a.startsWith('--server=') && !a.startsWith('--tls-server-name='),
    );
    if (rest[0] === 'apply') {
      if (this.#failChildApply) throw new Error(this.#failChildApply);
      const input = opts?.input ?? '';
      child.applied.push(input);
      for (const doc of input.split('\n---\n')) {
        const parsed = JSON.parse(doc) as {
          kind?: string;
          metadata?: { name?: string; namespace?: string };
          spec?: { storageClassName?: string };
        };
        if (parsed.kind === 'Deployment') {
          // Apply is idempotent and must NOT un-ready a rollout that has
          // landed — but it DOES converge the spec, like the real apiserver.
          const namespace = parsed.metadata?.namespace ?? 'default';
          const key = `${namespace}/${parsed.metadata!.name}`;
          const existing = child.deployments.get(key);
          child.deployments.set(key, {
            namespace,
            ready: existing?.ready ?? (this.autoChildRollout || !this.manualCompletion),
            spec: parsed.spec as Record<string, unknown>,
          });
        }
        // The syncer: a child PVC materializes parent-side under the derived
        // name and BINDS there — to a pre-bound PV whose claimRef names it, or
        // to a freshly provisioned volume when no pre-bind (or an interfering
        // provisioner) wins the race.
        if (parsed.kind === 'PersistentVolumeClaim' && !this.syncerDropsPvcs) {
          const syncedName = `${parsed.metadata!.name}-x-${parsed.metadata!.namespace}-x-vc`;
          const key = `${child.namespace}/${syncedName}`;
          if (!this.syncedPvcs.has(key)) {
            const preBound = [...this.pvs.values()].find((pv) => {
              const ref = pv.spec.claimRef as { namespace?: string; name?: string } | undefined;
              return ref?.namespace === child.namespace && ref?.name === syncedName;
            });
            this.syncedPvcs.set(key, {
              name: syncedName,
              namespace: child.namespace,
              storageClassName: parsed.spec?.storageClassName,
              volumeName: preBound && !this.provisionerWinsBinds ? preBound.name : `pvc-${this.#nextUid++}`,
            });
          }
        }
      }
      return 'applied';
    }
    if (rest[0] === 'get' && (rest[1] === 'deployment' || rest[1] === 'deployments')) {
      // The namespace is load-bearing: a gate on `system/gateway` must not be
      // answered by a `gateway` that only ever landed in `default`.
      const namespace = rest.includes('-n') ? rest[rest.indexOf('-n') + 1] : 'default';
      const deployment = child.deployments.get(`${namespace}/${rest[2]}`);
      if (!deployment) throw new Error(`deployments.apps "${rest[2]}" not found (NotFound)`);
      return JSON.stringify({
        kind: 'Deployment',
        metadata: { name: rest[2], namespace },
        // The applied spec rides the read — the pod template is what the C16
        // fidelity gate's variant evidence inspects.
        ...(deployment.spec ? { spec: deployment.spec } : {}),
        status: {
          readyReplicas: deployment.ready ? 1 : 0,
          conditions: [{ type: 'Available', status: deployment.ready ? 'True' : 'False' }],
        },
      });
    }
    throw new Error(`fake kube does not interpret child call: ${rest.join(' ')}`);
  }

  private handleGet(args: string[]): string {
    const target = args[1];
    if (target === 'namespaces' || target === 'namespace' || target === 'ns') {
      if (args[1] === 'namespaces' && args.includes('-l')) {
        const selector = args[args.indexOf('-l') + 1];
        const items = [...this.namespaces.values()].filter((ns) => matchesSelector(ns.labels, selector));
        return JSON.stringify({ kind: 'NamespaceList', items: items.map(namespaceJson) });
      }
      const ns = this.namespaces.get(args[2]);
      if (!ns) throw new Error(`namespaces "${args[2]}" not found (NotFound)`);
      return JSON.stringify(namespaceJson(ns));
    }
    if (target === 'pods') {
      const namespace = args[args.indexOf('-n') + 1];
      const pod = this.pods.get(namespace);
      return JSON.stringify({ kind: 'PodList', items: pod ? [podJson(pod)] : [] });
    }
    if (target === 'secret') {
      const namespace = args[args.indexOf('-n') + 1];
      const data = this.secrets.get(`${namespace}/${args[2]}`);
      if (!data) throw new Error(`secrets "${args[2]}" not found (NotFound)`);
      return JSON.stringify({ kind: 'Secret', metadata: { name: args[2], namespace }, data });
    }
    if (target === 'networkpolicies' || target === 'networkpolicy') {
      const namespace = args[args.indexOf('-n') + 1];
      const selector = args.includes('-l') ? args[args.indexOf('-l') + 1] : '';
      const items = [...this.netpols.values()].filter(
        (np) => np.namespace === namespace && (!selector || matchesSelector(np.labels, selector)),
      );
      return JSON.stringify({
        kind: 'NetworkPolicyList',
        items: items.map((np) => ({
          kind: 'NetworkPolicy',
          metadata: { name: np.name, namespace: np.namespace, labels: { ...np.labels } },
        })),
      });
    }
    if (target === 'svc' || target === 'service') {
      const namespace = args[args.indexOf('-n') + 1];
      if (args[2] === '-n' || args.includes('-l')) {
        // The list form the exposure resolver uses: synced Services only.
        const selector = args.includes('-l') ? args[args.indexOf('-l') + 1] : '';
        const items = [...this.syncedServices.values()].filter(
          (svc) => svc.namespace === namespace && (!selector || matchesSelector(svc.labels, selector)),
        );
        return JSON.stringify({
          kind: 'ServiceList',
          items: items.map((svc) => ({
            kind: 'Service',
            metadata: {
              name: svc.name,
              namespace: svc.namespace,
              labels: { ...svc.labels },
              annotations: { ...svc.annotations },
            },
            spec: { clusterIP: svc.clusterIP, ports: svc.ports.map((port) => ({ port, protocol: 'TCP' })) },
          })),
        });
      }
      const synced = this.syncedServices.get(`${namespace}/${args[2]}`);
      if (synced) {
        return JSON.stringify({
          kind: 'Service',
          metadata: {
            name: synced.name,
            namespace,
            labels: { ...synced.labels },
            annotations: { ...synced.annotations },
          },
          spec: { clusterIP: synced.clusterIP, ports: synced.ports.map((port) => ({ port, protocol: 'TCP' })) },
        });
      }
      const clusterIP = this.serviceIPs.get(namespace);
      if (!clusterIP) throw new Error(`services "${args[2]}" not found (NotFound)`);
      return JSON.stringify({ kind: 'Service', metadata: { name: args[2], namespace }, spec: { clusterIP } });
    }
    if (target === 'pvc' || target === 'persistentvolumeclaim' || target === 'persistentvolumeclaims') {
      const namespace = args[args.indexOf('-n') + 1];
      const pvc = this.syncedPvcs.get(`${namespace}/${args[2]}`);
      if (!pvc) throw new Error(`persistentvolumeclaims "${args[2]}" not found (NotFound)`);
      return JSON.stringify({
        kind: 'PersistentVolumeClaim',
        metadata: { name: pvc.name, namespace: pvc.namespace },
        spec: { storageClassName: pvc.storageClassName, volumeName: pvc.volumeName },
      });
    }
    if (target === 'persistentvolumes' || target === 'persistentvolume') {
      const selector = args.includes('-l') ? args[args.indexOf('-l') + 1] : '';
      const items = [...this.pvs.values()].filter((pv) => !selector || matchesSelector(pv.labels, selector));
      return JSON.stringify({
        kind: 'PersistentVolumeList',
        items: items.map((pv) => ({
          kind: 'PersistentVolume',
          metadata: { name: pv.name, labels: { ...pv.labels } },
          spec: pv.spec,
        })),
      });
    }
    if (target === 'nodes' || target === 'node') {
      return JSON.stringify({
        kind: 'NodeList',
        items: this.nodeNames.map((name) => ({
          kind: 'Node',
          metadata: { name },
          status: { images: (this.nodeImages.get(name) ?? []).map((imageName) => ({ names: [imageName] })) },
        })),
      });
    }
    if (target === 'job' || target === 'jobs') {
      const namespace = args[args.indexOf('-n') + 1];
      if (target === 'jobs' || args.includes('-l')) {
        const selector = args.includes('-l') ? args[args.indexOf('-l') + 1] : '';
        const items = [...this.jobs.values()].filter(
          (job) => job.namespace === namespace && (!selector || matchesSelector(job.labels, selector)),
        );
        return JSON.stringify({ kind: 'JobList', items: items.map(jobJson) });
      }
      const job = this.jobs.get(`${namespace}/${args[2]}`);
      if (!job) throw new Error(`jobs.batch "${args[2]}" not found (NotFound)`);
      return JSON.stringify(jobJson(job));
    }
    throw new Error(`fake kube does not interpret get ${target}`);
  }

  private handleLabel(args: string[]): string {
    const name = args[2];
    const ns = this.namespaces.get(name);
    if (!ns) throw new Error(`namespaces "${name}" not found (NotFound)`);
    const rvArg = args.find((a) => a.startsWith('--resource-version='));
    if (rvArg && this.#conflictNextCas) {
      this.#conflictNextCas = false;
      throw new Error(`Operation cannot be fulfilled on namespaces "${name}": the object has been modified`);
    }
    if (rvArg && rvArg.split('=')[1] !== String(ns.resourceVersion)) {
      throw new Error(`Operation cannot be fulfilled on namespaces "${name}": the object has been modified`);
    }
    for (const arg of args.slice(3)) {
      if (arg.startsWith('--')) continue;
      if (arg.endsWith('-') && !arg.includes('=')) delete ns.labels[arg.slice(0, -1)];
      else {
        const eq = arg.indexOf('=');
        ns.labels[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
    }
    ns.resourceVersion = this.#rv++;
    return `namespace/${name} labeled`;
  }

  private handleAnnotate(args: string[]): string {
    const name = args[2];
    const ns = this.namespaces.get(name);
    if (!ns) throw new Error(`namespaces "${name}" not found (NotFound)`);
    for (const arg of args.slice(3)) {
      if (arg.startsWith('--')) continue;
      const eq = arg.indexOf('=');
      ns.annotations[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    ns.resourceVersion = this.#rv++;
    return `namespace/${name} annotated`;
  }

  private consumeInjectedFailure(): void {
    if (this.#failNext) {
      const message = this.#failNext;
      this.#failNext = null;
      throw new Error(message);
    }
  }

  private emit(namespace: string, type: 'ADDED' | 'MODIFIED' | 'DELETED'): void {
    const pod = this.pods.get(namespace);
    for (const watch of [...this.#watches]) {
      if (watch.namespace !== namespace || watch.proc.killed) continue;
      watch.proc.emitStdout(watchEventJson(type, pod ?? { namespace, uid: 'gone', phase: 'Failed', ready: false }));
    }
  }

  private mustPod(namespace: string): FakePod {
    const pod = this.pods.get(namespace);
    if (!pod) throw new Error(`fake kube has no vcluster pod in ${namespace}`);
    return pod;
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const found = args.find((a) => a.startsWith(`${flag}=`));
  return found?.slice(flag.length + 1);
}

function matchesSelector(labels: Record<string, string>, selector: string): boolean {
  return selector.split(',').every((term) => {
    if (term.startsWith('!')) return !(term.slice(1) in labels);
    const eq = term.indexOf('=');
    if (eq < 0) return term in labels; // bare key = existence
    return labels[term.slice(0, eq)] === term.slice(eq + 1);
  });
}

function jobJson(job: {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  status: { succeeded?: number; failed?: number };
  creationTimestamp: string;
}): object {
  return {
    kind: 'Job',
    metadata: {
      name: job.name,
      namespace: job.namespace,
      labels: { ...job.labels },
      creationTimestamp: job.creationTimestamp,
    },
    status: { ...job.status },
  };
}

function namespaceJson(ns: FakeNamespace): object {
  return {
    kind: 'Namespace',
    metadata: {
      name: ns.name,
      labels: { ...ns.labels },
      annotations: { ...ns.annotations },
      resourceVersion: String(ns.resourceVersion),
      creationTimestamp: ns.creationTimestamp,
      ...(ns.terminating ? { deletionTimestamp: '2026-01-01T00:00:00Z' } : {}),
    },
  };
}

function podJson(pod: FakePod): object {
  return {
    kind: 'Pod',
    metadata: { name: 'vc-0', namespace: pod.namespace, uid: pod.uid, labels: { app: 'vcluster' } },
    status: {
      phase: pod.phase,
      conditions: [{ type: 'Ready', status: pod.ready ? 'True' : 'False' }],
    },
  };
}

function watchEventJson(type: string, pod: FakePod): string {
  return JSON.stringify({ type, object: podJson(pod) }, null, 2);
}

/** Content-shaped like the syncer's export; never a real credential. */
function kubeconfigFor(namespace: string): string {
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- cluster:',
    `    server: https://vc.${namespace}.svc:443`,
    '  name: vc',
  ].join('\n');
}

function queueEmit(proc: FakeSupervisedProcess, chunk: string): void {
  // The initial state event arrives asynchronously in the real world; matching
  // that keeps handle construction free of re-entrant event delivery.
  queueMicrotask(() => {
    if (!proc.killed) proc.emitStdout(chunk);
  });
}
