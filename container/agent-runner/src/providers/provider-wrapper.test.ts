import { describe, expect, it } from 'bun:test';

import { createProvider } from './factory.js';
import { registerProvider, registerProviderContract, registerProviderWrapper } from './provider-registry.js';
import { PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION } from '../provider-contracts/registry.js';
import type { AgentProvider, AgentQuery, ProviderOptions, QueryInput } from './types.js';

interface StubProvider extends AgentProvider {
  options: ProviderOptions;
}

function stubProvider(options: ProviderOptions): StubProvider {
  return {
    options,
    registerMemorySessionHook: () => {},
    query: (): AgentQuery => ({ push: () => {}, end: () => {}, abort: () => {}, events: (async function* () {})() }),
    isSessionInvalid: () => false,
  };
}

class TaggedProvider implements AgentProvider {
  constructor(
    readonly tag: string,
    readonly inner: AgentProvider,
  ) {}
  registerMemorySessionHook(...args: Parameters<AgentProvider['registerMemorySessionHook']>): void {
    this.inner.registerMemorySessionHook(...args);
  }
  query(input: QueryInput): AgentQuery {
    return this.inner.query(input);
  }
  isSessionInvalid(err: unknown): boolean {
    return this.inner.isSessionInvalid(err);
  }
}

let seq = 0;
function uniqueName(label: string): string {
  return `wrapper-${label}-${process.pid}-${seq++}`;
}

describe('registerProviderWrapper', () => {
  it('leaves construction unchanged when no wrapper is registered', () => {
    const name = uniqueName('none');
    registerProvider(name, (opts) => stubProvider(opts));
    const provider = createProvider(name, { model: 'base' }) as StubProvider;
    expect(provider).not.toBeInstanceOf(TaggedProvider);
    expect(provider.options.model).toBe('base');
  });

  it('applies a registered wrapper and hands it a factory for more unwrapped instances', () => {
    const name = uniqueName('applied');
    registerProvider(name, (opts) => stubProvider(opts));
    let created: StubProvider | undefined;
    registerProviderWrapper(name, (inner, context) => {
      expect(context.name).toBe(name);
      expect(context.options.model).toBe('base');
      created = context.create({ ...context.options, model: 'backup' }) as StubProvider;
      return new TaggedProvider('outer', inner);
    });

    const provider = createProvider(name, { model: 'base' });
    expect(provider).toBeInstanceOf(TaggedProvider);
    expect(((provider as TaggedProvider).inner as StubProvider).options.model).toBe('base');
    expect(created).not.toBeInstanceOf(TaggedProvider);
    expect(created?.options.model).toBe('backup');
  });

  it('composes several wrappers in registration order, even before the provider registers', () => {
    const name = uniqueName('order');
    registerProviderWrapper(name, (inner) => new TaggedProvider('first', inner));
    registerProviderWrapper(name, (inner) => new TaggedProvider('second', inner));
    registerProvider(name, (opts) => stubProvider(opts));

    const outer = createProvider(name) as TaggedProvider;
    expect(outer.tag).toBe('second');
    expect((outer.inner as TaggedProvider).tag).toBe('first');
  });

  it('attaches contract hooks to the wrapper, once per query', () => {
    const name = uniqueName('contract');
    let beforeQueryCalls = 0;
    registerProvider(name, (opts) => stubProvider(opts));
    registerProviderContract(name, {
      seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
      configuration: { executionPolicy: { constant: { boundary: 'container' } } },
      textDelivery: 'result',
      commands: { formatting: 'xml' },
      lifecycle: { beforeQuery: () => void beforeQueryCalls++ },
    });
    registerProviderWrapper(name, (inner) => new TaggedProvider('outer', inner));

    const provider = createProvider(name);
    provider.query({ prompt: 'hi', cwd: '/tmp' });
    expect(beforeQueryCalls).toBe(1);
  });
});
