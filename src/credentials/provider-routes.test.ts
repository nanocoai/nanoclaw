import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetProviderRoutesForTest,
  getProviderRoute,
  listProviderRoutes,
  registerProviderRoute,
} from './provider-routes.js';

describe('provider route registry', () => {
  afterEach(() => __resetProviderRoutesForTest());

  it('registers and retrieves a route', () => {
    registerProviderRoute('openai', 'https://api.openai.com');
    expect(getProviderRoute('openai')).toEqual({
      id: 'openai',
      baseUrl: 'https://api.openai.com',
    });
  });

  it('lists registered routes in insertion order', () => {
    registerProviderRoute('openai', 'https://api.openai.com');
    registerProviderRoute('anthropic', 'https://api.anthropic.com');
    registerProviderRoute('openrouter', 'https://openrouter.ai/api');
    expect(listProviderRoutes().map((r) => r.id)).toEqual(['openai', 'anthropic', 'openrouter']);
  });

  it('rejects duplicate registration', () => {
    registerProviderRoute('openai', 'https://api.openai.com');
    expect(() => registerProviderRoute('openai', 'https://other.example')).toThrow(/already registered/);
  });

  it('returns undefined for unknown id', () => {
    expect(getProviderRoute('nonexistent')).toBeUndefined();
  });
});
