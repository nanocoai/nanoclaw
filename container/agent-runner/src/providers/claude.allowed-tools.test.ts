import { describe, expect, it, mock } from 'bun:test';

const allowedToolsCalls: string[][] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { allowedTools: string[] } }) => {
    allowedToolsCalls.push(options.allowedTools);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');

describe('Claude allowed tools', () => {
  it('passes a fresh array to every SDK query', () => {
    allowedToolsCalls.length = 0;
    const provider = createProvider('claude', {
      mcpServers: { 'custom.server': { command: 'custom-server' } },
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    provider.query({ prompt: 'first', cwd: '/workspace/agent' });
    allowedToolsCalls[0]!.push('mutated-by-sdk');
    provider.query({ prompt: 'second', cwd: '/workspace/agent' });

    expect(allowedToolsCalls).toHaveLength(2);
    expect(allowedToolsCalls[1]).not.toBe(allowedToolsCalls[0]);
    expect(allowedToolsCalls[1]).not.toContain('mutated-by-sdk');
    expect(allowedToolsCalls[1]).toContain('mcp__custom_server__*');
  });
});
