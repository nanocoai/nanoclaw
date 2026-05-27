import { describe, expect, test } from 'bun:test';

import { mcpDisallowPatterns } from './claude.js';

describe('mcpDisallowPatterns', () => {
  test('returns empty array when disabledTools is undefined', () => {
    expect(mcpDisallowPatterns('foo', undefined)).toEqual([]);
  });

  test('returns empty array when disabledTools is empty', () => {
    expect(mcpDisallowPatterns('foo', [])).toEqual([]);
  });

  test('builds mcp__<server>__<tool> patterns', () => {
    expect(mcpDisallowPatterns('foo', ['login', 'logout'])).toEqual([
      'mcp__foo__login',
      'mcp__foo__logout',
    ]);
  });

  test('sanitizes server names the same way the SDK does', () => {
    // SDK rewrites any char outside [A-Za-z0-9_-] to '_'. The allow pattern
    // already follows this rule; the disallow patterns must match or the
    // hook check would miss the tool at runtime.
    expect(mcpDisallowPatterns('my.server', ['tool-a'])).toEqual(['mcp__my_server__tool-a']);
    expect(mcpDisallowPatterns('a/b c', ['x'])).toEqual(['mcp__a_b_c__x']);
  });

  test('preserves hyphens and underscores in server names and tool names', () => {
    expect(mcpDisallowPatterns('my-server_v2', ['list-things', 'do_stuff'])).toEqual([
      'mcp__my-server_v2__list-things',
      'mcp__my-server_v2__do_stuff',
    ]);
  });
});
