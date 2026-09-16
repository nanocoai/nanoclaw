import { describe, expect, it } from 'bun:test';

import './ollama.js';
import { resolveOllamaInference } from '../provider-contracts/ollama.js';
import { ollamaStandingInstructions } from './ollama.js';
import { getProviderRuntimeContract } from './provider-registry.js';

describe('ollama standing instructions', () => {
  it('keeps the source model in the agent-facing prompt', () => {
    const instructions = ollamaStandingInstructions({ model: 'gemma4:12b-mlx' });

    expect(instructions).toContain('gemma4:12b-mlx');
    expect(instructions).toContain('never the internal nanoclaw/* runtime alias');
  });

  it('uses the launch alias only for the provider runtime', () => {
    expect(
      resolveOllamaInference({ model: 'gemma4:12b-mlx' }, { NANOCLAW_OLLAMA_RUNTIME_MODEL: 'nanoclaw/abc:latest' })
        .model,
    ).toBe('nanoclaw/abc:latest');
    expect(resolveOllamaInference({ model: 'gemma4:12b-mlx' }, {}).model).toBe('gemma4:12b-mlx');
  });

  it('names the direct retrieval tools only once browsing is enabled', () => {
    const browsing = ollamaStandingInstructions({ env: { NANOCLAW_OLLAMA_WEB_BROWSING: 'enabled' } });

    expect(browsing).toContain('mcp__nanoclaw__ollama_web_search');
    expect(browsing).toContain('mcp__nanoclaw__ollama_web_fetch');
    expect(browsing).toContain('agent-browser only for clicks');
    expect(ollamaStandingInstructions({})).not.toContain('mcp__nanoclaw__ollama_web_fetch');
  });

  it('ends an approval-pending turn until the host sends the real result', () => {
    const instructions = ollamaStandingInstructions({});

    expect(instructions).toContain('approval-pending');
    expect(instructions).toContain('end the turn');
    expect(instructions).toContain('the host sends the result');
  });

  it('tells local agents that acknowledgment alone does not continue a task', () => {
    expect(ollamaStandingInstructions({})).toContain('do the requested work in this turn');
    expect(ollamaStandingInstructions({})).toContain('do not run in the background');
  });

  it('addresses a task from another agent back to that agent, not to the human', () => {
    // A live run: a child agent read `<message from="parent" ...>` and answered
    // `<message to="user">`, so the parent never saw the result.
    const instructions = ollamaStandingInstructions({});

    expect(instructions).toContain('Send the result to the agent named in `from`');
    expect(instructions).toContain("`user` is only the human's own conversation");
  });

  it('uses result-only delivery for Ollama streams', () => {
    expect(getProviderRuntimeContract('ollama')?.textDelivery).toBe('result');
  });
});
