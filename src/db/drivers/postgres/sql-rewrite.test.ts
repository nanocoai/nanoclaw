import { describe, expect, it } from 'vitest';

import { rewriteSql } from './sql-rewrite.js';

describe('PostgreSQL SQL placeholder rewriting', () => {
  it('rewrites positional placeholders in order', () => {
    expect(rewriteSql('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 2])).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2',
      values: ['x', 2],
    });
  });

  it('deduplicates repeated named placeholders and ignores extra keys', () => {
    expect(
      rewriteSql('UPDATE t SET value = @value WHERE id = @id OR parent_id = @id', [{ value: 'x', id: '1', extra: 2 }]),
    ).toEqual({
      text: 'UPDATE t SET value = $1 WHERE id = $2 OR parent_id = $2',
      values: ['x', '1'],
    });
  });

  it('skips quotes, comments, quoted identifiers, and dollar-quoted bodies', () => {
    const sql = `SELECT '?', "@column", $$ ? @body $$, $tag$ ? @body $tag$, ? -- ? @comment
      /* ? @block */`;
    expect(rewriteSql(sql, ['real'])).toEqual({
      text: sql.replace(', ? --', ', $1 --'),
      values: ['real'],
    });
  });

  it('fails on missing, extra, or mixed parameters', () => {
    expect(() => rewriteSql('SELECT ?', [])).toThrow('Missing positional parameter 1');
    expect(() => rewriteSql('SELECT 1', ['extra'])).toThrow('Expected 0 positional parameters');
    expect(() => rewriteSql('SELECT @missing', [{}])).toThrow('Missing named parameter "missing"');
    expect(() => rewriteSql('SELECT ?', [{ value: 1 }])).toThrow('Cannot use positional');
  });

  it('normalizes supported values and rejects unsafe implicit conversions', () => {
    expect(rewriteSql('SELECT ?, ?, ?', [undefined, 'a\0b', 1]).values).toEqual([null, 'ab', 1]);
    expect(() => rewriteSql('SELECT ?', [new Date()])).toThrow('ISO timestamp strings');
    expect(() => rewriteSql('SELECT ?', [true])).toThrow('domain integers');
    expect(() => rewriteSql('SELECT @value', [{ value: { nested: true } }])).toThrow(
      'Unsupported PostgreSQL parameter type',
    );
  });
});
