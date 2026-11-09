import { beforeEach } from 'vitest';

import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

const gateway: GatewayProviderDefinition = {
  kind: 'test-gateway',
  agentSkills: [],
  sessions: {
    async ensure() {
      return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
    },
  },
  approvals: {
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
};

beforeEach(async () => {
  await import('./mailbox/compose.js');
  (await import('./gateway-providers/index.js')).resetGatewayProvider(gateway);
});
