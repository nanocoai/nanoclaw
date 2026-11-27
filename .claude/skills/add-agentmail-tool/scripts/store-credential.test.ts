import { describe, expect, it } from 'vitest';

import type {
  GatewayCredentialTarget,
  ProviderCredentialStore,
} from '../../../../setup/gateways/credential-store.js';
import { AGENTMAIL_TARGET, storeAgentMailCredential } from './store-credential.js';

function fakeStore(existing: boolean) {
  const calls: string[] = [];
  let target: GatewayCredentialTarget | undefined;
  const store: ProviderCredentialStore = {
    has: async () => false,
    save: async () => {},
    connection(t) {
      target = t;
      return {
        find: async () => {
          calls.push('find');
          return existing ? { reusable: true } : null;
        },
        save: async (v) => void calls.push(`save:${String(v)}`),
        keep: async () => void calls.push('keep'),
      };
    },
  };
  return { store, calls, target: () => target };
}

describe('storeAgentMailCredential', () => {
  it('describes an api.agentmail.to bearer credential the container placeholder matches', async () => {
    const f = fakeStore(false);
    await storeAgentMailCredential(f.store, 'am_key');
    expect(f.target()).toEqual(AGENTMAIL_TARGET);
    expect(AGENTMAIL_TARGET).toMatchObject({
      host: 'api.agentmail.to',
      proxyValue: 'gateway-managed',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
  });

  it('saves a supplied key after looking up the entry', async () => {
    const f = fakeStore(true);
    expect(await storeAgentMailCredential(f.store, 'am_key')).toBe('saved');
    expect(f.calls).toEqual(['find', 'save:am_key']);
  });

  it('keeps an existing entry when no key is supplied', async () => {
    const f = fakeStore(true);
    expect(await storeAgentMailCredential(f.store, null)).toBe('kept');
    expect(f.calls).toEqual(['find', 'keep']);
  });

  it('fails with guidance when there is neither a key nor an entry', async () => {
    await expect(storeAgentMailCredential(fakeStore(false).store, null)).rejects.toThrow(/AGENTMAIL_API_KEY/);
  });

  it('fails with console guidance when the gateway has no caller-described connections', async () => {
    const store: ProviderCredentialStore = { has: async () => false, save: async () => {} };
    await expect(storeAgentMailCredential(store, 'k')).rejects.toThrow(/api\.agentmail\.to/);
  });
});
