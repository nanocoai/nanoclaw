/**
 * Mock dev-env driver — the seam's reference realization.
 *
 * Everything host-visible is exercised for real: idempotent claims, the
 * async-pending path (D18), adoption from labels alone, full-teardown release,
 * residue reaping, the failure taxonomy. Only the runtime is simulated.
 *
 * `MockDevEnvRuntime` stands where the docker daemon or the k8s apiserver
 * stands for a real driver: it is the thing that SURVIVES a host restart while
 * driver objects do not. Tests simulate a restart by constructing a fresh
 * driver over the same runtime — which is exactly what re-adoption is, so the
 * conformance suite needs no special hooks to prove it.
 */
import { BUILTIN_STAMPS } from './stamps.js';
import {
  DEV_ENV_LABELS,
  asDevEnvFailureError,
  devEnvLabels,
  stampUnknown,
  type DevEnvDriver,
  type DevEnvDriverCapabilities,
  type DevEnvFailure,
  type DevEnvInstanceHandle,
  type DriverClaimSpec,
  type EnvKey,
  type ExposureTargetResolution,
  type InstanceStatus,
} from './types.js';

interface MockInstanceState {
  name: string;
  labels: Record<string, string>;
  /** What the claim asked for — the observable that keeps options pass-through testable. */
  options: Record<string, string>;
  /** What adoption's resume re-presented — set only by resumeClaim, so the host is SEEN to pass the original claim. */
  resumedOptions?: Record<string, string>;
  /** Same idea for the materials scope: the mock mints nothing, but the host must be seen to pass it. */
  materialsScope?: string;
  /** And for claimant placement (D19): the mock reaches nothing, but the host must be seen to say who — and where, when there is a where. */
  claimantNamespace?: string;
  claimantSelector?: Record<string, string>;
  phase: 'provisioning' | 'ready' | 'failed';
  endpoints: Record<string, string>;
  access: Record<string, string>;
  failure?: DevEnvFailure;
}

type Transition = { kind: 'ready' } | { kind: 'died'; failure?: DevEnvFailure };

/**
 * The simulated runtime. Mutations that a real runtime would perform on its
 * own — an instance finishing its boot, an instance crashing — are methods
 * here, so a test drives them explicitly and any driver constructed over this
 * runtime (including one "restarted" mid-claim) observes them.
 */
export class MockDevEnvRuntime {
  readonly instances = new Map<string, MockInstanceState>();
  /**
   * What each instance SERVES — the C14 exposure target, as the runtime knows
   * it. Held here rather than on the instance so a test can delete and
   * recreate a service under a live env (the live-drift story: same name, new
   * address) exactly as an agent would inside its child.
   */
  readonly services = new Map<string, ExposureTargetResolution[]>();
  private listeners = new Set<(name: string, event: Transition) => void>();

  /** Publish (or re-publish, at a new address) one service inside an instance. */
  publishService(name: string, target: ExposureTargetResolution): void {
    const published = (this.services.get(name) ?? []).filter((entry) => entry.service !== target.service);
    published.push(target);
    this.services.set(name, published);
  }

  /** The agent deleting a service inside its child — the exposure must MISS, never dial a memory. */
  dropService(name: string, service: string): void {
    this.services.set(name, (this.services.get(name) ?? []).filter((entry) => entry.service !== service));
  }

  /** Finish a provisioning instance's boot. */
  complete(name: string): void {
    const instance = this.mustGet(name);
    instance.phase = 'ready';
    instance.endpoints = { app: `http://${name}.mock.local` };
    this.emit(name, { kind: 'ready' });
  }

  /** Fail a provisioning instance. The dead runtime object stays as residue. */
  failProvisioning(name: string, failure: DevEnvFailure): void {
    const instance = this.mustGet(name);
    instance.phase = 'failed';
    instance.failure = failure;
    this.emit(name, { kind: 'died', failure });
  }

  /** Crash a live instance — the end the host did not request. */
  kill(name: string): void {
    this.mustGet(name);
    this.instances.delete(name);
    this.services.delete(name);
    this.emit(name, { kind: 'died', failure: { kind: 'instance-died', retryable: false } });
  }

