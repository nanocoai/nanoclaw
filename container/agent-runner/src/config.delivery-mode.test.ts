import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfig } from './config.js';

/**
 * The runner half of the compatibility claim: a container.json that says
 * nothing about delivery — which is every config materialized from a NULL
 * `container_configs.delivery_mode` — must resolve to the envelope contract.
 */
describe('runner config: deliveryMode', () => {
  let dir: string;

  beforeEach(() => {
    resetConfig();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cfg-'));
  });

  afterEach(() => {
    resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;

  function writeConfig(body: Record<string, unknown>): string {
    const p = path.join(dir, `container-${n++}.json`);
    fs.writeFileSync(p, JSON.stringify(body));
    return p;
  }

  /** Each case loads a fresh file, so the cache is cleared between them. */
  function load(body: Record<string, unknown>): string {
    resetConfig();
    return writeConfig(body);
  }

  it('reads tools-only out of a materialized container.json', () => {
    expect(loadConfig(load({ provider: 'opencode', deliveryMode: 'tools-only' })).deliveryMode).toBe('tools-only');
  });

  it('resolves to the envelope contract for a config that says nothing', () => {
    expect(loadConfig(load({ provider: 'claude' })).deliveryMode).toBe('envelope');
  });

  it('resolves to the envelope contract for an unrecognized value', () => {
    expect(loadConfig(load({ deliveryMode: 'tools_only' })).deliveryMode).toBe('envelope');
  });

  it('resolves to the envelope contract when the file cannot be read', () => {
    resetConfig();
    expect(loadConfig(path.join(dir, 'missing.json')).deliveryMode).toBe('envelope');
  });

  it('refuses to hand back a cached config for a different file', () => {
    const first = load({ deliveryMode: 'tools-only' });
    expect(loadConfig(first).deliveryMode).toBe('tools-only');
    // Silently returning the cached value here would give a second group the
    // first group's delivery contract.
    expect(() => loadConfig(writeConfig({ deliveryMode: 'envelope' }))).toThrow(/call resetConfig/);
    expect(loadConfig(first).deliveryMode).toBe('tools-only');
  });
});
