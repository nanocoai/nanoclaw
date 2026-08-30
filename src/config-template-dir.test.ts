import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_TEMPLATES_DIR = process.env.NANOCLAW_TEMPLATES_DIR;
let testRoot: string | undefined;

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_TEMPLATES_DIR === undefined) {
    delete process.env.NANOCLAW_TEMPLATES_DIR;
  } else {
    process.env.NANOCLAW_TEMPLATES_DIR = ORIGINAL_TEMPLATES_DIR;
  }
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
  vi.resetModules();
});

describe('template library configuration', () => {
  it('loads NANOCLAW_TEMPLATES_DIR from the host .env file', async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-template-config-'));
    fs.writeFileSync(path.join(testRoot, '.env'), 'NANOCLAW_TEMPLATES_DIR=./shared-templates\n');
    process.chdir(testRoot);
    delete process.env.NANOCLAW_TEMPLATES_DIR;
    vi.resetModules();

    const { TEMPLATES_DIR } = await import('./config.js');

    expect(TEMPLATES_DIR).toBe(path.resolve('shared-templates'));
  });
});
