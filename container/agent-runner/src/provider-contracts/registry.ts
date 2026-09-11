/**
 * Container-runtime provider contracts.
 *
 * A contract is an implementation object, not a description: every declared
 * capability carries the function that implements it, and core calls those
 * functions at the declared moments.
 *
 * Registration itself is a map write. The optional shape checks and behavioral
 * probes live in verifier code, not in the startup registry path.
 */

import type { McpServerConfig, ProviderExchange, ProviderSpeed } from '../providers/types.js';

export const PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION = 1;

/** Shared shape of the memory session-hook registration (structural mirror of memory/session-hook.ts). */
export interface RuntimeMemoryHookInput {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * The core-owned inference input every provider's inference capability
 * receives. Core fills it from the group's container config; a provider maps
 * the fields onto its own SDK options and owns the defaults for any it omits.
 */
export interface RuntimeInferenceInput {
  model?: string;
  effort?: string;
  speed?: ProviderSpeed;
}

/**
 * Core-owned inputs for each configuration capability that has one.
 * `executionPolicy` is absent by design: it is a stance, not a function of
 * anything core varies, so its input is `void`.
 */
export interface RuntimeConfigurationInputs {
  inference: RuntimeInferenceInput;
  memory: RuntimeMemoryHookInput;
  mcpServers: Record<string, McpServerConfig>;
}

/** One shape for every configuration answer: derived from the core-owned input, or a declared constant. */
export type Capability<I> = ((input: I, environment: NodeJS.ProcessEnv) => unknown) | { constant: unknown };

export interface ProviderRuntimeConfiguration {
  /** The provider's sandbox/permission stance. Mandatory: it is a fact every provider has. */
  executionPolicy: Capability<void>;
  inference?: Capability<RuntimeConfigurationInputs['inference']>;
  memory?: Capability<RuntimeConfigurationInputs['memory']>;
  mcpServers?: Capability<RuntimeConfigurationInputs['mcpServers']>;
}

/**
 * What core hands a provider after resolving its declared configuration:
 * core calls each function capability with its input (or takes the declared
 * constant) at construction time and passes the results to the provider
 * factory. The fields are `unknown` here because their shape is
 * provider-private — the provider casts each one to its own return type.
 * `memory` is absent: it is resolved later, when core registers the memory
 * session hook, and handed to `registerMemorySessionHook` as its second
 * argument.
 */
export interface ResolvedRuntimeConfiguration {
  executionPolicy: unknown;
  inference?: unknown;
  mcpServers?: unknown;
}

export interface RuntimeLifecycleCallbacks {
  /** Provider-owned setup after core registers the shared memory hook. */
  memorySessionHookRegistration?(hook: RuntimeMemoryHookInput): void;
  /** Provider-owned setup immediately before starting a query. */
  beforeQuery?(inputs: Partial<RuntimeConfigurationInputs>, context: unknown): void;
}

/**
 * Effects a provider callback is handed instead of reaching for them. Tests
 * pass a fake clock; production passes the real one.
 */
export interface RuntimeCallbackEffects {
  now(): number;
}

export interface RuntimeAfterExchangeInput {
  exchange: ProviderExchange;
}

export interface RuntimeHistoryCallbacks {
  /** Provider-owned work after core observes a completed exchange. */
  afterExchange?(input: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null;
  /** Provider-owned trace lookup for diagnostics (`/upload-trace`). */
  readTrace?(): string | null;
}

export interface ProviderRuntimeContract {
  seamVersion: number;
  /** Provider-declared configuration surfaces. */
  configuration: ProviderRuntimeConfiguration;
  /** Provider-owned lifecycle effects. */
  lifecycle?: RuntimeLifecycleCallbacks;
  /** Provider-owned history hooks; core only decides when to invoke them. */
  history?: RuntimeHistoryCallbacks;
  textDelivery: 'mid-turn-complete' | 'result';
  commands: {
    formatting: 'native' | 'xml';
    nativeAdmin?: readonly string[];
    nativeFiltered?: readonly string[];
  };
}
