import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayProviderDefinition, GatewaySessionInput } from './gateway-provider-registry.js';

// Registry fixtures must not inherit the operator's installed gateway selection.
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

beforeEach(async () => {
  (await import('./index.js')).resetGatewayProvider(null);
});

afterEach(() => {
  delete process.env.NANOCLAW_GATEWAY_PROVIDER;
  vi.resetModules();
});

function fixture(kind: string, skills: readonly string[], calls: string[]): GatewayProviderDefinition {
  return {
    kind,
    agentSkills: skills,
    sessions: {
      async ensure(input, signal) {
        calls.push(`ensure:${input.runtimeIdentity}:${signal.aborted}`);
        return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
      },
    },
    approvals: {
      async subscribe(_decide, signal) {
        calls.push(`subscribe:${kind}`);
        if (signal.aborted) return;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    },
  };
}

const input: GatewaySessionInput = {
  key: { installSlug: 'test', agentGroupId: 'g1', sessionId: 's1' },
  runtimeIdentity: 'test/g1/s1',
  containerName: 'test-session',
  groupName: 'Fixture',
  capabilities: {} as never,
};

describe('gateway provider registry', () => {
  it('selects one declarative definition and uses the same ensure operation for every session state', async () => {
    process.env.NANOCLAW_GATEWAY_PROVIDER = 'active';
    const activeCalls: string[] = [];
    const inactiveCalls: string[] = [];
    const registry = await import('./gateway-provider-registry.js');
    registry.registerGatewayProvider(fixture('inactive', ['inactive-skill'], inactiveCalls));
    registry.registerGatewayProvider(fixture('active', ['active-skill'], activeCalls));

    const gateway = await import('./index.js');
    const selected = gateway.getGatewayProvider();
    const first = new AbortController();
    const surviving = new AbortController();
    await selected.sessions.ensure(input, first.signal);
    await selected.sessions.ensure(input, surviving.signal);
    const approvalSubscription = new AbortController();
    approvalSubscription.abort();
    await selected.approvals.subscribe(async () => 'deny', approvalSubscription.signal);

    expect(activeCalls).toEqual(['ensure:test/g1/s1:false', 'ensure:test/g1/s1:false', 'subscribe:active']);
    expect(inactiveCalls).toEqual([]);
    expect(gateway.selectGatewayAgentSkills(['welcome', 'inactive-skill'])).toEqual(['welcome', 'active-skill']);
  });

  it('fails closed when the selected registration is missing', async () => {
    process.env.NANOCLAW_GATEWAY_PROVIDER = 'missing';
    const gateway = await import('./index.js');
    expect(() => gateway.getGatewayProvider()).toThrow("no gateway provider is registered for 'missing'");
  });

  it('rejects duplicate kinds in the single registry', async () => {
    const registry = await import('./gateway-provider-registry.js');
    const definition = fixture('duplicate', [], []);
    registry.registerGatewayProvider(definition);
    expect(() => registry.registerGatewayProvider(definition)).toThrow('already registered');
  });

  it('fails closed when multiple registrations have no explicit selection', async () => {
    const registry = await import('./gateway-provider-registry.js');
    registry.registerGatewayProvider(fixture('first-choice', [], []));
    registry.registerGatewayProvider(fixture('second-choice', [], []));

    const gateway = await import('./index.js');
    expect(() => gateway.configuredGatewayProviderKind({})).toThrow(/Multiple gateway providers.*explicitly/);
  });

  it('keeps provider implementations outside NanoClaw orchestration registries', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const coreFiles = new Set(['gateway-provider-registry.ts', 'index.ts', 'installed.ts']);
    const forbidden = [
      'host-lifecycle',
      '/delivery',
      '/db/',
      'response-registry',
      'question-render-registry',
      '/cli/',
      'db/migrations',
    ];
    const providers = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !coreFiles.has(file));
    for (const file of providers) {
      const imports = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => /^import .* from /.test(line));
      expect(
        imports.filter((line) => forbidden.some((entry) => line.includes(entry))),
        file,
      ).toEqual([]);
    }

    const installed = fs.readFileSync(path.join(dir, 'installed.ts'), 'utf8');
    const installedModules = [...installed.matchAll(/^import ['"]\.\/(.+?)\.js['"];$/gm)].map((match) => match[1]);
    for (const module of installedModules) {
      const source = fs.readFileSync(path.join(dir, `${module}.ts`), 'utf8');
      expect(source.match(/registerGatewayProvider\(/g), module).toHaveLength(1);
    }
  });
});
