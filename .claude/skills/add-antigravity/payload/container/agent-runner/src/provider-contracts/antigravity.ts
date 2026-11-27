import {
  type AntigravityMcpConfig,
  antigravityExecutionPolicySection,
  antigravityInferenceSection,
  antigravityMcpServersSection,
  antigravityMemorySection,
  antigravityRuntimeOwnership,
  writeAntigravityRuntimeFiles,
} from '../providers/antigravity-config.js';
import { registerProviderContract } from '../providers/provider-registry.js';

import { archiveProviderExchange } from './exchange-archive.js';
import type {
  ProviderRuntimeContract,
  RuntimeAfterExchangeInput,
  RuntimeCallbackEffects,
  RuntimeConfigurationInputs,
} from './registry.js';

const provider = 'antigravity';
// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

// This module loading means core runs the contract's beforeQuery before every
// query, so the provider's own direct write must stand down — otherwise the
// files would be written twice per query.
antigravityRuntimeOwnership.contractOwnsRuntimeFiles = true;

export const antigravityRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    // The stance is fixed — the container and the gateway's allow-list are the
    // boundary, agy's approval prompts are off — so it is a declared constant.
    executionPolicy: { constant: antigravityExecutionPolicySection() },
    // `model` and `effort` become agy flags; agy has no speed knob. The
    // default probes vary `model`, which this function answers.
    inference: antigravityInferenceSection,
    // agy runs no hooks in API-key mode, so the provider runs core's hook
    // command itself before each spawn: the section is the hook it will run.
    memory: antigravityMemorySection,
    mcpServers: antigravityMcpServersSection,
  },
  // settings.json and mcp_config.json depend only on core-owned inputs, so they
  // are written here. The always-on rule file needs the memory hook's output,
  // which the provider renders (asynchronously) right before each spawn; the
  // per-session instructions travel in-band in the first user line.
  lifecycle: { beforeQuery: writeRuntimeFiles },
  // agy keeps its history in its own conversation DB under ~/.gemini, which
  // NanoClaw cannot read back, so each exchange goes to core's shared archive
  // and there is no trace to upload.
  history: { afterExchange: archiveExchange },
  // agy reports a turn's reply in its `result` line; there are no mid-turn
  // assistant segments to deliver.
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/antigravity.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract(provider, antigravityRuntimeContract);

function writeRuntimeFiles(inputs: Partial<RuntimeConfigurationInputs>): void {
  const mcpConfig: AntigravityMcpConfig = antigravityMcpServersSection(inputs.mcpServers ?? {});
  writeAntigravityRuntimeFiles(mcpConfig);
}

function archiveExchange({ exchange }: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null {
  return archiveProviderExchange({
    provider,
    prompt: exchange.prompt,
    result: exchange.result,
    continuation: exchange.continuation,
    status: exchange.status,
    timestamp: new Date(fx.now()),
  });
}
