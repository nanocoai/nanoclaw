/**
 * Setup-side registration guard for the antigravity provider: imports the REAL
 * setup/providers barrel and asserts the registry carries antigravity with its
 * auth step and install check. Red if the barrel line is deleted, the barrel
 * fails to evaluate, or the payload module breaks.
 */
import { describe, expect, it } from 'vitest';

import { getSetupProvider } from './registry.js';
import './index.js';

describe('antigravity setup registration', () => {
  it('registers antigravity with auth + install check via the barrel', () => {
    const antigravity = getSetupProvider('antigravity');
    expect(antigravity).toBeDefined();
    expect(typeof antigravity!.runAuth).toBe('function');
    expect(typeof antigravity!.runInstallCheck).toBe('function');
  });
});
