import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory, getProviderRuntimeContract, getProviderWrappers } from './provider-registry.js';
import {
  bindProviderRuntimeInputs,
  resolveRuntimeConfiguration,
  runProviderAfterExchange,
  runProviderBeforeQuery,
} from '../provider-contracts/realize.js';
import type { RuntimeConfigurationInputs } from '../provider-contracts/registry.js';

export function createProvider(name: string, options: ProviderOptions = {}): AgentProvider {
  const contract = getProviderRuntimeContract(name);
  // The core-owned inputs for this instance: one object, owned here, closed
  // over by the render path below.
  const inputs = runtimeInputs(options);
  // Core resolves the declared configuration and hands the result to the
  // provider; the provider does not call its own capabilities.
  const build = (opts: ProviderOptions, optsInputs = runtimeInputs(opts)): AgentProvider =>
    getProviderFactory(name)(opts, contract ? resolveRuntimeConfiguration(contract, optsInputs) : undefined);
  // Wrappers see the bare provider; the contract hooks below attach to what
  // the runner actually holds, so they run once per query and exchange.
  const provider = getProviderWrappers(name).reduce(
    (inner, wrap) => wrap(inner, { name, options, create: (opts) => build(opts) }),
    build(options, inputs),
  );
  if (contract) {
    bindProviderRuntimeInputs(provider, inputs);

    if (contract.lifecycle?.beforeQuery) {
      const query = provider.query.bind(provider);
      provider.query = (input) => {
        runProviderBeforeQuery(name, inputs);
        return query(input);
      };
    }

    if (contract.history?.afterExchange) {
      provider.onExchangeComplete = (exchange) => {
        runProviderAfterExchange(name, exchange);
      };
    }
  }
  return provider;
}

function runtimeInputs(options: ProviderOptions): Partial<RuntimeConfigurationInputs> {
  return {
    inference: { model: options.model, effort: options.effort, speed: options.speed },
    mcpServers: options.mcpServers ?? {},
  };
}
