import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectInstalledGateway, ensureExplicitGatewaySelection, resolveGatewaySelection } from './selection.js';

const roots: string[] = [];

afterEach(() => {
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
  // A nested pnpm prints workspace warnings to stdout ahead of the detector's answer.
  const PNPM_WARN =
    'groups/zz-repro                          |  WARN  The field "pnpm.onlyBuiltDependencies" was found in ' +
    '/x/groups/zz-repro/package.json. This will not take effect.';

  function detectWith(stdout: string): string | undefined {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-probe-'));
    roots.push(root);
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const scripts = path.join(root, '.claude', 'skills', 'add-fixture', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'detect.ts'), `process.stdout.write(${JSON.stringify(stdout)});\n`);
    return detectInstalledGateway(root);
  }

  it('reads the answer after unrelated output such as a pnpm warning', () => {
    expect(detectWith(`${PNPM_WARN}\ninstalled\n`)).toBe('fixture');
  });

  it.each(['absent\n', `${PNPM_WARN}\nabsent\n`, 'installed\nabsent\n', ''])(
    'stays not installed when the detector says so: %j',
    (stdout) => {
      expect(detectWith(stdout)).toBeUndefined();
    },
  );

  it.each(['installedx\n', 'not installed\n', `installed ${PNPM_WARN}\n`, 'INSTALLED\n'])(
    'does not read garbage as installed: %j',
    (stdout) => {
      expect(detectWith(stdout)).toBeUndefined();
    },
  );
});
