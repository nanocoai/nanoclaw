import './index.js';
import { copilotRuntimeContract } from '../provider-contracts/copilot.js';
import { defineProviderConformance } from '../provider-contracts/testing/conformance.js';

defineProviderConformance('copilot', copilotRuntimeContract);
