import { describe, expect, it } from 'bun:test';

import { getProviderToolPolicy, registerProviderToolPolicy } from './tool-policy.js';

// Module-level singleton: the inert-on-pristine assertion must run FIRST.
describe('provider tool-policy registry', () => {
  it('is null on pristine core — no registrant ⇒ the provider uses its built-in defaults', () => {
    expect(getProviderToolPolicy()).toBeNull();
  });

  it('returns the registered policy; a later registration overwrites', () => {
    registerProviderToolPolicy({ extraDenied: ['Bash', 'Read'] });
    expect(getProviderToolPolicy()?.extraDenied).toEqual(['Bash', 'Read']);

    registerProviderToolPolicy({ settingSources: [], allowTool: (t) => t !== 'WebSearch' });
    const p = getProviderToolPolicy();
    expect(p?.settingSources).toEqual([]);
    expect(p?.allowTool?.('WebSearch')).toBe(false);
    expect(p?.allowTool?.('Read')).toBe(true);
  });
});
