import {
  codexExecutionPolicySection,
  codexInferenceSection,
  codexMcpServersSection,
  codexMemorySection,
  codexRuntimeOwnership,
  type CodexMemorySessionHook,
  writeCodexConfigToml,
} from '../providers/codex-app-server.js';
import { archiveProviderExchange } from '../providers/exchange-archive.js';
import { registerProviderContract } from '../providers/provider-registry.js';

import {
  type ProviderRuntimeContract,
  type RuntimeAfterExchangeInput,
  type RuntimeCallbackEffects,
  type RuntimeConfigurationInputs,
} from './registry.js';

const provider = 'codex';
// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

// This module loading means core runs the contract's beforeQuery before every
// query, so the provider's own direct write must stand down — otherwise the
// files would be written twice per query.
codexRuntimeOwnership.contractOwnsRuntimeFiles = true;

export const codexRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    executionPolicy: { constant: codexExecutionPolicySection() },
    inference: codexInferenceSection,
    // Codex's native memory stays off whatever hook core registers, so the
    // section is a declared constant, not a function of the hook.
    memory: { constant: codexMemorySection() },
    mcpServers: codexMcpServersSection,
  },
  lifecycle: { beforeQuery: writeCodexRuntimeFiles },
  history: { afterExchange: archiveCodexExchange },
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/codex.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract(provider, codexRuntimeContract);

function writeCodexRuntimeFiles(inputs: Partial<RuntimeConfigurationInputs>): void {
  const hook = inputs.memory as CodexMemorySessionHook | undefined;
  if (!hook) throw new Error('Codex provider requires a registered memory hook before query');
  writeCodexConfigToml(inputs.mcpServers ?? {}, hook, codexInferenceSection(inputs.inference ?? {}));
}

function archiveCodexExchange({ exchange }: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null {
  return archiveProviderExchange({
    provider,
    prompt: exchange.prompt,
    result: exchange.result,
    continuation: exchange.continuation,
    status: exchange.status,
    timestamp: new Date(fx.now()),
  });
}
