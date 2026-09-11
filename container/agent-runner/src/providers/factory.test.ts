import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import './index.js';
import '../provider-contracts/index.js';
import {
  getProviderRuntimeContract,
  registerProvider,
  registerProviderContract,
  requireProviderName,
} from './provider-registry.js';
import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type ProviderRuntimeContract,
  type ResolvedRuntimeConfiguration,
} from '../provider-contracts/registry.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import type { AgentProvider, ProviderOptions } from './types.js';

function stubProvider(): AgentProvider {
  return {
    registerMemorySessionHook: () => {},
    query: () => {
      throw new Error('unused');
    },
    isSessionInvalid: () => false,
  };
}

function minimalContract(): ProviderRuntimeContract {
  return {
    seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
    configuration: { executionPolicy: { constant: { boundary: 'container' } } },
    textDelivery: 'result',
    commands: { formatting: 'xml' },
  };
}

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus')).toThrow(/Unknown provider/);
  });

  it('attaches a contract registered before its provider', () => {
    const name = `two-step-contract-first-${process.pid}`;
    const contract = minimalContract();
    registerProviderContract(name, contract);
    expect(getProviderRuntimeContract(name)).toBeUndefined();
    registerProvider(name, () => stubProvider());
    expect(getProviderRuntimeContract(name)).toBe(contract);
  });

  it('attaches a contract registered after its provider', () => {
    const name = `two-step-provider-first-${process.pid}`;
    const contract = minimalContract();
    registerProvider(name, () => stubProvider());
    expect(getProviderRuntimeContract(name)).toBeUndefined();
    registerProviderContract(name, contract);
    expect(getProviderRuntimeContract(name)).toBe(contract);
  });

  it('rejects a second contract for the same provider in either order', () => {
    const attached = `two-step-duplicate-attached-${process.pid}`;
    registerProvider(attached, { create: () => stubProvider(), contract: minimalContract() });
    expect(() => registerProviderContract(attached, minimalContract())).toThrow(/contract already registered/);

    const pending = `two-step-duplicate-pending-${process.pid}`;
    registerProviderContract(pending, minimalContract());
    expect(() => registerProviderContract(pending, minimalContract())).toThrow(/contract already registered/);
    expect(() => registerProvider(pending, { create: () => stubProvider(), contract: minimalContract() })).toThrow(
      /contract already registered/,
    );
  });

  it('resolves the declared configuration itself and hands it to the provider factory', () => {
    const name = `factory-configuration-${process.pid}`;
    const seen: Array<{ options: ProviderOptions; configuration?: ResolvedRuntimeConfiguration }> = [];
    const memorySeen: unknown[] = [];
    registerProvider(name, {
      create: (options, configuration) => {
        seen.push({ options, configuration });
        return { ...stubProvider(), registerMemorySessionHook: (_hook, memory) => memorySeen.push(memory) };
      },
      contract: {
        seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
        configuration: {
          executionPolicy: (_input, environment) => ({ home: environment.HOME ?? null }),
          inference: (input) => ({ chosen: input.model ?? 'default' }),
          memory: (hook) => ({ hookCommand: hook.command }),
          mcpServers: { constant: { fixed: true } },
        },
        textDelivery: 'result',
        commands: { formatting: 'xml' },
      },
    });

    const provider = createProvider(name, { model: 'opus', mcpServers: { ignored: { command: 'x' } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.configuration).toEqual({
      executionPolicy: { home: process.env.HOME ?? null },
      inference: { chosen: 'opus' },
      mcpServers: { fixed: true },
    });

    // memory resolves when core registers the hook, with the hook as input.
    registerProviderMemorySessionHook(name, provider, {
      command: 'run-hook',
      legacyCommands: [],
      sources: ['startup'],
    });
    expect(memorySeen).toEqual([{ hookCommand: 'run-hook' }]);
  });

  it('hands Claude the core-resolved configuration (no provider-side resolve)', () => {
    const provider = createProvider('claude', {
      mcpServers: { 'custom.server': { command: 'custom-server' } },
    }) as unknown as {
      mcp: { allowedTools: string[] };
      executionPolicy: { permissionMode: string };
    };
    expect(provider.mcp.allowedTools).toContain('mcp__custom_server__*');
    expect(provider.executionPolicy.permissionMode).toBe('bypassPermissions');
  });

  it('normalizes and validates the selected provider before startup', () => {
    expect(requireProviderName('CLAUDE')).toBe('claude');
    expect(() => requireProviderName('bogus')).toThrow(/Unknown provider/);
  });

  it('dispatches provider-owned contract callbacks without calling provider fallbacks', () => {
    const name = `factory-core-owner-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversations = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversations;
    let fallbackCalls = 0;
    let exchangePlannerCalls = 0;
    let beforeQueryCalls = 0;

    registerProvider(name, {
      create: () => ({
        registerMemorySessionHook: () => {},
        onExchangeComplete: () => fallbackCalls++,
        // Continuation rotation is provider-internal, so the instance method
        // is the only implementation; the factory does not wrap it.
        maybeRotateContinuation: () => 'rotate',
        query: () => {
          throw new Error('unused');
        },
        isSessionInvalid: () => false,
      }),
      contract: {
        seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
        configuration: {
          executionPolicy: { constant: { boundary: 'container' } },
          inference: (input) => ({ model: input.model }),
          memory: (input) => ({ command: input.command }),
          mcpServers: (input) => ({ servers: Object.keys(input) }),
        },
        lifecycle: {
          beforeQuery: () => {
            beforeQueryCalls++;
          },
        },
        history: {
          afterExchange: () => {
            exchangePlannerCalls++;
            fs.mkdirSync(conversations, { recursive: true });
            fs.writeFileSync(path.join(conversations, 'exchange.md'), 'archived\n');
            return 'exchange.md';
          },
        },
        textDelivery: 'result',
        commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
      },
    });

    try {
      const provider = createProvider(name);
      provider.onExchangeComplete?.({ prompt: 'hello', result: 'world', status: 'completed' });
      const archiveCalls = exchangePlannerCalls;
      expect(provider.maybeRotateContinuation?.('session', '/unused')).toBe('rotate');
      expect(() => provider.query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(/unused/);
      expect(fs.readFileSync(path.join(conversations, 'exchange.md'), 'utf8')).toBe('archived\n');
      expect(exchangePlannerCalls).toBe(archiveCalls);
      expect(fallbackCalls).toBe(0);
      expect(beforeQueryCalls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
