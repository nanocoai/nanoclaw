/**
 * Setup-side registration guard for the codex provider (the third barrel of
 * the multi-point archetype): imports the REAL setup/providers barrel and
 * asserts the registry carries codex with its auth + install check. Red if
 * the barrel line is deleted, the barrel fails to evaluate, or the payload
 * module breaks. (Importing ./codex.js directly would self-register and stay
 * green when the barrel line is deleted.)
 */
import { describe, expect, it } from 'vitest';

import { getSetupProvider } from './registry.js';
import './index.js'; // the real setup provider barrel

describe('codex setup registration', () => {
  it('registers codex with auth + install check via the barrel', () => {
    const codex = getSetupProvider('codex');
    expect(codex).toBeDefined();
    expect(typeof codex!.runAuth).toBe('function');
    expect(typeof codex!.runInstallCheck).toBe('function');
    expect(typeof codex!.offerFailureAssist).toBe('function');
  });
});
