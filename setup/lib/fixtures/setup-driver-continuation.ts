import { spawnSync } from 'node:child_process';

import { createSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const tsxLoader = process.env.NANOCLAW_TEST_TSX_LOADER;
if (!tsxLoader) throw new Error('NANOCLAW_TEST_TSX_LOADER is required');

const driver = createSetupDriver('setup');
if (process.env.NANOCLAW_TEST_CONTINUED === '1') {
  await driver.prompt({ id: 'continued-confirm', kind: 'confirm', message: 'Continue?', default: true });
  driver.completeSetup(fixtureSetupReceipt());
} else {
  driver.handoff();
  const result = spawnSync(process.execPath, ['--import', tsxLoader, process.argv[1]], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NANOCLAW_TEST_CONTINUED: '1',
      NANOCLAW_DRIVER_CONTINUATION: '1',
    },
  });
  process.exit(result.status ?? 1);
}
