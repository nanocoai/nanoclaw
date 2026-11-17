import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('card-parts', () => {
  it('is the same file as the agent runner copy', () => {
    const host = readFileSync(new URL('./card-parts.ts', import.meta.url), 'utf8');
    const runner = readFileSync(
      new URL('../../container/agent-runner/src/mcp-tools/card-parts.ts', import.meta.url),
      'utf8',
    );
    expect(runner, 'edit both copies of card-parts.ts together').toBe(host);
  });
});
