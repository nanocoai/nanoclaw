import { DriverCancelled, NdjsonSetupDriver } from '../setup-driver.js';
import { runWindowedStep } from '../windowed-runner.js';

const driver = new NdjsonSetupDriver('setup');

try {
  await runWindowedStep(
    'cancel-window',
    { running: 'Starting windowed step…', done: 'Windowed step done.' },
    [],
    driver,
  );
  driver.completeSetup({
    version: 1,
    service: { state: 'running', manager: 'pidfile', checkoutRoot: process.cwd() },
    health: { status: 'healthy' },
    resources: {
      groups: { state: 'empty', count: 0 },
      policies: { state: 'empty', count: 0 },
      skills: { state: 'empty', count: 0 },
    },
    completedAt: new Date().toISOString(),
  });
} catch (error) {
  if (!(error instanceof DriverCancelled)) throw error;
  driver.cancelled();
  process.exitCode = 2;
}
