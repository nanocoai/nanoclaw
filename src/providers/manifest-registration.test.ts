import { describe, it, expect } from 'vitest';
import { listProviderContainerConfigNames } from './provider-container-registry.js';

describe('manifest host-side registration', () => {
  it('registers the manifest provider container config', async () => {
    // Import the barrel to trigger all registrations
    await import('./index.js');
    const names = listProviderContainerConfigNames();
    expect(names).toContain('manifest');
  });
});