  /**
   * Simulate host death: a dead host's handles must stop observing. Without
   * this a "restarted" test host races its own ghost — the old service's
   * subscriptions would settle transitions first against the shared registry.
   */
  severListeners(): void {
    this.listeners.clear();
  }

  onTransition(cb: (name: string, event: Transition) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(name: string, event: Transition): void {
    for (const listener of [...this.listeners]) listener(name, event);
  }

  private mustGet(name: string): MockInstanceState {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`mock runtime has no instance ${name}`);
    return instance;
  }
}

export interface MockDevEnvDriverConfig {
  installScope: string;
  runtime: MockDevEnvRuntime;
  /**
   * The stamps this "deployment" knows. An unknown stamp is a claim-time
   * refusal. Defaults to the built-in stamp table — the mock realizes nothing
   * a stamp deploys, but it must not refuse a stamp id every real driver
   * accepts.
   */
  knownStamps?: string[];
  /**
   * When true, claims stay `provisioning` until the test calls
   * `runtime.complete(name)` — the D18 async path. When false, claims return
   * ready, which is what a warm-pool hit looks like from above the seam.
   */
  manualCompletion?: boolean;
  /**
   * Test knob: every claim awaits this before touching the runtime — the
   * in-flight window every real driver has (network I/O) that the mock's
   * microtask-fast claim otherwise closes. Lets suites interleave a release
   * with a claim still on the wire.
   */
  claimGate?: () => Promise<void>;
  /**
   * Whether handles implement the optional C14 target capability. False is
   * how a suite proves the OTHER honest answer: a driver that cannot say what
   * serves a port refuses the grant, rather than minting a URL nothing carries.
   */
  resolvesExposureTargets?: boolean;
}

export class MockDevEnvDriver implements DevEnvDriver {
  readonly kind = 'mock';
  private nextClaimFailure: DevEnvFailure | null = null;

  constructor(private config: MockDevEnvDriverConfig) {}

  capabilities(): DevEnvDriverCapabilities {
    // Honest on both placement flags (C15): the mock realizes nothing a
    // placement would put anywhere — suites that need a placing driver bring
    // their own fake with placeImage/probeImage.
    return { isolation: 'none', sealedEgress: false, imagePull: false, imageBuild: false };
  }

  /** Make the next claim fail with the given taxonomy shape, FakeCli-style. */
  failNextClaim(failure: DevEnvFailure): void {
    this.nextClaimFailure = failure;
  }

  knownStamps(): string[] {
    return this.config.knownStamps ?? Object.keys(BUILTIN_STAMPS);
  }

  async claim(spec: DriverClaimSpec): Promise<DevEnvInstanceHandle> {
    if (this.config.claimGate) await this.config.claimGate();
    const name = instanceName(spec.key);
    // Idempotent on key: an existing live instance IS the claim, so a caller's
    // replay is never a duplicate.
    const existing = this.config.runtime.instances.get(name);
    if (existing) return this.handleFor(existing);

    if (this.nextClaimFailure) {
      const failure = this.nextClaimFailure;
      this.nextClaimFailure = null;
      throw asDevEnvFailureError(failure);
    }
    if (!this.knownStamps().includes(spec.stampId)) {
      throw stampUnknown(`no stamp '${spec.stampId}' in this deployment`);
    }

    const instance: MockInstanceState = {
      name,
      labels: { ...spec.labels },
      options: { ...spec.options },
      materialsScope: spec.materialsScope,
      claimantNamespace: spec.claimantNamespace,
      claimantSelector: spec.claimantSelector,
      phase: 'provisioning',
      endpoints: {},
      access: {},
    };
    this.config.runtime.instances.set(name, instance);
    if (!this.config.manualCompletion) {
      instance.phase = 'ready';
      instance.endpoints = { app: `http://${name}.mock.local` };
    }
    return this.handleFor(instance);
  }

  async resumeClaim(spec: DriverClaimSpec): Promise<void> {
    // The mock allocates nothing outside its instances, so there is nothing to
    // converge — the call is recorded for the same reason `options` is: the
    // host must be SEEN to re-present the ORIGINAL claim on the resume path,
    // never a reconstruction. A vanished instance records nothing (contract:
    // resume never allocates).
    const instance = this.config.runtime.instances.get(instanceName(spec.key));
    if (instance) instance.resumedOptions = { ...spec.options };
  }

