import { hostExecStream } from '../skill-driver.js';
import { DriverTerminalError, NdjsonSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const driver = new NdjsonSetupDriver('setup');
try {
  const result = await hostExecStream(
    process.cwd(),
    driver,
  )('"$(npm prefix -g 2>/dev/null)/bin/teams" login && echo \'"loggedIn": true\'');
  if (!result.ok) driver.error('tty_action_failed', 'The terminal-owned action did not satisfy its postcondition.');
  driver.completeSetup(fixtureSetupReceipt());
} catch (error) {
  if (!(error instanceof DriverTerminalError)) throw error;
  process.exitCode = error.exitCode;
}
