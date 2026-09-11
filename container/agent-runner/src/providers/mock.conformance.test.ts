// Conformance for the test-double provider's runtime contract. The mock
// provider and its contract are test-only and sit outside both production
// barrels, so this file imports the pair directly — the same two-step
// registration a skill wires through the barrels for a real provider.
import './mock.js';
import { mockRuntimeContract } from '../provider-contracts/mock.js';
import { defineProviderConformance } from '../provider-contracts/testing/conformance.js';

defineProviderConformance('mock', mockRuntimeContract);
