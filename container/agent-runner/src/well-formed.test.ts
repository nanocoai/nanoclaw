import { describe, it, expect } from 'bun:test';

import {
  containsLoneSurrogate,
  isWellFormedText,
  toWellFormedText,
  truncateChars,
  truncateCharsTail,
  wellFormedError,
  wellFormedToolResult,
} from './well-formed.ts';

// A lone UTF-16 surrogate (e.g. an emoji truncated mid-pair, or already-corrupt
// platform text) makes the Anthropic API reject the whole request body with
// `400 ... no low surrogate in string`. These helpers stop that at the SOURCE
// (surrogate-safe truncation) and at the request boundary (sanitizers).
describe('toWellFormedText', () => {
  it('replaces a lone high surrogate with U+FFFD', () => {
    expect(toWellFormedText('hi \uD83D end')).toBe('hi � end');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    expect(toWellFormedText('x \uDC00 y')).toBe('x � y');
  });

  it('leaves a valid surrogate pair (emoji) intact', () => {
    const ok = 'wave 👋 done — accents áé ok';
    expect(toWellFormedText(ok)).toBe(ok);
  });

  it('handles a high surrogate at the very end of the string', () => {
    expect(toWellFormedText('trailing \uD83D')).toBe('trailing �');
  });

  it('is a no-op for plain ASCII', () => {
    expect(toWellFormedText('nothing to fix')).toBe('nothing to fix');
  });
});

describe('truncateChars (head, surrogate-safe)', () => {
  it('returns the input unchanged when it already fits', () => {
    expect(truncateChars('short', 10)).toBe('short');
  });

  it('does NOT split a surrogate pair at the boundary — drops the dangling high half', () => {
    // '👋' is two UTF-16 units; cutting at length 3 ('ab' + high half) must drop the half.
    const s = 'ab👋cd';
    const cut = truncateChars(s, 3);
    expect(cut).toBe('ab'); // not 'ab\uD83D'
    expect(toWellFormedText(cut)).toBe(cut); // already well-formed (no U+FFFD needed)
  });

  it('keeps a whole emoji when the boundary falls after the low half', () => {
    expect(truncateChars('ab👋cd', 4)).toBe('ab👋');
  });

  it('truncates plain text exactly at the limit', () => {
    expect(truncateChars('abcdef', 3)).toBe('abc');
  });

  it('returns empty for max <= 0 (never leaves a dangling half)', () => {
    expect(truncateChars('abc👋', 0)).toBe('');
    expect(truncateChars('abc👋', -1)).toBe(''); // Codex: -1 must not return 'abc\uD83D'
  });
});

describe('isWellFormedText / containsLoneSurrogate', () => {
  it('isWellFormedText flags a lone surrogate, passes a valid pair', () => {
    expect(isWellFormedText('ok 👋')).toBe(true);
    expect(isWellFormedText('bad \uD83D')).toBe(false);
  });

  it('containsLoneSurrogate walks nested structures', () => {
    expect(containsLoneSurrogate({ a: ['ok', { b: 'still 👋 ok' }] })).toBe(false);
    expect(containsLoneSurrogate({ a: ['ok', { b: 'bad \uDC00' }] })).toBe(true);
    expect(containsLoneSurrogate(42)).toBe(false);
    expect(containsLoneSurrogate(null)).toBe(false);
  });
});

describe('truncateCharsTail (tail window, surrogate-safe)', () => {
  it('does NOT start mid-pair — drops a leading low surrogate', () => {
    // tail of 3 from 'ab👋cd' would start on the low half of 👋; it must be dropped.
    const cut = truncateCharsTail('ab👋cd', 3);
    expect(cut).toBe('cd'); // not '\uDC4Bcd'
    expect(toWellFormedText(cut)).toBe(cut);
  });

  it('keeps a whole emoji when the window starts before the high half', () => {
    expect(truncateCharsTail('ab👋cd', 4)).toBe('👋cd');
  });
});

describe('wellFormedToolResult (recursive deep-sanitize)', () => {
  it('sanitizes content[].text and preserves other fields', () => {
    const result = { isError: false, content: [{ type: 'text', text: 'bad \uD83D end' }] };
    expect(wellFormedToolResult(result)).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'bad � end' }],
    });
  });

  it('sanitizes nested resource.text and structuredContent strings', () => {
    const result = {
      content: [{ type: 'resource', resource: { uri: 'x', text: 'r \uD83D z' } }],
      structuredContent: { note: 'sc \uDC00 ok' },
    };
    expect(wellFormedToolResult(result)).toEqual({
      content: [{ type: 'resource', resource: { uri: 'x', text: 'r � z' } }],
      structuredContent: { note: 'sc � ok' },
    });
  });

  it('leaves well-formed content untouched (value-equal)', () => {
    const result = { content: [{ type: 'text', text: 'ok 👋' }] };
    expect(wellFormedToolResult(result)).toEqual(result);
  });
});

// A thrown error message echoing malformed user/DB text propagates out of our
// MCP tool dispatch and is recorded by the SDK (PostToolUseFailure has no
// output-rewrite hook) — so a lone surrogate in the message would poison the
// NEXT request body. wellFormedError sanitizes the thrown message at our
// dispatch boundary (the reachable portion of that failure path).
describe('wellFormedError', () => {
  it('sanitizes a lone surrogate in the thrown Error message', () => {
    const out = wellFormedError(new Error('task "ab\uD83D" not found'));
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe('task "ab�" not found');
    expect(isWellFormedText((out as Error).message)).toBe(true);
  });

  it('returns the SAME error instance when the message is well-formed', () => {
    const err = new Error('clean error 👋');
    expect(wellFormedError(err)).toBe(err); // no allocation on the common path
  });

  it('handles a non-Error throw (string) with a lone surrogate', () => {
    const out = wellFormedError('boom \uDC00');
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe('boom �');
  });

  it('passes a well-formed non-Error throw through unchanged', () => {
    const thrown = { code: 'E_OK' };
    expect(wellFormedError(thrown)).toBe(thrown);
  });
});
