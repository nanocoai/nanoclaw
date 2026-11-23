/**
 * The ChatGPT grant is the one part of this setup hook that talks to a vault
 * the tests cannot have, so it is exercised through the seam it actually uses.
 * The failure that motivated it: the login is recorded under `codex`, a spawn
 * grants a group only its own provider's credentials, and pi's groups were left
 * with none — first turn dies with `401 access restricted` while the vault holds
 * a perfectly good login.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  GatewayCredentialTarget,
  ProviderCredentialStore,
} from '../../gateways/credential-store.js';
import { grantChatGptLogin } from './pi.js';

interface FakeConnection {
  find: ReturnType<typeof vi.fn>;
  keep: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function fakeStore(connection: FakeConnection | undefined): {
  store: ProviderCredentialStore;
  target: () => GatewayCredentialTarget;
} {
  let seen: GatewayCredentialTarget | undefined;
  const store = {
    has: async () => true,
    save: async () => {},
    ...(connection
      ? {
          connection: (next: GatewayCredentialTarget) => {
            seen = next;
            return connection;
          },
        }
      : {}),
  } as ProviderCredentialStore;
  return { store, target: () => seen! };
}

function connection(found: boolean): FakeConnection {
  return {
    find: vi.fn(async () => (found ? { reusable: true } : null)),
    keep: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  };
}

describe('grantChatGptLogin', () => {
  it('attaches the stored Codex login to pi by keeping it under the pi provider', async () => {
    const fake = connection(true);
    const { store, target } = fakeStore(fake);

    expect(await grantChatGptLogin(store)).toBe(true);

    // `keep()` reconciles the observed entry and records its id against
    // target.provider — the seam's only way to grant an existing entry to
    // another provider. The name and host must be the ones Codex saved under,
    // because that is how the gateway addresses the record.
    expect(fake.find).toHaveBeenCalledTimes(1);
    expect(fake.keep).toHaveBeenCalledTimes(1);
    expect(fake.save).not.toHaveBeenCalled();
    expect(target()).toMatchObject({
      name: 'Codex',
      host: 'chatgpt.com',
      provider: 'pi',
      kind: 'oauth',
      oauth: { profile: 'chatgpt' },
    });
  });

  it('reports failure without touching the vault when no login is recorded', async () => {
    const fake = connection(false);
    const { store } = fakeStore(fake);

    expect(await grantChatGptLogin(store)).toBe(false);
    expect(fake.keep).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the gateway cannot be read', async () => {
    const { store } = fakeStore({
      find: vi.fn(async () => {
        throw new Error('Cannot read the selected OneCLI vault; check that OneCLI is running.');
      }),
      keep: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    });

    expect(await grantChatGptLogin(store)).toBe(false);
  });

  it('reports failure when the gateway has no caller-described connections', async () => {
    const { store } = fakeStore(undefined);
    expect(await grantChatGptLogin(store)).toBe(false);
  });
});
