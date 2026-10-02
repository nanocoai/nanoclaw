import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadGatewayCatalog } from './catalog.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function gateway(root: string, name: string, manifest: object): void {
  const skill = path.join(root, '.claude', 'skills', name);
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
  fs.writeFileSync(path.join(skill, 'gateway.json'), `${JSON.stringify(manifest)}\n`);
}

describe('gateway skill discovery', () => {
  it('keeps OneCLI first and default with Iron Proxy selectable', () => {
    const catalog = loadGatewayCatalog();
    expect(catalog.default).toBe('onecli');
    expect(catalog.gateways[0].kind).toBe('onecli');
    expect(catalog.gateways.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['iron-proxy', 'onecli']));
  });

  it('puts a future default first without hardcoding a gateway name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-catalog-'));
    roots.push(root);
    gateway(root, 'add-first', { kind: 'first', label: 'First', description: 'First gateway' });
    gateway(root, 'add-next', { kind: 'next', label: 'Next', description: 'Next gateway', default: true });
    const catalog = loadGatewayCatalog(root);
    expect(catalog.default).toBe('next');
    expect(catalog.gateways.map((entry) => entry.kind)).toEqual(['next', 'first']);
  });

  it('loads self-described skills and requires one default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-catalog-'));
    roots.push(root);
    gateway(root, 'add-first', { kind: 'first', label: 'First', description: 'First gateway', default: true });
    gateway(root, 'add-second', { kind: 'second', label: 'Second', description: 'Second gateway' });

    const catalog = loadGatewayCatalog(root);
    expect(catalog.default).toBe('first');
    expect(catalog.gateways.map((entry) => entry.kind)).toEqual(['first', 'second']);

    gateway(root, 'add-second', { kind: 'second', label: 'Second', description: 'Second gateway', default: true });
    expect(() => loadGatewayCatalog(root)).toThrow(/exactly one default/);
  });
});
