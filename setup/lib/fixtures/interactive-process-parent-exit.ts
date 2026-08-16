import { runInteractiveProcess } from '../interactive-process.js';
import type { SetupDriver } from '../setup-driver.js';

const driver = {
  mode: 'ndjson',
  operation: 'setup',
  throwIfCancelled() {},
} as SetupDriver;

void runInteractiveProcess(
  driver,
  process.execPath,
  [
    '-e',
    `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(grandchild.pid) + '\\n');
    setInterval(() => {}, 1000);
  `,
  ],
  {
    onOutput(chunk) {
      process.stdout.write(chunk);
      process.exit(23);
    },
  },
);
