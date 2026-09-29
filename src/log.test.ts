import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';

describe('log never throws on unserializable data', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    const capture = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  });

  afterEach(() => vi.restoreAllMocks());

  const throwingTraps: ProxyHandler<object> = {
    get: () => {
      throw new Error('get trap');
    },
    ownKeys: () => {
      throw new Error('ownKeys trap');
    },
    getOwnPropertyDescriptor: () => {
      throw new Error('descriptor trap');
    },
  };

  it('logs a circular non-Error err value', () => {
    const err: Record<string, unknown> = { code: 'E_SINK' };
    err.self = err;
    expect(() => log.warn('sink failed', { err })).not.toThrow();
    expect(written.join('')).toContain('[Circular');
  });

  it('logs a circular value under any other key', () => {
    const node: Record<string, unknown> = { id: 1 };
    node.parent = { child: node };
    expect(() => log.error('bad node', { node })).not.toThrow();
    expect(written.join('')).toContain('[Circular');
  });

  it('logs BigInt values', () => {
    expect(() => log.warn('big', { err: 10n })).not.toThrow();
    expect(written.join('')).toContain('10n');
  });

  it('logs a value whose toJSON throws', () => {
    const hostile = {
      toJSON() {
        throw new Error('no');
      },
    };
    expect(() => log.warn('hostile', { err: hostile })).not.toThrow();
    expect(written.join('')).toContain('hostile');
  });

  it('survives a Proxy with throwing traps, as a value or as the data bag', () => {
    expect(() => log.warn('proxy value', { err: new Proxy({}, throwingTraps) })).not.toThrow();
    expect(() => log.warn('proxy bag', new Proxy({}, throwingTraps) as Record<string, unknown>)).not.toThrow();
    const out = written.join('');
    expect(out).toContain('proxy value');
    expect(out).toContain('proxy bag');
  });

  it('survives a throwing getter on the data bag itself', () => {
    const data = {
      ok: 1,
      get boom(): never {
        throw new Error('getter');
      },
    };
    expect(() => log.error('bag', data)).not.toThrow();
    expect(written.join('')).toContain('[log data unserializable]');
  });
});
