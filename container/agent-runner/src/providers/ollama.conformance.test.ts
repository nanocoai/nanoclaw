// Conformance for the Ollama runtime contract, run through core's reusable
// suite. The default probes apply: the inference resolve answers `model`, and
// the MCP resolve answers the server map.
import './index.js';
import { ollamaRuntimeContract } from '../provider-contracts/ollama.js';
import { defineProviderConformance } from '../provider-contracts/testing/conformance.js';

defineProviderConformance('ollama', ollamaRuntimeContract);
