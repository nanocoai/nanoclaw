import { PI_PERMISSION_POLICY } from '../providers/pi.js';
import { registerProviderContract } from '../providers/provider-registry.js';
import type { ProviderRuntimeContract } from './registry.js';

// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

export const piRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    // pi runs inside the NanoClaw container with no interactive permission
    // surface: the container boundary is the permission boundary. Every
    // category pi knows today is allowed; there is no interactive question
    // tool to deny (pi has none).
    executionPolicy: { constant: PI_PERMISSION_POLICY },
  },
  // The provider delivers one complete final text per turn via the `result`
  // event; mid-turn updates ride `progress`/`activity` only.
  textDelivery: 'result',
  // MVP decision: pi's native slash commands are interactive-TUI semantics
  // (compaction, theme, model picker) that either no-op or hang a headless
  // container, so commands are XML-formatted like any other chat content.
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/pi.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract('pi', piRuntimeContract);
