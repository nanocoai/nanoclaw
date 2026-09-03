import {
  archiveCursorExchange,
  cursorExecutionPolicySection,
  cursorInferenceSection,
  cursorMcpServersSection,
  cursorMemorySection,
  cursorRuntimeOwnership,
  writeCursorMemoryHooks,
} from '../providers/cursor.js';
import { registerProviderContract } from '../providers/provider-registry.js';

import type { ProviderRuntimeContract, RuntimeAfterExchangeInput, RuntimeCallbackEffects } from './registry.js';

const provider = 'cursor';
// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

// This module loading means core runs the contract's
// memorySessionHookRegistration when it registers the memory hook, so the
// provider's own hooks.json write must stand down — otherwise both files
// would be written twice per session start.
cursorRuntimeOwnership.contractOwnsHookFiles = true;

const memory = cursorMemorySection();

export const cursorRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    // The stance is fixed — the container is the sandbox, Cursor's own is off,
    // and the tools that stall a headless session are always denied — so it is
    // declared as the constant it is.
    executionPolicy: { constant: cursorExecutionPolicySection() },
    // Only `model` reaches the SDK: Cursor's per-model `params` are catalogue
    // knowledge the container does not have, so `effort` and `speed` have no
    // honest mapping (see cursorInferenceSection). The default probes vary
    // `model`, which this function answers.
    inference: cursorInferenceSection,
    // The Cursor-native hooks run cursor-hook.ts, which reads the memory tree
    // itself rather than the hook command core registers, so the hooks
    // document is a constant, not a function of the hook.
    memory: { constant: memory },
    mcpServers: cursorMcpServersSection,
  },
  // Cursor discovers hooks from `.cursor/hooks.json` files, so the memory
  // registration writes them into the project and user layers.
  lifecycle: { memorySessionHookRegistration: () => writeCursorMemoryHooks(memory) },
  // The SDK's local agent store holds the history; there is no transcript to
  // read back, so each exchange is archived and there is no trace to upload.
  history: { afterExchange: archiveExchange },
  // Assistant text streams mid-turn from `run.stream()`, so complete message
  // blocks are delivered as they close, the way the Claude provider does.
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/cursor.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract(provider, cursorRuntimeContract);

function archiveExchange({ exchange }: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null {
  return archiveCursorExchange(exchange, new Date(fx.now()));
}
