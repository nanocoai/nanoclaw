import {
  type Capability,
  type ProviderRuntimeContract,
  type ResolvedRuntimeConfiguration,
  type RuntimeCallbackEffects,
  type RuntimeConfigurationInputs,
} from './registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { getProviderRuntimeContract } from '../providers/provider-registry.js';
import type { AgentProvider, ProviderExchange } from '../providers/types.js';

/** The production clock handed to history callbacks; tests pass a fake. */
const REAL_CLOCK: RuntimeCallbackEffects = { now: () => Date.now() };

/**
 * The configuration inputs are one object per provider instance, created in
 * the factory from the construction options. The render path closes over that
 * object directly, so nothing is looked up while a file is being written.
 *
 * This map exists for exactly one caller: the memory-session-hook
 * registration, which reaches the seam after construction holding nothing but
 * the instance. That one cannot be a closure without changing what
 * `createProvider` returns, so it stays an explicit, single lookup.
 */
const providerInputs = new WeakMap<AgentProvider, Partial<RuntimeConfigurationInputs>>();

export function bindProviderRuntimeInputs(instance: AgentProvider, inputs: Partial<RuntimeConfigurationInputs>): void {
  providerInputs.set(instance, inputs);
}

/** The one way core reads a capability: call it with its input, or take the declared constant. */
function resolveCapability<I>(capability: Capability<I>, input: I, environment: NodeJS.ProcessEnv): unknown {
  return typeof capability === 'function' ? capability(input, environment) : capability.constant;
}

/**
 * Core resolves the contract's configuration capabilities and hands the
 * results to the provider — the provider never calls its own capabilities.
 * `memory` is not resolved here: its input is the memory session hook, which
 * core registers after construction (see registerProviderMemorySessionHook).
 */
export function resolveRuntimeConfiguration(
  contract: ProviderRuntimeContract,
  inputs: Partial<RuntimeConfigurationInputs>,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeConfiguration {
  const { executionPolicy, inference, mcpServers } = contract.configuration;
  return {
    executionPolicy: resolveCapability(executionPolicy, undefined, environment),
    inference: inference ? resolveCapability(inference, inputs.inference ?? {}, environment) : undefined,
    mcpServers: mcpServers ? resolveCapability(mcpServers, inputs.mcpServers ?? {}, environment) : undefined,
  };
}

export function runProviderBeforeQuery(
  provider: string,
  inputs: Partial<RuntimeConfigurationInputs>,
  context: unknown = undefined,
): void {
  getProviderRuntimeContract(provider)?.lifecycle?.beforeQuery?.(inputs, context);
}

export function registerProviderMemorySessionHook(
  providerName: string,
  provider: AgentProvider,
  hook: MemorySessionHookRegistration,
): void {
  const inputs = providerInputs.get(provider) ?? {};
  inputs.memory = hook;
  providerInputs.set(provider, inputs);
  const contract = getProviderRuntimeContract(providerName);
  contract?.lifecycle?.memorySessionHookRegistration?.(hook);
  // The memory capability's input is the hook itself, so it is resolved here
  // — the one moment core has it — and handed to the provider alongside.
  const memoryCapability = contract?.configuration.memory;
  const memory = memoryCapability ? resolveCapability(memoryCapability, hook, process.env) : undefined;
  provider.registerMemorySessionHook(hook, memory);
}

/** The active provider's newest trace, for `/upload-trace`. */
export function readProviderTrace(provider: string): string | null {
  return getProviderRuntimeContract(provider)?.history?.readTrace?.() ?? null;
}

export function runProviderAfterExchange(provider: string, exchange: ProviderExchange): string | null {
  return getProviderRuntimeContract(provider)?.history?.afterExchange?.({ exchange }, REAL_CLOCK) ?? null;
}
