/**
 * Setup-side registration guard for the cursor provider (the third barrel of
 * the multi-point archetype): imports the REAL setup/providers barrel and
 * asserts the registry carries cursor with its auth + install check. Red if
 * the barrel line is deleted, the barrel fails to evaluate, or the payload
 * module breaks.
 */
import { describe, expect, it } from 'vitest';

import { getSetupProvider } from './registry.js';
import './index.js';

describe('cursor setup registration', () => {
  it('registers cursor with auth + install check via the barrel', () => {
    const cursor = getSetupProvider('cursor');
    expect(cursor).toBeDefined();
    expect(typeof cursor!.runAuth).toBe('function');
    expect(typeof cursor!.runInstallCheck).toBe('function');
  });
});
