import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  EGRESS_LOCKDOWN: false,
  EGRESS_NETWORK: 'fixture-egress',
  ENV_FILE_UNREADABLE: true,
}));
vi.mock('./container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { EgressPolicyUnknownError, ensureEgressNetwork } from './egress-lockdown.js';

describe('unknown egress policy', () => {
  it('refuses to spawn when .env exists but cannot be read', () => {
    expect(() =>
      ensureEgressNetwork({
        endpoint: 'gateway.internal',
        target: { kind: 'runtime', identity: 'fixture-gateway' },
      }),
    ).toThrow(EgressPolicyUnknownError);
  });

  it('does not guess "off" even when the flag is false', () => {
    expect(() =>
      ensureEgressNetwork({
        endpoint: 'gateway.internal',
        target: { kind: 'runtime', identity: 'fixture-gateway' },
      }),
    ).toThrow('egress policy cannot be determined');
  });
});
