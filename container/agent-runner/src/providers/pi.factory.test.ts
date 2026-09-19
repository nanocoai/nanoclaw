/**
 * Unit test for the pi provider factory: importing ./pi.js directly self-registers
 * the provider (registerProvider('pi', …) at module top level), independent of the
 * barrel. createProvider('pi') must construct a PiProvider without touching the
 * network or the heavy pi SDK paths — construction only stores options.
 */
import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import './pi.js'; // self-registration side effect
import { PiProvider } from './pi.js';

describe('pi provider factory', () => {
  it('returns PiProvider for pi', () => {
    expect(createProvider('pi')).toBeInstanceOf(PiProvider);
  });

  it('registers under the lowercase name pi', () => {
    // createProvider is case-sensitive; the canonical name is 'pi'.
    expect(() => createProvider('Pi' as ProviderName)).toThrow(/Unknown provider/);
  });
});
