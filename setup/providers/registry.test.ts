/**
 * Setup-side provider registration guards.
 *
 * Behavior (barrel-driven): imports the real setup/providers barrel and
 * asserts the built-in default — red if the barrel fails to evaluate.
 * Per-provider registration guards ship WITH each provider payload (the
 * skill copies them in), same archetype as the host/container registration
 * tests.
 *
 * Structural: the picker and the standalone provider-auth step are wiring
 * inside non-invocable entry flows (setup main, STEPS map) — assert their
 * consumption of the registry in source, so deleting either reach-in goes red.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getSetupProvider, listSetupProviders } from './registry.js';
import './index.js'; // the real setup provider barrel — triggers self-registration

describe('setup provider registry', () => {
  it('always carries claude as the built-in default with the standard auth flow', () => {
    const claude = getSetupProvider('claude');
    expect(claude).toBeDefined();
    expect(claude!.runAuth).toBeUndefined();
    expect(listSetupProviders()[0]!.value).toBe('claude');
  });
});

describe('setup flow consumes the registry (structural)', () => {
  it('the picker renders options from listSetupProviders', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'setup', 'auto.ts'), 'utf-8');
    expect(src).toContain('listSetupProviders()');
    expect(src).toContain("import './providers/index.js'");
    expect(src).toContain('NANOCLAW_AGENT_PROVIDER');
    // The capability-keyed branch — a provider's own auth runs iff it declares one.
    expect(src).toMatch(/providerEntry\?\.runAuth/);
  });

  it('the provider preset is exposed as an env setup knob', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'setup', 'lib', 'setup-config.ts'), 'utf-8');
    expect(src).toContain('NANOCLAW_AGENT_PROVIDER');
    expect(src).toContain("key: 'agentProvider'");
  });

  it('the standalone provider-auth step is reachable from the STEPS map', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'setup', 'index.ts'), 'utf-8');
    expect(src).toContain("'provider-auth'");
  });
});
