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

  it('honors a top-level toJSON whose result holds a BigInt', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        return { id: 1n };
      },
    };
    expect(() => log.warn('redacted', { err: value })).not.toThrow();
    const out = written.join('');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('passes the root key to toJSON, as JSON.stringify does', () => {
    const value = {
      token: 'SECRET',
      toJSON(key: string) {
        return key === '' ? { id: 1n } : this;
      },
    };
    log.warn('keyed', { err: value });
    expect(written.join('')).not.toContain('SECRET');
  });

  it('never prints the raw value when toJSON throws', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        throw new Error('no');
      },
    };
    expect(() => log.warn('throwing toJSON', { err: value })).not.toThrow();
    const out = written.join('');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('[unserializable]');
  });

  it('keeps other fields, but not the value, when a toJSON getter throws', () => {
    const err = {
      token: 'SECRET',
      get toJSON(): never {
        throw new Error('getter');
      },
    };
    log.warn('getter toJSON', { requestId: 'req-123', err });
    const out = written.join('');
    expect(out).toContain('req-123');
    expect(out).not.toContain('SECRET');
  });

  it('does not call toJSON twice', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        delete (this as { toJSON?: unknown }).toJSON;
        return { id: 1n };
      },
    };
    log.warn('once', { err: value });
    const out = written.join('');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('keeps fields four levels deep next to a BigInt', () => {
    const err = { n: 1n, a: { b: { c: { d: { code: 'E_DEEP' } } } } };
    log.warn('deep', { err });
    expect(written.join('')).toContain('E_DEEP');
  });

  const redactor = () => ({
    token: 'SECRET',
    toJSON() {
      return { token: '[redacted]' };
    },
  });

  it('honors a nested toJSON when a sibling is a BigInt', () => {
    log.warn('nested bigint', { err: { creds: redactor(), n: 1n } });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('honors a nested toJSON when the value has a cycle', () => {
    const err: Record<string, unknown> = { creds: redactor() };
    err.self = err;
    log.warn('nested cycle', { err });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).toContain('[Circular');
    expect(out).not.toContain('SECRET');
  });

  it('does not mark a shared, non-circular reference as circular', () => {
    const x = { a: 1 };
    log.warn('shared', { v: { p: x, q: x, r: [x] }, n: 1n });
    expect(written.join('')).not.toContain('[Circular');
  });

  it('marks a cycle inside a toJSON result', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        const o: Record<string, unknown> = { token: '[redacted]' };
        o.self = o;
        return o;
      },
    };
    log.warn('toJSON cycle', { err: { creds: value } });
    const out = written.join('');
    expect(out).toContain('[Circular');
    expect(out).not.toContain('SECRET');
  });

  it('honors a top-level toJSON', () => {
    log.warn('top-level', { err: redactor() });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('SECRET');
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

describe('log prints errors in full', () => {
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

  const refused = () =>
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      config: { headers: { Authorization: 'Bearer SECRET' } },
    });

  it('prints the cause chain and diagnostic fields of `err`', () => {
    log.error('Delivery failed', { err: new Error('adapter send failed', { cause: refused() }) });
    const out = written.join('');
    expect(out).toContain('message: "adapter send failed"');
    expect(out).toContain('caused by: { type: "Error", message: "connect ECONNREFUSED 127.0.0.1:8080"');
    expect(out).toContain('"code":"ECONNREFUSED"');
    expect(out).toMatch(/at .*log\.test\.ts/);
  });

  it('prints an Error under any other key, or nested, instead of {}', () => {
    log.warn('Fallback failed', { fallbackErr: refused(), result: { error: new Error('deep reason') } });
    const out = written.join('');
    expect(out).toContain('connect ECONNREFUSED');
    expect(out).toContain('deep reason');
    expect(out).not.toMatch(/fallbackErr\S*=\{\}/);
  });

  it('lists AggregateError members', () => {
    log.error('All attempts failed', {
      err: new AggregateError([new Error('first'), new Error('second')], 'all failed'),
    });
    const out = written.join('');
    expect(out).toContain('error[0]: { type: "Error", message: "first"');
    expect(out).toContain('error[1]: { type: "Error", message: "second"');
  });

  it('never prints fields outside the allowlist, or secret-looking keys inside them', () => {
    const err = Object.assign(new Error('rejected'), { status: { code: 401, apiKey: 'SECRET' } });
    log.error('Request failed', { err, other: refused() });
    const out = written.join('');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('"apiKey":"[redacted]"');
  });

  it('stops on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => log.error('cycle', { err: a, nested: { a } })).not.toThrow();
  });
});
