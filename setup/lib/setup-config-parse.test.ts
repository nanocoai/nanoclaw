import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

import { CHANNELS } from '../../scripts/update/channel.js';
import { CONFIG } from './setup-config.js';
import { applyToEnv, envErrors, parseFlags, readFromEnv } from './setup-config-parse.js';

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

  it('parses an explicit gateway selection', () => {
    expect(parseFlags(['--gateway-provider', 'onecli']).values).toEqual({ gatewayProvider: 'onecli' });
  });

  it('lists the update channel in the shell help', () => {
    const entrypoint = fs.readFileSync(path.join(process.cwd(), 'nanoclaw.sh'), 'utf8');
    expect(entrypoint).toContain('--update-channel <name>');
  });
});

describe('update channel setting', () => {
  it('offers exactly the channels the updater knows, on the Advanced screen', () => {
    const entry = CONFIG.find((e) => e.key === 'updateChannel');
    expect(entry).toMatchObject({ type: 'enum', surface: 'flag+ui', group: 'Updates' });
    expect(entry?.type === 'enum' && entry.options.map((o) => o.value)).toEqual([...CHANNELS]);
  });

  it('parses from the flag in both forms', () => {
    expect(parseFlags(['--update-channel', 'edge']).values).toEqual({ updateChannel: 'edge' });
    expect(parseFlags(['--update-channel=Beta']).values).toEqual({ updateChannel: 'beta' });
  });

  it('rejects other values from the flag', () => {
    const result = parseFlags(['--update-channel', 'nightly']);
    expect(result.values).toEqual({});
    expect(result.errors).toEqual(['Invalid enum for --update-channel: nightly (use one of: stable, beta, edge)']);
  });

  it('parses from NANOCLAW_UPDATE_CHANNEL and writes the canonical value back', () => {
    expect(readFromEnv({ NANOCLAW_UPDATE_CHANNEL: 'EDGE' })).toEqual({ updateChannel: 'edge' });
    expect(envErrors({ NANOCLAW_UPDATE_CHANNEL: 'edge' })).toEqual([]);
    const env: NodeJS.ProcessEnv = {};
    applyToEnv({ updateChannel: 'beta' }, env);
    expect(env).toEqual({ NANOCLAW_UPDATE_CHANNEL: 'beta' });
  });

  it('rejects other values from the environment', () => {
    expect(readFromEnv({ NANOCLAW_UPDATE_CHANNEL: 'nightly' })).toEqual({});
    expect(envErrors({ NANOCLAW_UPDATE_CHANNEL: 'nightly' })).toEqual([
      'Invalid value for NANOCLAW_UPDATE_CHANNEL: nightly (use one of: stable, beta, edge)',
    ]);
  });

  it('still accepts any gateway kind, whose options are filled in at runtime', () => {
    expect(parseFlags(['--gateway-provider', 'anything']).errors).toEqual([]);
    expect(envErrors({ NANOCLAW_GATEWAY_PROVIDER: 'anything' })).toEqual([]);
  });
});
