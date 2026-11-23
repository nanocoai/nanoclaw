import { describe, expect, it } from 'vitest';

import { readVersionPin } from './version-pins.js';

describe('readVersionPin', () => {
  it('resolves an existing pin', () => {
    expect(readVersionPin('agent-image')).toContain('@sha256:');
  });

  it('throws for a component with no pin', () => {
    expect(() => readVersionPin('no-such-component')).toThrow(/no pin/);
  });
});
