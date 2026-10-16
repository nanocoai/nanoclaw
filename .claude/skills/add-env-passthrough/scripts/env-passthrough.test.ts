import { describe, expect, it } from 'vitest';

import { parsePassthroughList, selectPassthrough } from '../payload/src/modules/env-passthrough/passthrough.js';

const neverSecret = () => false;

describe('parsePassthroughList', () => {
  it('splits on commas and whitespace, drops empties and duplicates', () => {
    expect(parsePassthroughList('A, B  C,,A\nD')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns an empty list for an unset or blank value', () => {
    expect(parsePassthroughList(undefined)).toEqual([]);
    expect(parsePassthroughList('  ')).toEqual([]);
  });
});

describe('selectPassthrough', () => {
  it('forwards listed names that have a value', () => {
    const { env, skipped } = selectPassthrough(['A', 'B'], { A: '1', B: '2' }, neverSecret);
    expect(env).toEqual({ A: '1', B: '2' });
    expect(skipped).toEqual([]);
  });

  it('reports unset names without throwing', () => {
    const { env, skipped } = selectPassthrough(['A', 'B'], { A: '1' }, neverSecret);
    expect(env).toEqual({ A: '1' });
    expect(skipped).toEqual([{ name: 'B', reason: 'unset' }]);
  });

  it('refuses invalid names', () => {
    const { env, skipped } = selectPassthrough(['1BAD', 'has-dash'], { '1BAD': 'x', 'has-dash': 'x' }, neverSecret);
    expect(env).toEqual({});
    expect(skipped.map((s) => s.reason)).toEqual(['invalid-name', 'invalid-name']);
  });

  it('refuses names the runtime or gateway owns, case-insensitively', () => {
    const names = ['ANTHROPIC_BASE_URL', 'NANOCLAW_X', 'PATH', 'https_proxy', 'LD_PRELOAD', 'TZ'];
    const values = Object.fromEntries(names.map((n) => [n, 'v']));
    const { env, skipped } = selectPassthrough(names, values, neverSecret);
    expect(env).toEqual({});
    expect(skipped.every((s) => s.reason === 'reserved-name')).toBe(true);
  });

  it('refuses whatever the secret classifier flags', () => {
    const { env, skipped } = selectPassthrough(['OK', 'LEAK'], { OK: '1', LEAK: 'secret' }, (_k, v) => v === 'secret');
    expect(env).toEqual({ OK: '1' });
    expect(skipped).toEqual([{ name: 'LEAK', reason: 'secret-shaped' }]);
  });
});
