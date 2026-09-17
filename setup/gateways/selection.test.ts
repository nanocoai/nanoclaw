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
