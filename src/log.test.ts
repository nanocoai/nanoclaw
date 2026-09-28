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

  it('logs a circular non-Error err value', () => {
    const err: Record<string, unknown> = { code: 'E_SINK' };
    err.self = err;
    expect(() => log.warn('sink failed', { err })).not.toThrow();
    expect(written.join('')).toContain('{"code":"E_SINK","self":"[Circular]"}');
  });

  it('logs a circular value under any other key', () => {
    const node: Record<string, unknown> = { id: 1 };
    node.parent = { child: node };
    expect(() => log.error('bad node', { node })).not.toThrow();
    expect(written.join('')).toContain('{"id":1,"parent":{"child":"[Circular]"}}');
  });

  it('logs BigInt values', () => {
    expect(() => log.warn('big', { err: 10n, size: { bytes: 42n } })).not.toThrow();
    const out = written.join('');
    expect(out).toContain('"10n"');
    expect(out).toContain('{"bytes":"42n"}');
  });

  it('does not mark a shared, non-circular reference as circular', () => {
    // The BigInt forces the fallback path, where the cycle check runs.
    const shared = { a: 1 };
    log.warn('shared', { pair: [shared, shared, 1n] });
    expect(written.join('')).toContain('[{"a":1},{"a":1},"1n"]');
  });

  it('falls back when even the replacer cannot serialize the value', () => {
    const hostile = {
      toJSON() {
        throw new Error('no');
      },
    };
    expect(() => log.warn('hostile', { err: hostile, bare: Object.create(null) })).not.toThrow();
    expect(written.join('')).toContain('[object Object]');
  });
});
