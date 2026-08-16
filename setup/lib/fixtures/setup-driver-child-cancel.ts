import { DriverCancelled, NdjsonSetupDriver } from '../setup-driver.js';
import { runQuietChild } from '../runner.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const driver = new NdjsonSetupDriver('setup');
const marker = process.env.NANOCLAW_TEST_CHILD_MARKER;
if (!marker) driver.error('test_fixture', 'missing child marker');
const stubbornGrandchild = `
  process.on('SIGTERM', () => {});
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
`;
const childScript = `
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(stubbornGrandchild)}], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.once('data', () => fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid)));
  setInterval(() => {}, 1000);
`;

try {
  await runQuietChild(
    'cancel-child',
    process.execPath,
    ['-e', childScript],
    { running: 'Starting child…', done: 'Child done.' },
    undefined,
    driver,
  );
  driver.completeSetup(fixtureSetupReceipt());
} catch (error) {
  if (!(error instanceof DriverCancelled)) throw error;
  driver.cancelled();
  process.exitCode = 2;
}