  async listInstances(installScope: string): Promise<DevEnvInstanceHandle[]> {
    // Adoption contract: handles rebuilt from runtime-visible labels alone.
    return [...this.config.runtime.instances.values()]
      .filter((i) => i.labels[DEV_ENV_LABELS.install] === installScope)
      .map((i) => this.handleFor(i));
  }

  async reapResidue(installScope: string): Promise<void> {
    for (const [name, instance] of this.config.runtime.instances) {
      if (instance.labels[DEV_ENV_LABELS.install] === installScope && instance.phase === 'failed') {
        this.config.runtime.instances.delete(name);
      }
    }
  }

  private handleFor(instance: MockInstanceState): DevEnvInstanceHandle {
    const { runtime } = this.config;
    const name = instance.name;
    const key: EnvKey = {
      envId: instance.labels[DEV_ENV_LABELS.env],
      instanceId: instance.labels[DEV_ENV_LABELS.instance],
    };
    const stampId = instance.labels[DEV_ENV_LABELS.stamp];
    let releaseRequested = false;

    const once = (matches: (event: Transition) => boolean, cb: (event: Transition) => void): void => {
      const unsubscribe = runtime.onTransition((forName, event) => {
        if (forName !== name || !matches(event)) return;
        unsubscribe();
        cb(event);
      });
    };

    return {
      key,
      stampId,
      name,
      async status(): Promise<InstanceStatus> {
        const current = runtime.instances.get(name);
        if (!current) {
          if (releaseRequested) return { phase: 'released' };
          return { phase: 'failed', failure: { kind: 'instance-died', retryable: false } };
        }
        if (current.phase === 'failed') return { phase: 'failed', failure: current.failure! };
        if (current.phase === 'provisioning') return { phase: 'provisioning' };
        return { phase: 'ready', endpoints: current.endpoints, access: current.access };
      },
      async release(): Promise<void> {
        releaseRequested = true;
        // Full teardown = delete the scope (D10). Idempotent: the reaper and an
        // explicit release will race, and both must win. What the instance
        // served goes with it — so a target resolved after teardown MISSES.
        runtime.instances.delete(name);
        runtime.services.delete(name);
      },
      onReady(cb): void {
        once(
          (e) => e.kind === 'ready',
          () => cb(),
        );
      },
      onTerminal(cb): void {
        once(
          (e) => e.kind === 'died',
          (e) => {
            if (!releaseRequested) cb(e.kind === 'died' ? e.failure : undefined);
          },
        );
      },
      ...(this.config.resolvesExposureTargets === false
        ? {}
        : {
            async resolveExposureTarget(request: {
              service?: string;
              port: number;
            }): Promise<ExposureTargetResolution | null> {
              // Resolved from the runtime EVERY time, like a real driver's
              // read: an address published a moment ago may already mean
              // something else. Ambiguity throws at grant; a miss is null.
              const candidates = (runtime.services.get(name) ?? []).filter(
                (entry) =>
                  entry.port === request.port && (request.service === undefined || entry.service === request.service),
              );
              if (candidates.length > 1) {
                throw new Error(
                  `${candidates.length} services serve port ${request.port} in this env ` +
                    `(${candidates.map((entry) => entry.service).join(', ')}) — name the one to expose with --service`,
                );
              }
              return candidates[0] ?? null;
            },
          }),
      setMaterialsScope(scope: string): void {
        // The mock mints nothing, so this changes no behavior — it is recorded
        // for the same reason `options` is: the host must be SEEN to name the
        // owner on the adoption path, not just on the claim path.
        const current = runtime.instances.get(name);
        if (current) current.materialsScope = scope;
      },
    };
  }
}

export function instanceName(key: EnvKey): string {
  return `denv-${key.instanceId}`;
}

export function mockDriver(config: MockDevEnvDriverConfig): MockDevEnvDriver {
  return new MockDevEnvDriver(config);
}

// Re-exported so a harness can compose labels the way the service does.
export { devEnvLabels };
