import { describe, expect, it } from 'bun:test';

import { buildClaudeToolPolicy } from './claude.js';

describe('Claude MCP tool policy', () => {
  it('removes every provider-native tool in MCP-only mode', () => {
    const policy = buildClaudeToolPolicy(
      {
        nanoclaw: { command: 'bun', enabledTools: ['schedule_task'] },
        nimble: { type: 'http', url: 'https://mcp.example.com/mcp', enabledTools: ['search', 'extract'] },
      },
      'mcp-only',
    );
    expect(policy.allowedTools).toEqual([
      'mcp__nanoclaw__schedule_task',
      'mcp__nimble__search',
      'mcp__nimble__extract',
    ]);
    expect(policy.allowedTools).not.toContain('Bash');
    expect(policy.allowedTools).not.toContain('WebFetch');
  });

  it('maps an allowlist to exact MCP tools and preserves the default wildcard', () => {
    const policy = buildClaudeToolPolicy({
      nimble: { type: 'http', url: 'https://mcp.example.com/mcp', enabledTools: ['search', 'extract'] },
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
    });

    expect(policy.allowedTools).toContain('mcp__nimble__search');
    expect(policy.allowedTools).toContain('mcp__nimble__extract');
    expect(policy.allowedTools).not.toContain('mcp__nimble__*');
    expect(policy.allowedTools).toContain('mcp__docs__*');
  });

  it('maps deny entries to exact MCP tools', () => {
    const policy = buildClaudeToolPolicy({
      nanoclaw: { command: 'bun', disabledTools: ['send_message', 'add_reaction'] },
    });

    expect(policy.disallowedTools).toContain('mcp__nanoclaw__send_message');
    expect(policy.disallowedTools).toContain('mcp__nanoclaw__add_reaction');
  });
});
