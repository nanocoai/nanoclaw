import { describe, expect, it } from 'vitest';

import { defaultRuntimeProvider, parseAgentProviderChoice } from './agent-provider-choice.js';

describe('parseAgentProviderChoice', () => {
  it('accepts claude, codex, and both', () => {
    expect(parseAgentProviderChoice('claude')).toBe('claude');
    expect(parseAgentProviderChoice('CODEX')).toBe('codex');
    expect(parseAgentProviderChoice(' both ')).toBe('both');
  });

  it('rejects unknown values', () => {
    expect(parseAgentProviderChoice('openrouter')).toBeNull();
  });
});

describe('defaultRuntimeProvider', () => {
  it('uses codex as the setup test provider only when codex is the selected default', () => {
    expect(defaultRuntimeProvider('codex')).toBe('codex');
    expect(defaultRuntimeProvider('claude')).toBe('claude');
    expect(defaultRuntimeProvider('both')).toBe('claude');
  });
});
