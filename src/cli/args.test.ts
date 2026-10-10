import { describe, expect, it } from 'vitest';

import { normalizeArgs } from './args.js';

describe('normalizeArgs', () => {
  it('maps dashes to underscores and keeps values as given', () => {
    expect(normalizeArgs({ 'agent-group-id': 'a', engage_mode: 'x', 'dry-run': true, empty: '' })).toEqual({
      agent_group_id: 'a',
      engage_mode: 'x',
      dry_run: true,
      empty: '',
    });
  });

  it('is idempotent on canonical args', () => {
    const once = normalizeArgs({ 'agent-group-id': 'a', id: 'b' });
    expect(normalizeArgs(once)).toEqual(once);
  });

  it.each([
    [{ agent_group_id: 'a', 'agent-group-id': 'b' }],
    [{ 'agent-group-id': 'b', agent_group_id: 'a' }],
    [{ 'agent-group_id': 'a', 'agent_group-id': '' }],
    [{ 'a-b': { x: 1 }, a_b: { x: 1 } }],
  ])('rejects two spellings of one flag with different values: %j', (raw) => {
    expect(() => normalizeArgs(raw)).toThrow(/same flag/);
  });

  it('accepts two spellings carrying the identical value', () => {
    expect(normalizeArgs({ 'agent-group-id': 'a', agent_group_id: 'a' })).toEqual({ agent_group_id: 'a' });
  });

  it.each(['__proto__', '--proto--', '_-proto-_'])('rejects a key that canonicalizes to __proto__: %s', (key) => {
    const raw = JSON.parse(`{"${key}": {"cli_scope": "global"}}`);
    expect(() => normalizeArgs(raw)).toThrow(/not allowed/);
  });

  it.each([null, [], 'agent_group_id', 1])('rejects non-object args: %j', (raw) => {
    expect(() => normalizeArgs(raw as unknown as Record<string, unknown>)).toThrow(/must be an object/);
  });

  it('returns a plain object with no inherited keys', () => {
    const out = normalizeArgs({ a: 1 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as Record<string, unknown>).cli_scope).toBeUndefined();
  });
});
