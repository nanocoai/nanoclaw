import { describe, it, expect } from 'bun:test';
import { listProviderNames } from './provider-registry.js';

describe('manifest container-side registration', () => {
  it('registers the manifest provider', async () => {
    // Import the barrel to trigger all registrations
    await import('./index.js');
    const names = listProviderNames();
    expect(names).toContain('manifest');
  });
});
