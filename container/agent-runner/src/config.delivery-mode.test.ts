import { describe, it, expect } from 'bun:test';

import { runnerConfigFromRaw } from './config.js';

/**
 * The runner half of the compatibility claim: a container.json that says
 * nothing about delivery — which is every config materialized from a NULL
 * `container_configs.delivery_mode` — must resolve to the envelope contract.
 */
describe('runner config: deliveryMode', () => {
  it('reads tools-only out of a materialized container.json', () => {
    expect(runnerConfigFromRaw({ provider: 'opencode', deliveryMode: 'tools-only' }).deliveryMode).toBe('tools-only');
  });

  it('resolves to the envelope contract for a config that says nothing', () => {
    expect(runnerConfigFromRaw({ provider: 'claude' }).deliveryMode).toBe('envelope');
  });

  it('resolves to the envelope contract for an unrecognized value', () => {
    expect(runnerConfigFromRaw({ deliveryMode: 'tools_only' }).deliveryMode).toBe('envelope');
  });
});
