/**
 * #2901: a WEBHOOK_PORT in .env used to be silently ignored. Drive the real
 * config module from a temp cwd with its own .env to check it's picked up.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config WEBHOOK_PORT resolution (#2901)', () => {
  const origCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-cfg-'));
    delete process.env.WEBHOOK_PORT;
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads WEBHOOK_PORT from .env when no process env var is set', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'WEBHOOK_PORT=3097\n');
    process.chdir(dir);

    const { WEBHOOK_PORT } = await import('./config.js');
    expect(WEBHOOK_PORT).toBe(3097);
  });

  it('defaults to 3000 with no .env and no env var', async () => {
    process.chdir(dir);

    const { WEBHOOK_PORT } = await import('./config.js');
    expect(WEBHOOK_PORT).toBe(3000);
  });

  it('process env var wins over .env', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'WEBHOOK_PORT=3097\n');
    process.chdir(dir);
    process.env.WEBHOOK_PORT = '4111';

    const { WEBHOOK_PORT } = await import('./config.js');
    expect(WEBHOOK_PORT).toBe(4111);
  });
});
