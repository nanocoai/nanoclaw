import { describe, expect, it } from 'bun:test';

import { runnerConfigFromRaw } from './config.js';

describe('runner config speed', () => {
  it('reads speed from a host that writes it', () => {
    expect(runnerConfigFromRaw({ speed: 'fast' }).speed).toBe('fast');
    expect(runnerConfigFromRaw({ speed: 'standard' }).speed).toBe('standard');
  });

  it('reads the legacy fastMode key from a host older than speed', () => {
    expect(runnerConfigFromRaw({ fastMode: true }).speed).toBe('fast');
    expect(runnerConfigFromRaw({ fastMode: false }).speed).toBeUndefined();
    expect(runnerConfigFromRaw({}).speed).toBeUndefined();
  });

  it('lets speed win over the legacy mirror and passes provider-declared tiers through', () => {
    expect(runnerConfigFromRaw({ speed: 'standard', fastMode: true }).speed).toBe('standard');
    // The vocabulary is the provider's; the host validated the name at write time.
    expect(runnerConfigFromRaw({ speed: 'turbo' }).speed).toBe('turbo');
    expect(runnerConfigFromRaw({ speed: '' }).speed).toBeUndefined();
    expect(runnerConfigFromRaw({ speed: 7 }).speed).toBeUndefined();
  });
});
