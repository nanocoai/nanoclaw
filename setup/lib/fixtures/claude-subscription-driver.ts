import { runClaudeSubscriptionMachineAuth } from '../claude-subscription-auth.js';
import { DriverTerminalError, NdjsonSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const driver = new NdjsonSetupDriver('setup');
try {
  const result = await runClaudeSubscriptionMachineAuth(driver);
  if (!result.ok) driver.error('claude_auth_failed', 'Claude authentication failed in the fixture.');
  driver.completeSetup(fixtureSetupReceipt());
} catch (error) {
  if (!(error instanceof DriverTerminalError)) throw error;
  process.exitCode = error.exitCode;
}
