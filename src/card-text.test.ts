import { describe, expect, it } from 'vitest';

import { escapeInvisibles, fenceForCard, quoteForCard } from './card-text.js';

describe('escapeInvisibles', () => {
  it('escapes every bidi, zero-width, and separator character as \\uXXXX', () => {
    const invisibles = '\u202a\u202e\u2066\u2069\u200e\u200f\u061c\u200b\u200c\u200d\u2060\ufeff\u2028\u2029`';
    const out = escapeInvisibles(invisibles);
    for (const c of invisibles) expect(out).not.toContain(c);
    expect(out).toBe(
      '\\u202a\\u202e\\u2066\\u2069\\u200e\\u200f\\u061c\\u200b\\u200c\\u200d\\u2060\\ufeff\\u2028\\u2029\\u0060',
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeInvisibles('hello world -y evil [link](https://x)')).toBe('hello world -y evil [link](https://x)');
  });
});

describe('quoteForCard', () => {
  it('keeps a plain name readable inside quotes', () => {
    expect(quoteForCard('Group One')).toBe('"Group One"');
  });

  it('keeps a character reference from decoding, leaving a plain ampersand alone', () => {
    expect(quoteForCard('Eve&#10;x &amp; R&D')).toBe('"Eve\\u0026#10;x \\u0026amp; R&D"');
  });

  it('keeps a quoted value from opening a Markdown link', () => {
    expect(quoteForCard('[Approved](https://example.com ')).toBe('"[Approved]\\u0028https://example.com "');
  });

  it('keeps line breaks, fences and hidden characters visible on one line', () => {
    expect(quoteForCard('a\n```\n\u202eb')).toBe('"a\\n\\u0060\\u0060\\u0060\\n\\u202eb"');
  });
});

describe('fenceForCard', () => {
  it('keeps lines but escapes anything that could close the fence', () => {
    expect(fenceForCard('line one\n```\nline `two`')).toBe(
      '```\nline one\n\\u0060\\u0060\\u0060\nline \\u0060two\\u0060\n```',
    );
  });
});

describe('emoji joiner', () => {
  const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
  const rainbowFlag = '\u{1F3F3}\u{FE0F}\u200d\u{1F308}';
  const coder = '\u{1F469}\u{1F3FD}\u200d\u{1F4BB}';

  it('keeps a zero-width joiner that joins two emoji', () => {
    expect(escapeInvisibles(`${family} Team ${rainbowFlag} ${coder}`)).toBe(`${family} Team ${rainbowFlag} ${coder}`);
    expect(quoteForCard(`${family} Helper`)).toBe(`"${family} Helper"`);
  });

  it('escapes a joiner between reserved code points that are not assigned emoji', () => {
    expect(escapeInvisibles('\u{1FC00}\u200d\u{1FC01}')).toBe('\u{1FC00}\\u200d\u{1FC01}');
  });

  it('still escapes a joiner that is not between two emoji', () => {
    expect(escapeInvisibles('a\u200db \u{1F468}\u200dx \u200d\u{1F469}')).toBe(
      'a\\u200db \u{1F468}\\u200dx \\u200d\u{1F469}',
    );
  });
});

describe('fenceForCard with a limit', () => {
  it('cuts after escaping, never inside an escape or a surrogate pair', () => {
    // The cap includes the 13-character truncation mark.
    expect(fenceForCard('ab`cd' + 'x'.repeat(20), 18)).toBe('```\nab… (truncated)\n```');
    expect(fenceForCard('ab\u{1F468}' + 'x'.repeat(20), 16)).toBe('```\nab… (truncated)\n```');
  });

  it('leaves text within the limit alone', () => {
    expect(fenceForCard('short', 100)).toBe('```\nshort\n```');
  });
});
