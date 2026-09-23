import type { ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';
import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';
import type { AgentQuery, ProviderOptions, QueryInput } from './types.js';

const WEB_TOOL_INSTRUCTIONS =
  'For public web content use `mcp__nanoclaw__ollama_web_search` to find URLs and `mcp__nanoclaw__ollama_web_fetch` to read them. ' +
  'Use agent-browser only for clicks, typing, sign-in state, or screenshots.';
const APPROVAL_INSTRUCTIONS =
  'If `ncl` returns `approval-pending`, say so in one line and end the turn; the host sends the result.';
const AGENT_MESSAGING_INSTRUCTIONS =
  'Agent messages do not run in the background: do the requested work in this turn before replying. ' +
  "Send the result to the agent named in `from`; `user` is only the human's own conversation.";
const THINK_HEADER = 'X-Ollama-Think: false';

/**
 * What this provider appends to core's instructions on every turn. Core states
 * each of these once; the local models Ollama serves were observed acting on
 * none of them, and each miss costs a turn — the runtime alias reported as the
 * model, an `approval-pending` line treated as the answer, and a parent
 * agent's task answered to `user`.
 */
export function ollamaStandingInstructions(options: ProviderOptions): string {
  return [
    options.model === undefined
      ? undefined
      : `You are running through the local Ollama client with source model ${JSON.stringify(options.model)}. Report this source model, never the internal nanoclaw/* runtime alias.`,
    AGENT_MESSAGING_INSTRUCTIONS,
    APPROVAL_INSTRUCTIONS,
    options.env?.NANOCLAW_OLLAMA_WEB_BROWSING === 'enabled' ? WEB_TOOL_INSTRUCTIONS : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The contract's `thinking: disabled` is what Claude Code honors locally; this
 * header is what reaches the daemon, since the CLI does not carry `thinking` to
 * a custom base URL. Both stay until it does.
 */
function withThinkHeader(env: ProviderOptions['env']): ProviderOptions['env'] {
  const existing = env?.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return { ...env, ANTHROPIC_CUSTOM_HEADERS: existing ? `${existing}\n${THINK_HEADER}` : THINK_HEADER };
}

class OllamaProvider extends ClaudeProvider {
  private readonly standingInstructions: string;

  /**
   * `configuration` is the Ollama runtime contract as core resolved it
   * (provider-contracts/ollama.ts): Claude's execution policy without the
   * Anthropic server tools, Claude's inference routed to the launch alias with
   * reasoning off unless an effort is set, and Claude's MCP wiring.
   */
  constructor(options: ProviderOptions, configuration: ResolvedRuntimeConfiguration) {
    super(
      { ...options, env: options.effort === undefined ? withThinkHeader(options.env) : options.env },
      configuration,
    );
    this.standingInstructions = ollamaStandingInstructions(options);
  }

  override query(input: QueryInput): AgentQuery {
    const instructions = [input.systemContext?.instructions, this.standingInstructions].filter(Boolean).join('\n\n');
    return super.query({ ...input, systemContext: { ...input.systemContext, instructions } });
  }
}

// Function-form registration; the runtime contract attaches itself from
// provider-contracts/ollama.ts through the same two-step path Claude uses.
registerProvider('ollama', (options, configuration) => {
  if (!configuration) {
    throw new Error('Ollama provider requires its runtime contract; construct it through createProvider');
  }
  return new OllamaProvider(options, configuration);
});
