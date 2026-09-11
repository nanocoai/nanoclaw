import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type Capability,
  type ProviderRuntimeContract,
  type RuntimeConfigurationInputs,
} from './registry.js';

const INPUT_CAPABILITY_NAMES = ['inference', 'memory', 'mcpServers'] as const;
type InputCapabilityName = (typeof INPUT_CAPABILITY_NAMES)[number];

/** Two inputs a function capability must answer differently, plus the environment it is probed under. */
export type ProbeFixture<K extends InputCapabilityName> = {
  a: RuntimeConfigurationInputs[K];
  b: RuntimeConfigurationInputs[K];
  environment?: NodeJS.ProcessEnv;
};

/** Per-capability probe fixtures; anything omitted falls back to the defaults below. */
export type ProbeFixtures = { [K in InputCapabilityName]?: ProbeFixture<K> };

/** Default probe fixtures for the input-sensitivity checks. */
const DEFAULT_PROBES: { [K in InputCapabilityName]: ProbeFixture<K> } = {
  inference: { a: { model: 'nanoclaw-probe-model-a' }, b: { model: 'nanoclaw-probe-model-b' } },
  memory: {
    a: { command: 'nanoclaw-probe-hook-a', legacyCommands: [], sources: ['startup'] },
    b: { command: 'nanoclaw-probe-hook-b', legacyCommands: [], sources: ['startup'] },
  },
  mcpServers: {
    a: {},
    b: { 'nanoclaw-probe-server': { command: 'nanoclaw-probe-command' } },
  },
};

/** Shape check for one contract. Run by tests and install-time verification, not startup. */
export function assertProviderRuntimeContractShape(name: string, contract: ProviderRuntimeContract): void {
  validateContract(providerKey(name), contract);
}

/**
 * Behavioral probes for one contract. Run by tests and install-time
 * verification, not startup. `probes` replaces the default fixtures for the
 * capabilities it names (e.g. when a resolve is env-gated and the defaults
 * cannot exercise it).
 */
export function probeProviderRuntimeConfiguration(
  name: string,
  contract: ProviderRuntimeContract,
  probes: ProbeFixtures = {},
): void {
  probeConfiguration(providerKey(name), contract, probes);
}

function validateContract(provider: string, contract: ProviderRuntimeContract): void {
  if (contract.seamVersion !== PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION) {
    throw new Error(
      `${provider}.seamVersion ${String(contract.seamVersion)} is incompatible with runtime seam ${PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION}; run /update-skills`,
    );
  }
  if (contract.configuration === null || typeof contract.configuration !== 'object') {
    throw new Error(`${provider}.configuration is required`);
  }
  const policyField = `${provider}.configuration.executionPolicy`;
  if (contract.configuration.executionPolicy === undefined) throw new Error(`${policyField} is required`);
  assertCapability(contract.configuration.executionPolicy, policyField);

  for (const capability of INPUT_CAPABILITY_NAMES) {
    const implementation = contract.configuration[capability];
    if (implementation === undefined) continue;
    assertCapability(implementation, `${provider}.configuration.${capability}`);
  }

  if (contract.lifecycle !== undefined) {
    if (contract.lifecycle === null || typeof contract.lifecycle !== 'object') {
      throw new Error(`${provider}.lifecycle must be an object`);
    }
    if (contract.lifecycle.memorySessionHookRegistration !== undefined) {
      requireFunction(
        contract.lifecycle.memorySessionHookRegistration,
        `${provider}.lifecycle.memorySessionHookRegistration`,
      );
    }
    if (contract.lifecycle.beforeQuery !== undefined) {
      requireFunction(contract.lifecycle.beforeQuery, `${provider}.lifecycle.beforeQuery`);
    }
  }

  if (contract.history !== undefined) {
    if (contract.history === null || typeof contract.history !== 'object') {
      throw new Error(`${provider}.history must be an object`);
    }
    if (contract.history.afterExchange !== undefined) {
      requireFunction(contract.history.afterExchange, `${provider}.history.afterExchange`);
    }
    if (contract.history.readTrace !== undefined) {
      requireFunction(contract.history.readTrace, `${provider}.history.readTrace`);
    }
  }

  assertAllowed(contract.textDelivery, ['mid-turn-complete', 'result'], `${provider}.textDelivery`);
  assertAllowed(contract.commands?.formatting, ['native', 'xml'], `${provider}.commands.formatting`);
  assertCommandArray(contract.commands?.nativeAdmin, `${provider}.commands.nativeAdmin`);
  assertCommandArray(contract.commands?.nativeFiltered, `${provider}.commands.nativeFiltered`);
  unique(contract.commands?.nativeAdmin ?? [], `${provider}.commands.nativeAdmin`);
  unique(contract.commands?.nativeFiltered ?? [], `${provider}.commands.nativeFiltered`);
}

/** A capability is a function of its input or a `{ constant }` — nothing else. */
function assertCapability(value: unknown, field: string): void {
  if (typeof value === 'function') return;
  if (value === null || typeof value !== 'object' || !('constant' in value)) {
    throw new Error(`${field} must be a function or { constant }`);
  }
  if ((value as { constant: unknown }).constant === undefined) {
    throw new Error(`${field}.constant must be a value`);
  }
}

function probeConfiguration(provider: string, contract: ProviderRuntimeContract, probes: ProbeFixtures): void {
  const policy = contract.configuration.executionPolicy;
  const policyField = `${provider}.configuration.executionPolicy`;
  if (typeof policy === 'function' && policy(undefined, {}) === undefined) {
    throw new Error(`${policyField} must produce a value`);
  }

  for (const capability of INPUT_CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability] as
      | Capability<RuntimeConfigurationInputs[typeof capability]>
      | undefined;
    // A declared constant has nothing to respond to; only functions are probed.
    if (implementation === undefined || typeof implementation !== 'function') continue;
    const fixture = (probes[capability] ?? DEFAULT_PROBES[capability]) as ProbeFixture<typeof capability>;
    const environment = fixture.environment ?? {};
    const resolvedA = implementation(fixture.a as never, environment);
    if (resolvedA === undefined) {
      throw new Error(`${field} must produce a value for the probe input`);
    }

    const resolvedB = implementation(fixture.b as never, environment);
    if (stableStringify(resolvedA) === stableStringify(resolvedB)) {
      throw new Error(`${field} does not respond to its configuration input`);
    }
  }
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider runtime contract name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function requireFunction(value: unknown, field: string): void {
  if (typeof value !== 'function') throw new Error(`${field} must be a function`);
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function unique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} must be unique; duplicate '${value}'`);
    seen.add(value);
  }
}

function assertCommandArray(value: unknown, field: string): asserts value is readonly string[] {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const command of value) {
    if (typeof command !== 'string' || !/^\/[a-z0-9-]+$/.test(command)) {
      throw new Error(`${field} contains invalid command '${String(command)}'`);
    }
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'function') return '[function]';
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return entry;
  });
}
