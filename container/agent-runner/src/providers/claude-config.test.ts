import { describe, expect, it } from 'bun:test';

import { resolveClaudeInference } from './claude-config.js';

describe('resolveClaudeInference', () => {
  it('passes model and effort through verbatim with no settings by default', () => {
    const resolved = resolveClaudeInference({ model: 'opus', effort: 'high' }, {});
    expect(resolved).toEqual({ model: 'opus', effort: 'high' });
    expect(resolved.settings).toBeUndefined();
  });

  it("maps speed 'fast' to the SDK fastMode setting", () => {
    expect(resolveClaudeInference({ speed: 'fast' }, {}).settings).toEqual({ fastMode: true });
  });

  it("maps speed 'standard' to the SDK default", () => {
    expect(resolveClaudeInference({ speed: 'standard' }, {}).settings).toBeUndefined();
  });

  it('ignores unknown speed values instead of guessing', () => {
    expect(resolveClaudeInference({ speed: 'ultrafast' }, {}).settings).toBeUndefined();
  });
});
