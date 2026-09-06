import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { spawnQuiet } from './runner.js';
import type { SetupDriver } from './setup-driver.js';

describe('machine child output bounds', () => {
  it('stops a noisy quiet child before its in-memory transcript can grow without bound', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-limit-'));
    const rawLog = path.join(root, 'raw.log');
    const driver = { mode: 'ndjson' } as SetupDriver;
    try {
      const result = await spawnQuiet(
        process.execPath,
        ['-e', `process.stdout.write('x'.repeat(5 * 1024 * 1024))`],
        rawLog,
        undefined,
        driver,
      );

      expect(result).toMatchObject({ ok: false, failure: 'output_limit' });
      expect(Buffer.byteLength(result.transcript, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
