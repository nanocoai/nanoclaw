import { describe, it, expect } from 'bun:test';
import { ManifestProvider } from './manifest.js';

describe('ManifestProvider', () => {
  it('constructs with default options', () => {
    const provider = new ManifestProvider();
    expect(provider.supportsNativeSlashCommands).toBe(false);
    expect(provider.usesMemoryScaffold).toBe(true);
  });

  it('constructs with custom env options', () => {
    const provider = new ManifestProvider({
      env: {
        MANIFEST_BASE_URL: 'https://my-instance.example.com/v1',
        MANIFEST_AUTH_TOKEN: 'mnfst_test',
      },
      model: 'auto',
    });
    expect(provider.supportsNativeSlashCommands).toBe(false);
  });

  it('isSessionInvalid always returns false', () => {
    const provider = new ManifestProvider();
    expect(provider.isSessionInvalid(new Error('test'))).toBe(false);
    expect(provider.isSessionInvalid(null)).toBe(false);
  });

  it('query returns an AgentQuery with expected shape', () => {
    const provider = new ManifestProvider();
    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    expect(typeof query.push).toBe('function');
    expect(typeof query.end).toBe('function');
    expect(typeof query.abort).toBe('function');
    expect(query.events).toBeDefined();
    expect(typeof query.events[Symbol.asyncIterator]).toBe('function');
    // Clean up
    query.abort();
  });
});
