import './index.js';
import { opencodeRuntimeContract } from '../provider-contracts/opencode.js';
import { defineProviderConformance } from '../provider-contracts/testing/conformance.js';

defineProviderConformance('opencode', opencodeRuntimeContract);
