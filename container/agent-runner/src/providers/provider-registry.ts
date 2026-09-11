/**
 * Provider self-registration registry.
 *
 * Mirrors `src/channels/channel-registry.ts` on the host. Each provider module
 * calls `registerProvider()` at top level; the barrel (`providers/index.ts`)
 * imports every provider module for its side effect so registrations fire
 * before `createProvider()` is called.
 *
 * Registration is two-step and order-independent: the provider module
 * registers its factory (`registerProvider`), and the contract module
 * attaches the runtime contract (`registerProviderContract`). The two files
 * never import each other, so a payload's provider module still compiles on a
 * core that predates the contract seam — the contract file simply has nothing
 * to attach to there and is not imported. Every provider, Claude included,
 * goes through exactly this path.
 */
import type { AgentProvider, ProviderOptions } from './types.js';
import type { ProviderRuntimeContract, ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';

/**
 * Builds a provider instance. `configuration` is present whenever the provider
 * has a registered contract: core has already called the contract's
 * configuration resolves and hands the results over here.
 */
export type ProviderFactory = (options: ProviderOptions, configuration?: ResolvedRuntimeConfiguration) => AgentProvider;

export interface ProviderRegistration {
  create: ProviderFactory;
  contract?: ProviderRuntimeContract;
}

const registry = new Map<string, ProviderRegistration>();
/** Contracts registered before their provider factory arrived. */
const pendingContracts = new Map<string, ProviderRuntimeContract>();

export function registerProvider(name: string, registration: ProviderFactory | ProviderRegistration): void {
  const key = providerKey(name);
  if (registry.has(key)) {
    throw new Error(`Provider already registered: ${key}`);
  }
  const entry: ProviderRegistration =
    typeof registration === 'function' ? { create: registration } : { create: registration.create };
  registry.set(key, entry);

  const pending = pendingContracts.get(key);
  if (typeof registration !== 'function' && registration.contract) {
    if (pending) throw new Error(`Provider runtime contract already registered: ${key}`);
    attachContract(entry, registration.contract);
  } else if (pending) {
    pendingContracts.delete(key);
    attachContract(entry, pending);
  }
}

/**
 * Attach a runtime contract to a provider. Works before or after the
 * provider's own `registerProvider` call; a second contract for the same
 * provider is an error.
 */
export function registerProviderContract(name: string, contract: ProviderRuntimeContract): void {
  const key = providerKey(name);
  const entry = registry.get(key);
  if (entry) {
    if (entry.contract) throw new Error(`Provider runtime contract already registered: ${key}`);
    attachContract(entry, contract);
    return;
  }
  if (pendingContracts.has(key)) throw new Error(`Provider runtime contract already registered: ${key}`);
  pendingContracts.set(key, deepFreeze(contract));
}

function attachContract(entry: ProviderRegistration, contract: ProviderRuntimeContract): void {
  entry.contract = deepFreeze(contract);
}

export function getProviderFactory(name: string): ProviderFactory {
  const registration = registry.get(name);
  if (!registration) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown provider: ${name}. Registered: ${known}`);
  }
  return registration.create;
}

export function getProviderRuntimeContract(name: string | null | undefined): ProviderRuntimeContract | undefined {
  return name ? registry.get(name.toLowerCase())?.contract : undefined;
}

export function hasDeclaredProviderRuntimeContract(name: string | null | undefined): boolean {
  return getProviderRuntimeContract(name) !== undefined;
}

export function listProviderRuntimeContractNames(): string[] {
  return [...registry.entries()].filter(([, registration]) => registration.contract).map(([name]) => name);
}

/** Normalize and validate a provider selected from config before startup work begins. */
export function requireProviderName(name: string): string {
  const normalized = name.toLowerCase();
  getProviderFactory(normalized);
  return normalized;
}

export function listProviderNames(): string[] {
  return [...registry.keys()];
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
