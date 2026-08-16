import { fullyApplied } from '../../../scripts/skill-apply.js';
import { hostExec, runSkill } from '../skill-driver.js';
import { DriverTerminalError, NdjsonSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const skillDir = process.env.NANOCLAW_TEST_SKILL_DIR;
const projectRoot = process.env.NANOCLAW_TEST_PROJECT_ROOT;
if (!skillDir || !projectRoot) throw new Error('missing skill fixture paths');

const driver = new NdjsonSetupDriver('setup');
try {
  const result = await runSkill(skillDir, {
    driver,
    projectRoot,
    exec: hostExec(projectRoot),
  });
  if (!fullyApplied(result)) driver.error('skill_incomplete', 'The fixture skill did not complete.');
  driver.completeSetup(fixtureSetupReceipt());
} catch (error) {
  if (error instanceof DriverTerminalError) process.exitCode = error.exitCode;
  else throw error;
}
