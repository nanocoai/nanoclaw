import { describe, it, expect } from 'bun:test';

import { assistantTextFromContent } from './assistant-text.js';

describe('assistantTextFromContent', () => {
  it('concatenates text blocks and ignores tool_use', () => {
    const content = [
      { type: 'text', text: '<message to="x">hi</message>' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: ' and more' },
    ];
    expect(assistantTextFromContent(content)).toBe('<message to="x">hi</message> and more');
  });

  it('returns empty string for non-array or text-less content', () => {
    expect(assistantTextFromContent(undefined)).toBe('');
    expect(assistantTextFromContent(null)).toBe('');
    expect(assistantTextFromContent('a string')).toBe('');
    expect(assistantTextFromContent([{ type: 'tool_use', name: 'Bash' }])).toBe('');
    expect(assistantTextFromContent([])).toBe('');
  });
});
