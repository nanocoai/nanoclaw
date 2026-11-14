// Not under setup/providers: the install verifier runs those tests inside
// installs, where a private provider skill would make this guard fail.
import { describe, expect, it } from 'vitest';

import { listProviderDescriptors, providerDiagnostic } from '../providers/skill-descriptor.js';

describe('providerDiagnostic', () => {
  it('knows every provider skill this repo ships', () => {
    const shipped = listProviderDescriptors().map((d) => d.value);
    expect(shipped.length).toBeGreaterThan(0);
    for (const provider of ['claude', ...shipped]) expect(providerDiagnostic(provider)).toBe(provider);
  });

  it('sends unknown for any other provider name', () => {
    for (const name of ['acme-internal', 'Codex', '']) expect(providerDiagnostic(name)).toBe('unknown');
  });
});
