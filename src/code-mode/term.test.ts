import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { deploymentTermMode, resolveCodeTermMode } from './term.js';

describe('resolveCodeTermMode', () => {
  it('defaults to tmux; attach is the explicit opt-out', () => {
    expect(resolveCodeTermMode('tmux')).toBe('tmux');
    expect(resolveCodeTermMode(' tmux ')).toBe('tmux');
    expect(resolveCodeTermMode('attach')).toBe('attach');
    expect(resolveCodeTermMode('TMUX')).toBe('tmux'); // typos fall to the default, not the degraded mode
    expect(resolveCodeTermMode(undefined)).toBe('tmux');
    expect(resolveCodeTermMode('')).toBe('tmux'); // empty = unset = the default
  });
});

describe('deploymentTermMode', () => {
  const savedCwd = process.cwd();

  afterEach(() => {
    process.chdir(savedCwd);
  });

  it('reads the process env first; unset resolves to the tmux default', () => {
    expect(deploymentTermMode({ NANOCLAW_CODE_TERM: 'attach' } as NodeJS.ProcessEnv)).toBe('attach');
    expect(deploymentTermMode({} as NodeJS.ProcessEnv)).toBe('tmux');
  });

  it('falls back to the .env file — the seam the box actually configures through', () => {
    // The regression this pins: a knob read only from process.env is
    // invisible to a box that sets it in .env (the NANOCLAW_SANDBOX_OWNER
    // lesson) — so this test writes a real .env, no process.env shortcut.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-mode-test-'));
    fs.writeFileSync(path.join(dir, '.env'), 'NANOCLAW_CODE_TERM=tmux\n');
    process.chdir(dir);
    expect(deploymentTermMode({} as NodeJS.ProcessEnv)).toBe('tmux');
  });
});
