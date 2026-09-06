import fs from 'node:fs';
import path from 'node:path';

import { emit as emitDiagnostic } from '../../lib/diagnostics.js';
import * as setupLog from '../../logs.js';
import { NdjsonSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const outputDir = process.env.NANOCLAW_TEST_OUTPUT_DIR;
if (outputDir) process.chdir(outputDir);

const driver = new NdjsonSetupDriver('setup');

driver.display({ id: 'rotating-code', kind: 'code', content: 'display-one', sensitive: true });
driver.display({ id: 'rotating-code', kind: 'code', content: 'display-two', sensitive: true });
driver.clearDisplay('rotating-code');
driver.note('display-one and display-two are no longer live');

const secret = await driver.prompt({
  id: 'credential',
  kind: 'secret',
  message: 'Credential',
  sensitive: true,
  validation: { required: true, pattern: '^secret-' },
});
driver.note(`accepted ${secret}`);
if (outputDir) {
  setupLog.reset({ accepted: `${secret} display-one display-two` });
  setupLog.userInput('credential', String(secret));
  setupLog.step('fixture', 'success', 1, { value: `${secret} display-one display-two` });
  globalThis.fetch = (async (_input, init) => {
    fs.writeFileSync(path.join(outputDir, 'diagnostic-body.json'), String(init?.body ?? ''));
    return { ok: true } as Response;
  }) as typeof fetch;
  emitDiagnostic('driver_fixture', { value: `${secret} display-one display-two` }, { persistId: false });
}

await driver.prompt({ id: 'continue', kind: 'confirm', message: 'Continue?', default: true });

let postconditionChecks = 0;
await driver.externalAction(
  {
    id: 'permission',
    kind: 'systemPermission',
    title: 'Grant test permission',
    instructions: ['Enable the test permission.'],
  },
  () => ++postconditionChecks > 1,
);
driver.completeSetup(fixtureSetupReceipt());
