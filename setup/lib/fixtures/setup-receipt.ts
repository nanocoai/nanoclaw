import type { SetupReceipt } from '../setup-driver.js';

export function fixtureSetupReceipt(): SetupReceipt {
  return {
    version: 1,
    service: { state: 'running', manager: 'pidfile', checkoutRoot: process.cwd() },
    health: { status: 'healthy' },
    resources: {
      groups: { state: 'empty', count: 0 },
      policies: { state: 'empty', count: 0 },
      skills: { state: 'empty', count: 0 },
    },
    completedAt: new Date().toISOString(),
  };
}
