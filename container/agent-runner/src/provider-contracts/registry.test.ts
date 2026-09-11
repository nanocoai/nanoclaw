import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import { registerProvider } from '../providers/provider-registry.js';
import { readProviderTrace, runProviderAfterExchange, runProviderBeforeQuery } from './realize.js';
import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type Capability,
  type ProviderRuntimeContract,
  type RuntimeInferenceInput,
} from './registry.js';
import { getProviderRuntimeContract, hasDeclaredProviderRuntimeContract } from '../providers/provider-registry.js';
import {
  assertProviderRuntimeContractShape,
  probeProviderRuntimeConfiguration,
  type ProbeFixtures,
} from './verifier.js';

function registerCheckedProvider(name: string, contract: ProviderRuntimeContract, probes?: ProbeFixtures): void {
  assertProviderRuntimeContractShape(name, contract);
  probeProviderRuntimeConfiguration(name, contract, probes);
  registerProvider(name, {
    create: () => ({
      registerMemorySessionHook: () => {},
      query: () => {
        throw new Error('unused');
      },
      isSessionInvalid: () => false,
    }),
    contract,
  });
}

function emptyContract(): ProviderRuntimeContract {
  return {
    seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
    configuration: {
      executionPolicy: () => ({ boundary: 'container' }),
      inference: (input) => ({ model: input.model, effort: input.effort }),
      memory: (input) => ({ command: input.command }),
      mcpServers: (input) => ({ servers: Object.keys(input) }),
    },
    textDelivery: 'result',
    commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
  };
}

