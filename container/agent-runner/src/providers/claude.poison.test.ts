import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from './claude.js';

describe('ClaudeProvider.isPoisonedResume', () => {
  const provider = new ClaudeProvider();

  it('matches the thinking-block continuation-corruption 400', () => {
    const text =
      'API Error: 400 messages.9.content.16: `thinking` or `redacted_thinking` blocks in the ' +
      'latest assistant message cannot be modified. These blocks must remain as they were in ' +
      'the original response.';
    expect(provider.isPoisonedResume(text)).toBe(true);
  });

  it('matches the redacted_thinking variant regardless of message index', () => {
    const text =
      'API Error: 400 messages.13.content.3: `redacted_thinking` blocks in the latest assistant ' +
      'message cannot be modified.';
    expect(provider.isPoisonedResume(text)).toBe(true);
  });

  it('does not match benign agent output', () => {
    expect(provider.isPoisonedResume('<message to="x">all good</message>')).toBe(false);
  });

  it('does not match unrelated API errors', () => {
    expect(provider.isPoisonedResume('API Error: 429 rate_limit_error: overloaded')).toBe(false);
    expect(provider.isPoisonedResume('API Error: 400 invalid_request_error: image too large')).toBe(false);
  });
});
