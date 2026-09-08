import { registerProviderContract } from '../providers/provider-registry.js';
import { resolveOpenCodeExecutionPolicy, resolveOpenCodeInference } from '../providers/opencode-config.js';
import { mcpServersToOpenCodeConfig } from '../providers/mcp-to-opencode.js';
import { PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION, type ProviderRuntimeContract } from './registry.js';

export const opencodeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    executionPolicy: { constant: resolveOpenCodeExecutionPolicy() },
    inference: resolveOpenCodeInference,
    memory: (hook) => ({ ...hook }),
    mcpServers: (servers) => mcpServersToOpenCodeConfig(servers),
  },
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};
registerProviderContract('opencode', opencodeRuntimeContract);
