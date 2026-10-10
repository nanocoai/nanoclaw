import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectInstalledGateway, ensureExplicitGatewaySelection, resolveGatewaySelection } from './selection.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('implicit gateway migration', () => {
  it.each([
    'NANOCLAW_GATEWAY_PROVIDER = iron-proxy',
    'NANOCLAW_GATEWAY_PROVIDER=iron-proxy  ',
    '  NANOCLAW_GATEWAY_PROVIDER=iron-proxy',
    'NANOCLAW_GATEWAY_PROVIDER="iron-proxy"',
    "NANOCLAW_GATEWAY_PROVIDER='iron-proxy'",
  ])('preserves a stopped gateway using host-compatible env syntax: %s', (line) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-selection-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, '.env'), `${line}\n`);
    expect(resolveGatewaySelection(root, () => false)).toBe('iron-proxy');
  });

  it('stamps the one detected installed skill and rejects ambiguity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-selection-'));
    roots.push(root);
    for (const name of ['add-first', 'add-second']) {
      const scripts = path.join(root, '.claude', 'skills', name, 'scripts');
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(scripts, 'detect.ts'), '');
    }

    expect(ensureExplicitGatewaySelection(root, (script) => script.includes('add-first'))).toBe('first');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('NANOCLAW_GATEWAY_PROVIDER=first');

    fs.rmSync(path.join(root, '.env'));
    expect(() => ensureExplicitGatewaySelection(root, () => true)).toThrow(/Multiple installed gateways/);
  });

  it('resolves an implicit choice without stamping it before installation succeeds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-selection-'));
    roots.push(root);
    const scripts = path.join(root, '.claude', 'skills', 'add-onecli', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'detect.ts'), '');

    expect(resolveGatewaySelection(root, () => true)).toBe('onecli');
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('returns no selection when no installed gateway is detected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-selection-'));
    roots.push(root);
    expect(detectInstalledGateway(root)).toBeUndefined();
  });
});

describe('real detector probe', () => {
  it('detects an installed gateway from inside a nested pnpm', () => {
    // An outer `pnpm exec` sets this. The inner pnpm then prints a WARN to stdout
    // for a nested package.json with a `pnpm` field, ahead of the detector's answer.
    vi.stubEnv('pnpm_config_verify_deps_before_run', 'false');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-probe-'));
    roots.push(root);
    const host = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const { packageManager, pnpm } = host;
    // The symlinked install records the host's patches and overrides; a probe root
    // that disagrees makes pnpm skip the nested-project scan that prints the WARN.
    // A `$dep` override names a host dependency the probe root does not have.
    const deps: Record<string, string> = {
      ...host.optionalDependencies,
      ...host.devDependencies,
      ...host.dependencies,
    };
    const patches = Object.entries<string>(pnpm?.patchedDependencies ?? {}).map(([dep, file]) => [
      dep,
      path.resolve(file),
    ]);
    const overrides = Object.entries<string>(pnpm?.overrides ?? {}).map(([selector, spec]) => [
      selector,
      spec.startsWith('$') ? deps[spec.slice(1)] : spec,
    ]);
    const mirrored = {
      ...(patches.length ? { patchedDependencies: Object.fromEntries(patches) } : {}),
      ...(overrides.length ? { overrides: Object.fromEntries(overrides) } : {}),
    };
    const probePnpm = Object.keys(mirrored).length ? { pnpm: mirrored } : {};
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', packageManager, ...probePnpm }));
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies: [esbuild]\n');
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'groups', 'repro'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'groups', 'repro', 'package.json'),
      JSON.stringify({ name: 'repro', pnpm: { onlyBuiltDependencies: ['esbuild'] } }),
    );
    const scripts = path.join(root, '.claude', 'skills', 'add-fixture', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'detect.ts'), "console.log('installed');\n");

    const loud = execFileSync('pnpm', ['exec', 'tsx', path.join(scripts, 'detect.ts')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(loud).toContain('WARN');
    expect(detectInstalledGateway(root)).toBe('fixture');
  });
});
