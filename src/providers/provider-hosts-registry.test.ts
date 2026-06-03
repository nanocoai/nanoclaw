import { afterEach, describe, expect, it } from 'vitest';

import {
  getProviderHosts,
  listProvidersWithHosts,
  registerProviderHosts,
  resetProviderHostsForTests,
} from './provider-hosts-registry.js';

afterEach(() => {
  resetProviderHostsForTests();
});

describe('provider hosts registry', () => {
  it('returns the built-in claude default without any registration', () => {
    expect(getProviderHosts('claude')).toEqual(['.api.anthropic.com']);
  });

  it('returns empty array for unregistered providers', () => {
    expect(getProviderHosts('nonesuch')).toEqual([]);
  });

  it('lookup is case-insensitive', () => {
    expect(getProviderHosts('Claude')).toEqual(['.api.anthropic.com']);
    expect(getProviderHosts('CLAUDE')).toEqual(['.api.anthropic.com']);
  });

  it('registerProviderHosts merges with existing entries (no duplicates)', () => {
    registerProviderHosts('claude', ['.api.anthropic.com', '.bedrock.amazonaws.com']);
    expect(getProviderHosts('claude').sort()).toEqual(['.api.anthropic.com', '.bedrock.amazonaws.com']);
  });

  it('registerProviderHosts seeds new providers', () => {
    registerProviderHosts('ollama', ['localhost', '127.0.0.1']);
    expect(getProviderHosts('ollama').sort()).toEqual(['127.0.0.1', 'localhost']);
  });

  it('listProvidersWithHosts surfaces every keyed provider', () => {
    registerProviderHosts('ollama', ['localhost']);
    expect(listProvidersWithHosts().sort()).toEqual(['claude', 'ollama']);
  });

  it('resetProviderHostsForTests removes user-added entries but preserves built-ins', () => {
    registerProviderHosts('ollama', ['localhost']);
    expect(getProviderHosts('ollama')).toEqual(['localhost']);
    resetProviderHostsForTests();
    expect(getProviderHosts('ollama')).toEqual([]);
    expect(getProviderHosts('claude')).toEqual(['.api.anthropic.com']);
  });
});
