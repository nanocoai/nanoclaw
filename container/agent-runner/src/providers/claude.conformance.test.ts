// Conformance for the Claude runtime contract. Every provider proves its
// contract from its own `providers/<name>.conformance.test.ts` — the probe
// fixtures a contract needs are provider knowledge, so core runs no generic
// sweep over registered contracts. Claude uses the default probes.
import './index.js';
import { claudeRuntimeContract } from '../provider-contracts/claude.js';
import { defineProviderConformance } from '../provider-contracts/testing/conformance.js';

defineProviderConformance('claude', claudeRuntimeContract);
