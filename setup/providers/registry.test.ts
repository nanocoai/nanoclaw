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
import { describe, expect, it, vi } from 'vitest';

import { NdjsonSetupDriver } from '../lib/setup-driver.js';
import type { SetupDriver } from '../lib/setup-driver.js';
import { getSetupProvider, listSetupProviders, registerSetupProvider, runSetupProviderAuth } from './registry.js';
import './index.js'; // the real setup provider barrel — triggers self-registration

describe('setup provider registry', () => {
  it('always carries claude as the built-in default with the standard auth flow', () => {
    const claude = getSetupProvider('claude');
    expect(claude).toBeDefined();
    expect(claude!.runAuth).toBeUndefined();
    expect(listSetupProviders()[0]!.value).toBe('claude');
  });

  it('gives structured provider auth and install checks the machine driver without raw stdout', async () => {
    let received: NdjsonSetupDriver | undefined;
    registerSetupProvider({
      value: 'driver-check-fixture',
      label: 'Driver check fixture',
      hint: '',
      supportsStructuredAuth: true,
      async runAuth(driver) {
        received = driver as NdjsonSetupDriver;
      },
      async runInstallCheck(driver) {
        expect(driver).toBe(received);
        driver.log('success', 'Provider install check passed.');
      },
    });
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const driver = new NdjsonSetupDriver('setup', { emitHello: false });
    try {
      await runSetupProviderAuth(getSetupProvider('driver-check-fixture')!, driver);
    } finally {
      driver.close();
      write.mockRestore();
    }

    expect(received).toBe(driver);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({
      protocol: 'nanoclaw.driver.v1',
      operation: 'setup',
      type: 'display',
      display: { kind: 'text', content: 'Provider install check passed.', sensitive: false },
    });
  });

  it('fails before invoking an old terminal-only provider in machine mode', async () => {
    let invoked = false;
    registerSetupProvider({
      value: 'terminal-only-fixture',
      label: 'Terminal-only fixture',
      hint: '',
      async runAuth() {
        invoked = true;
      },
    });
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const driver = new NdjsonSetupDriver('setup', { emitHello: false });
    try {
      await expect(runSetupProviderAuth(getSetupProvider('terminal-only-fixture')!, driver)).rejects.toMatchObject({
        exitCode: 1,
      });
    } finally {
      driver.close();
      write.mockRestore();
    }

    expect(invoked).toBe(false);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({
      type: 'error',
      code: 'provider_auth_update_required',
      stepId: 'auth',
    });
  });

  it('keeps old provider auth working through the terminal driver', async () => {
    const calls: string[] = [];
    const entry = {
      value: 'old-terminal-fixture',
      label: 'Old terminal fixture',
      hint: '',
      async runAuth(driver: SetupDriver) {
        expect(driver.mode).toBe('terminal');
        calls.push('auth');
      },
      async runInstallCheck(driver: SetupDriver) {
        expect(driver.mode).toBe('terminal');
        calls.push('check');
      },
    };

    await runSetupProviderAuth(entry, { mode: 'terminal' } as SetupDriver);
    expect(calls).toEqual(['auth', 'check']);
  });
});

describe('setup flow consumes the registry (structural)', () => {
  it('the picker renders the shared provider choices', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'setup', 'auto.ts'), 'utf-8');
    expect(src).toContain('listSetupProviderChoices()');
    expect(src).toContain("import './providers/index.js'");
    expect(src).toContain('NANOCLAW_AGENT_PROVIDER');
    // The capability-keyed branch — a provider's own auth runs iff it declares one.
    expect(src).toMatch(/providerEntry\?\.runAuth/);
    expect(src).toContain('await runSetupProviderAuth(providerEntry, driver);');
  });

  it('the provider preset is exposed as an env setup knob', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'setup', 'lib', 'setup-config.ts'), 'utf-8');
    expect(src).toContain('NANOCLAW_AGENT_PROVIDER');
    expect(src).toContain("key: 'agentProvider'");
  });

  it('the standalone provider-auth step is reachable from the STEPS map', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'setup', 'index.ts'), 'utf-8');
    expect(src).toContain("'provider-auth'");
    const auth = fs.readFileSync(path.join(process.cwd(), 'setup', 'provider-auth.ts'), 'utf-8');
    expect(auth).toContain("const driver = new TerminalSetupDriver('setup');");
    expect(auth).toContain('await runSetupProviderAuth(entry, driver);');
  });
});
