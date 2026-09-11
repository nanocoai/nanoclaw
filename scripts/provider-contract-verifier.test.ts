import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isPinnedBunVersion,
  parseProviderContractVerifierArgs,
  runtimeConformanceTestPath,
  verifyProviderContracts,
} from './provider-contract-verifier.js';

const roots: string[] = [];

/**
 * A tree with the given providers' runtime conformance tests shipped. Claude
 * is the bare trunk's only declared contract, so it ships by default.
 */
function fixture(conformanceTests: string[] = ['claude']): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-contract-verifier-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src/provider-contracts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'container/agent-runner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/provider-contracts/index.ts'), '');
  fs.writeFileSync(path.join(root, 'container/Dockerfile'), 'ARG BUN_VERSION=1.3.12\n');
  for (const provider of conformanceTests) shipConformanceTest(root, provider);
  return root;
}

function shipConformanceTest(root: string, provider: string): void {
  const file = path.join(root, runtimeConformanceTestPath(provider));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('provider contract verifier', () => {
  it('accepts only the Bun version pinned by the container image', () => {
    const root = fixture();
    expect(isPinnedBunVersion(root, '1.3.12')).toBe(true);
    expect(isPinnedBunVersion(root, '1.3.14')).toBe(false);
  });

  it('uses the pinned Bun fallback and compares every contract inventory', async () => {
    const commands: string[] = [];
    const result = await verifyProviderContracts(fixture(), {
      commandAvailable: () => false,
      exec: (command) => {
        commands.push(command);
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude'],
            hostProviders: [],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude'] });
        }
      },
    });

    expect(result.status).toBe('passed');
    expect(commands).toContain('pnpm --package=bun@1.3.12 dlx bun install --frozen-lockfile');
    expect(commands).toContain(
      'pnpm exec vitest run src/provider-contracts src/providers setup/provider-contract.test.ts setup/providers',
    );
    expect(commands).toContain('pnpm --package=bun@1.3.12 dlx bun test src/provider-contracts src/providers');
    expect(result.checks.slice(-2)).toEqual(['runtime contract inventory', 'runtime conformance test files']);
  });

  it('passes when every declared runtime contract ships its conformance test', async () => {
    const result = await verifyProviderContracts(fixture(['claude', 'opencode']), {
      requiredDeclaredProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude', 'opencode'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude', 'opencode'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result.status).toBe('passed');
    expect(result.checks).toContain('runtime conformance test files');
  });

  it('rejects a declared runtime contract that ships no conformance test', async () => {
    // Probe fixtures are provider knowledge, so there is no generic sweep to
    // fall back on: a payload that forgot the file has an unproven contract.
    const result = await verifyProviderContracts(fixture(['claude']), {
      requiredDeclaredProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude', 'opencode'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude', 'opencode'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error:
        "Provider 'opencode' declares a runtime contract but ships no container/agent-runner/src/providers/opencode.conformance.test.ts",
    });
    expect(result.checks).not.toContain('runtime conformance test files');
  });

  it('accepts only explicitly expected fully undeclared legacy providers', async () => {
    const result = await verifyProviderContracts(fixture(), {
      expectedLegacyProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result.status).toBe('passed');
  });

  it.each([true, false])('requires Codex adoption alongside legacy OpenCode (declared=%s)', async (declared) => {
    const contracts = declared ? ['claude', 'codex'] : ['claude'];
    const result = await verifyProviderContracts(fixture(contracts), {
      expectedLegacyProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: contracts,
            hostProviders: ['codex', 'opencode'],
            setupProviders: ['claude', 'codex'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts, providers: ['claude', 'codex', 'opencode'] });
        }
      },
    });

    expect(result.status).toBe(declared ? 'passed' : 'failed');
    if (!declared) expect(result.error).toContain('actual=["codex","opencode"]');
  });

  it('allows an undeclared legacy provider when another provider is required to declare', async () => {
    const result = await verifyProviderContracts(fixture(['claude', 'codex']), {
      requiredDeclaredProviders: ['codex'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude', 'codex'],
            hostProviders: ['codex', 'opencode'],
            setupProviders: ['claude', 'codex'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude', 'codex'], providers: ['claude', 'codex', 'opencode'] });
        }
      },
    });

    expect(result.status).toBe('passed');
  });

  it('passes a required provider that declares host + runtime contracts but registers no setup picker entry', async () => {
    // A skill-only provider (kept out of the setup wizard on purpose) has no
    // setup/providers/<name>.ts — setup registration is optional, not a contract.
    const result = await verifyProviderContracts(fixture(['claude', 'opencode']), {
      requiredDeclaredProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude', 'opencode'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude', 'opencode'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result.status).toBe('passed');
  });

  it('requires every selected provider to declare its contract', async () => {
    const result = await verifyProviderContracts(fixture(), {
      requiredDeclaredProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result).toMatchObject({ status: 'failed', error: 'Required provider contracts missing: opencode' });
  });

  it('rejects a current provider with no contract', async () => {
    const result = await verifyProviderContracts(fixture(), {
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Undeclared legacy providers differ: expected=[], actual=["opencode"]',
    });
  });

  it('rejects partial contract adoption', async () => {
    const result = await verifyProviderContracts(fixture(), {
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude', 'opencode'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude', 'opencode'] });
        }
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Provider contract inventories differ');
  });

  it('rejects a legacy provider missing a runtime surface', async () => {
    const result = await verifyProviderContracts(fixture(), {
      expectedLegacyProviders: ['opencode'],
      commandAvailable: () => true,
      exec: (command) => {
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({
            host: ['claude'],
            hostProviders: ['opencode'],
            setupProviders: ['claude'],
          });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude'] });
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Runtime provider surface differs: expected=["claude","opencode"], actual=["claude"]',
    });
  });

  it('runs the OpenCode CLI pin guard when the skill installed it', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'src/opencode-cli-tools.test.ts'), '');
    const commands: string[] = [];

    const result = await verifyProviderContracts(root, {
      commandAvailable: () => true,
      exec: (command) => {
        commands.push(command);
        if (command.includes('provider-contract-names.ts')) {
          return JSON.stringify({ host: ['claude'], hostProviders: [], setupProviders: ['claude'] });
        }
        if (command.includes('src/provider-contracts/names.ts')) {
          return JSON.stringify({ contracts: ['claude'], providers: ['claude'] });
        }
      },
    });

    expect(result.status).toBe('passed');
    expect(commands).toContain(
      'pnpm exec vitest run src/provider-contracts src/providers setup/provider-contract.test.ts setup/providers src/opencode-cli-tools.test.ts',
    );
  });

  it('parses the provider required by an install skill', () => {
    expect(parseProviderContractVerifierArgs(['--required-declared', 'Codex, opencode'])).toEqual({
      requiredDeclaredProviders: ['codex', 'opencode'],
    });
    expect(() => parseProviderContractVerifierArgs(['--required-declared', ''])).toThrow(/at least one provider/);
    expect(() => parseProviderContractVerifierArgs(['--unknown'])).toThrow(/Usage/);
  });

  it('returns a structured blocking failure', async () => {
    const result = await verifyProviderContracts(fixture(), {
      commandAvailable: () => true,
      exec: (command) => {
        if (command === 'pnpm run build') throw new Error('compile failed');
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      checks: ['host dependencies', 'runtime dependencies'],
      error: 'compile failed',
    });
  });
});
