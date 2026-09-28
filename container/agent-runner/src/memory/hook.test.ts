import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { runBun, type RunBunResult } from '../test-utils/run-bun.js';

const BASE = '/tmp/nanoclaw-memory-hook-test';

function runHook(input: string): Promise<RunBunResult> {
  return runBun([path.join(import.meta.dir, 'hook.ts'), BASE], input);
}

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'memory', 'index.md'), '# Memory Index\n');
  fs.writeFileSync(path.join(BASE, 'memory', 'system', 'definition.md'), '# Definition\n');
});

afterEach(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('memory-hook script', () => {
  it('prints live memory for a new context', async () => {
    const proc = await runHook(JSON.stringify({ source: 'startup' }));

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain('## Memory');
  });

  it('prints nothing for resume', async () => {
    const proc = await runHook(JSON.stringify({ source: 'resume' }));

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toBe('');
  });

  it('fails closed for missing or malformed source input', async () => {
    expect((await runHook('{}')).stdout).toBe('');
    expect((await runHook('{not-json')).stdout).toBe('');
  });
});
