import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { OpenCodeProvider } from './opencode.js';

describe('createProvider (opencode)', () => {
  it('returns OpenCodeProvider for opencode', () => {
    expect(createProvider('opencode')).toBeInstanceOf(OpenCodeProvider);
  });
});
