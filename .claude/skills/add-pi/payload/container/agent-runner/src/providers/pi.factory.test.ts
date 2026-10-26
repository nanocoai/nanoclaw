/**
 * Unit test for the pi provider factory: importing ./pi.js directly self-registers
 * the provider (registerProvider('pi', …) at module top level), independent of the
 * barrel. createProvider('pi') must construct a PiProvider without touching the
 * network or the heavy pi SDK paths — construction only stores options.
 */
import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import './pi.js'; // self-registration side effect
import { PiProvider, toPiThinkingLevel } from './pi.js';

describe('pi provider factory', () => {
  it('returns PiProvider for pi', () => {
    expect(createProvider('pi')).toBeInstanceOf(PiProvider);
  });

  it('registers under the lowercase name pi', () => {
    // createProvider is case-sensitive; the canonical name is 'pi'.
    expect(() => createProvider('Pi' as ProviderName)).toThrow(/Unknown provider/);
  });
});

describe('pi effort mapping', () => {
  it('maps NanoClaw effort names onto pi thinking levels', () => {
    expect(toPiThinkingLevel('high')).toBe('high');
    expect(toPiThinkingLevel(' MAX ')).toBe('max');
    expect(toPiThinkingLevel('off')).toBe('off');
  });

  it('returns undefined for an absent or unknown effort, so pi keeps its default', () => {
    expect(toPiThinkingLevel(undefined)).toBeUndefined();
    expect(toPiThinkingLevel('')).toBeUndefined();
    expect(toPiThinkingLevel('turbo')).toBeUndefined();
  });
});
