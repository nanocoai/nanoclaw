import { mcpServersToOpenCodeConfig } from '../providers/mcp-to-opencode.js';
import { OPENCODE_PERMISSION_POLICY } from '../providers/opencode.js';
import { registerProviderContract } from '../providers/provider-registry.js';
import type { ProviderRuntimeContract } from './registry.js';

// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

export const opencodeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    executionPolicy: { constant: OPENCODE_PERMISSION_POLICY },
    mcpServers: mcpServersToOpenCodeConfig,
  },
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/opencode.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract('opencode', opencodeRuntimeContract);
