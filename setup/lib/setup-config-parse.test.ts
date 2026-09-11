import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

import { parseFlags } from './setup-config-parse.js';

describe('public setup flags', () => {
  it('forwards nanoclaw.sh arguments without an end-of-options marker', () => {
    const entrypoint = fs.readFileSync(path.join(process.cwd(), 'nanoclaw.sh'), 'utf8');
    expect(entrypoint).toContain('exec pnpm --silent run setup:auto "$@"');
    expect(entrypoint).not.toContain('run setup:auto -- "$@"');
  });

  it('shows shell help without running bootstrap when dependencies are absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-help-'));
    try {
      fs.copyFileSync(path.join(process.cwd(), 'nanoclaw.sh'), path.join(root, 'nanoclaw.sh'));
      fs.writeFileSync(path.join(root, 'setup.sh'), 'touch bootstrap-ran\n');

      const result = spawnSync('bash', ['nanoclaw.sh', '--help'], { cwd: root, encoding: 'utf8' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--template-path <ref>');
      expect(fs.existsSync(path.join(root, 'bootstrap-ran'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds the uvx install directory before probing npm and executing pnpm', () => {
    const entrypoint = fs.readFileSync(path.join(process.cwd(), 'nanoclaw.sh'), 'utf8');
    const localBinRecovery = entrypoint.indexOf('export PATH="$HOME/.local/bin:$PATH"');
    const npmProbe = entrypoint.indexOf('command -v npm', localBinRecovery);
    const handoff = entrypoint.indexOf('exec pnpm --silent run setup:auto', npmProbe);

    expect(localBinRecovery).toBeGreaterThan(-1);
    expect(npmProbe).toBeGreaterThan(localBinRecovery);
    expect(handoff).toBeGreaterThan(npmProbe);
  });

  it('parses the template path exposed by the entrypoint', () => {
    expect(parseFlags(['--template-path', 'sales/sdr'])).toEqual({
      values: { templatePath: 'sales/sdr' },
      rest: [],
      help: false,
      errors: [],
    });
  });
});