function contractName(field: string, suffix: string): string {
  return `runtime-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

/** Narrow a capability to its function form (the test knows which form the contract declared). */
function asFunction<I>(capability: Capability<I> | undefined): (input: I, environment: NodeJS.ProcessEnv) => unknown {
  if (typeof capability !== 'function') throw new Error('expected a function capability');
  return capability;
}

function asConstant<I>(capability: Capability<I> | undefined): unknown {
  if (typeof capability !== 'object') throw new Error('expected a constant capability');
  return capability.constant;
}

describe('provider runtime contracts', () => {
  it('loads the complete Claude implementation from the provider registration', () => {
    const contract = getProviderRuntimeContract('claude');
    expect(contract).toBeDefined();

    expect(typeof contract?.configuration.executionPolicy).toBe('object');
    expect(asConstant(contract?.configuration.executionPolicy)).toBeDefined();
    expect(typeof contract?.configuration.inference).toBe('function');
    expect(typeof contract?.configuration.mcpServers).toBe('function');
    expect(typeof contract?.configuration.memory).toBe('object');
    expect(asConstant(contract?.configuration.memory)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(typeof contract?.lifecycle?.memorySessionHookRegistration).toBe('function');
    expect(typeof contract?.history?.readTrace).toBe('function');
    expect(contract?.history?.afterExchange).toBeUndefined();
    expect(contract?.textDelivery).toBe('mid-turn-complete');
    expect(contract?.commands.formatting).toBe('native');
    expect(contract?.seamVersion).toBe(PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION);
    expect(hasDeclaredProviderRuntimeContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderRuntimeContract('legacy')).toBe(false);
  });

  it('resolves Claude execution policy, inference, and MCP config through the contract functions', () => {
    const contract = getProviderRuntimeContract('claude')!;
    const policy = asConstant(contract.configuration.executionPolicy) as {
      permissionMode: string;
      disallowedTools: string[];
    };
    expect(policy.permissionMode).toBe('bypassPermissions');
    expect(policy.disallowedTools).toContain('AskUserQuestion');

    const inference = asFunction(contract.configuration.inference)(
      { model: 'opus', effort: 'high', speed: 'fast' },
      {},
    );
    expect(inference).toEqual({ model: 'opus', effort: 'high', settings: { fastMode: true } });

    const mcp = asFunction(contract.configuration.mcpServers)({ nanoclaw: { command: 'bun' } }, {}) as {
      allowedTools: string[];
    };
    expect(mcp.allowedTools).toContain('mcp__nanoclaw__*');
  });

  it('rejects duplicate registrations', () => {
    const name = `runtime-contract-${process.pid}`;
    registerCheckedProvider(name, emptyContract());
    expect(() => registerCheckedProvider(name, emptyContract())).toThrow(/already registered/);
  });

  it('rejects non-kebab-case provider names', () => {
    expect(() => registerCheckedProvider('Runtime Bad Name', emptyContract())).toThrow(/kebab-case/);
  });

  it('rejects mixed-version provider contracts with an operator fix', () => {
    const contract = emptyContract();
    contract.seamVersion = 0;
    expect(() => registerCheckedProvider(contractName('seam-version', 'old'), contract)).toThrow(/run \/update-skills/);
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `runtime-immutable-${process.pid}`;
    registerCheckedProvider(name, emptyContract());
    const stored = getProviderRuntimeContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin!)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it('allows omitted and constant optional capabilities', () => {
    const contract = emptyContract();
    delete contract.configuration.memory;
    contract.configuration.mcpServers = { constant: {} };
    registerCheckedProvider(contractName('configuration-optional', 'valid'), contract);
  });

  it('rejects declared capabilities that are neither a function nor a constant', () => {
    const contract = emptyContract();
    contract.configuration.inference = {} as unknown as Capability<RuntimeInferenceInput>;
    expect(() => registerCheckedProvider(contractName('configuration-empty', 'invalid'), contract)).toThrow(
      /configuration\.inference must be a function or \{ constant \}/,
    );
  });

  it('rejects a missing execution policy', () => {
    const contract = emptyContract();
    delete (contract.configuration as { executionPolicy?: unknown }).executionPolicy;
    expect(() => registerCheckedProvider(contractName('execution-policy', 'missing'), contract)).toThrow(
      /configuration\.executionPolicy is required/,
    );
  });

  it('rejects a missing configuration block', () => {
    const missingBlock = emptyContract() as unknown as { configuration?: unknown };
    delete missingBlock.configuration;
    expect(() =>
      registerCheckedProvider(contractName('configuration-block', 'missing'), missingBlock as ProviderRuntimeContract),
    ).toThrow(/configuration is required/);
  });

  it('rejects invalid lifecycle and history declarations', () => {
    expect(() =>
      registerCheckedProvider(contractName('lifecycle-before-query', 'invalid'), {
        ...emptyContract(),
        lifecycle: {
          beforeQuery: 'bad' as unknown as NonNullable<ProviderRuntimeContract['lifecycle']>['beforeQuery'],
        },
      }),
    ).toThrow(/lifecycle\.beforeQuery must be a function/);

    expect(() =>
      registerCheckedProvider(contractName('history-after-exchange', 'invalid'), {
        ...emptyContract(),
        history: {
          afterExchange: 'bad' as unknown as NonNullable<ProviderRuntimeContract['history']>['afterExchange'],
        },
      }),
    ).toThrow(/history\.afterExchange must be a function/);

    expect(() =>
      registerCheckedProvider(contractName('history-read-trace', 'invalid'), {
        ...emptyContract(),
        history: {
          readTrace: 'bad' as unknown as NonNullable<ProviderRuntimeContract['history']>['readTrace'],
        },
      }),
    ).toThrow(/history\.readTrace must be a function/);
  });

  it('rejects invalid text delivery and command declarations', () => {
    expect(() =>
      registerCheckedProvider(contractName('text-delivery', 'invalid'), {
        ...emptyContract(),
        textDelivery: 'invalid' as ProviderRuntimeContract['textDelivery'],
      }),
    ).toThrow(/textDelivery/);

    expect(() =>
      registerCheckedProvider(contractName('commands-formatting', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'invalid' as 'xml', nativeAdmin: [], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.formatting/);

    expect(() =>
      registerCheckedProvider(contractName('commands-native', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'xml', nativeAdmin: ['bad command'], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.nativeAdmin/);
  });

  describe('configuration probes', () => {
    it('rejects a function capability that ignores its configuration input', () => {
      const contract = emptyContract();
      contract.configuration.inference = () => ({ fixed: true });
      expect(() => registerCheckedProvider(contractName('probe-insensitive', 'invalid'), contract)).toThrow(
        /configuration\.inference does not respond to its configuration input/,
      );
    });

    it('rejects a function capability that produces no value', () => {
      const contract = emptyContract();
      contract.configuration.executionPolicy = () => undefined;
      expect(() => registerCheckedProvider(contractName('probe-undefined', 'invalid'), contract)).toThrow(
        /configuration\.executionPolicy must produce a value/,
      );
    });

    it('rejects a constant capability with no value', () => {
      const contract = emptyContract();
      contract.configuration.inference = { constant: undefined };
      expect(() => registerCheckedProvider(contractName('constant-undefined', 'invalid'), contract)).toThrow(
        /configuration\.inference\.constant must be a value/,
      );
    });

    it('does not probe a constant capability', () => {
      const contract = emptyContract();
      contract.configuration.inference = { constant: { fixed: true } };
      registerCheckedProvider(contractName('constant-unprobed', 'valid'), contract);
    });

    it('honors probe fixtures and probe environments passed by the caller', () => {
      const seenEnvironments: Array<Record<string, string | undefined>> = [];
      const effortOnly = (input: RuntimeInferenceInput, environment: NodeJS.ProcessEnv): unknown => {
        seenEnvironments.push({ ...environment });
        return { effort: input.effort ?? 'none' };
      };

      const withoutProbes = emptyContract();
      withoutProbes.configuration.inference = effortOnly;
      expect(() => registerCheckedProvider(contractName('probe-defaults-miss', 'invalid'), withoutProbes)).toThrow(
        /configuration\.inference does not respond/,
      );

      const withProbes = emptyContract();
      withProbes.configuration.inference = effortOnly;
      registerCheckedProvider(contractName('probe-defaults-hit', 'valid'), withProbes, {
        inference: { a: { effort: 'low' }, b: { effort: 'high' }, environment: { NANOCLAW_PROBE: 'set' } },
      });
      expect(seenEnvironments.at(-1)?.NANOCLAW_PROBE).toBe('set');
    });
  });

  it('runs provider-owned before-query lifecycle callbacks', () => {
    const name = `runtime-before-query-${process.pid}`;
    const calls: unknown[] = [];
    registerCheckedProvider(name, {
      ...emptyContract(),
      lifecycle: { beforeQuery: (inputs, context) => calls.push({ inputs, context }) },
    });
    const inputs = { inference: { model: 'opus' } };
    runProviderBeforeQuery(name, inputs, { turn: 1 });
    expect(calls).toEqual([{ inputs, context: { turn: 1 } }]);
  });

  it('runs provider-owned after-exchange callbacks', () => {
    const name = `runtime-after-exchange-${process.pid}`;
    const calls: unknown[] = [];
    registerCheckedProvider(name, {
      ...emptyContract(),
      history: {
        afterExchange: (input, fx) => {
          calls.push({ input, now: fx.now() });
          return 'exchange.md';
        },
      },
    });
    expect(runProviderAfterExchange(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
      'exchange.md',
    );
    expect(calls).toHaveLength(1);
  });

  it('reads Claude traces through the provider-owned history callback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-trace-home-${process.pid}-`));
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const homeTrace = path.join(home, '.claude', 'projects', 'home-project', 'home.jsonl');
    const configTrace = path.join(config, 'projects', 'config-project', 'config.jsonl');
    fs.mkdirSync(path.dirname(homeTrace), { recursive: true });
    fs.mkdirSync(path.dirname(configTrace), { recursive: true });
    fs.writeFileSync(homeTrace, '{}\n');
    fs.writeFileSync(configTrace, '{}\n');
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);

    try {
      expect(readProviderTrace('claude')).toBe(homeTrace);
    } finally {
      homedirSpy.mockRestore();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
