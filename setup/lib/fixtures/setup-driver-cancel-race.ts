import { DriverCancelled, NdjsonSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const driver = new NdjsonSetupDriver('setup');
try {
  await driver.externalAction(
    {
      id: 'slow-postcondition',
      kind: 'systemPermission',
      title: 'Complete the slow action',
      instructions: ['Test only.'],
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return false;
    },
  );
  driver.completeSetup(fixtureSetupReceipt());
} catch (error) {
  if (!(error instanceof DriverCancelled)) throw error;
  driver.cancelled();
  process.exitCode = 2;
}
