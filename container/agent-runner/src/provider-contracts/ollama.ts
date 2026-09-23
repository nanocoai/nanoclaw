import {
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  TOOL_ALLOWLIST,
} from '../providers/claude-config.js';
import type { ClaudeExecutionPolicy, ClaudeInference } from '../providers/claude.js';
import { registerProviderContract } from '../providers/provider-registry.js';
import type { McpServerConfig } from '../providers/types.js';

import { claudeRuntimeContract } from './claude.js';
import type { ProviderRuntimeContract, RuntimeInferenceInput } from './registry.js';

const provider = 'ollama';
// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

// The Ollama adapters (mcp-tools/ollama-web.ts) are ordinary mcp__nanoclaw__*
// tools. Removing and disallowing the built-ins keeps Anthropic server_tool_use
// from bypassing that direct local-daemon path.
const ANTHROPIC_SERVER_TOOLS = ['WebSearch', 'WebFetch'];

function resolveOllamaExecutionPolicy(): ClaudeExecutionPolicy {
  const claude = resolveClaudeExecutionPolicy();
  return {
    ...claude,
    disallowedTools: [...claude.disallowedTools, ...ANTHROPIC_SERVER_TOOLS],
    tools: TOOL_ALLOWLIST.filter((tool) => !ANTHROPIC_SERVER_TOOLS.includes(tool)),
  };
}

/**
 * Claude's inference, pointed at the daemon. Exported for the unit test that
 * covers the alias fallback, which the live query path cannot reach.
 */
export function resolveOllamaInference(input: RuntimeInferenceInput, environment: NodeJS.ProcessEnv): ClaudeInference {
  const claude = resolveClaudeInference(input, environment);
  return {
    ...claude,
    // `ollama launch` wraps the source model in a nanoclaw/* alias; the daemon
    // serves the alias while the agent keeps naming the source model.
    model: environment.NANOCLAW_OLLAMA_RUNTIME_MODEL || input.model,
    // Skip Claude's advisory api.anthropic.com preflight so the blocked cloud
    // host cannot fail a provider-owned MCP call before it runs.
    settings: { ...claude.settings, skipWebFetchPreflight: true },
    // Claude Code treats any effort flag, including `low`, as an opt-in to
    // reasoning. Only an explicit effort turns it on, so the default is off.
    ...(input.effort === undefined ? { thinking: { type: 'disabled' as const } } : {}),
  };
}

function resolveOllamaMcpServers(
  input: Record<string, McpServerConfig>,
  environment: NodeJS.ProcessEnv,
): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const claude = resolveClaudeMcpServers(input, environment);
  return { ...claude, allowedTools: claude.allowedTools.filter((tool) => !ANTHROPIC_SERVER_TOOLS.includes(tool)) };
}

export const ollamaRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    executionPolicy: { constant: resolveOllamaExecutionPolicy() },
    inference: resolveOllamaInference,
    memory: claudeRuntimeContract.configuration.memory,
    mcpServers: resolveOllamaMcpServers,
  },
  // Same SDK, same settings.json hook file and on-disk transcript: the memory
  // hook write and the trace lookup are Claude's.
  lifecycle: claudeRuntimeContract.lifecycle,
  history: claudeRuntimeContract.history,
  // Result-only delivery, carried over from the pre-contract payload's
  // `emitsMidTurnText = false`: the mid-turn door stays closed for local models.
  textDelivery: 'result',
  commands: claudeRuntimeContract.commands,
};

// Two-step registration: providers/ollama.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract(provider, ollamaRuntimeContract);
