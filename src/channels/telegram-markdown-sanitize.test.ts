import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('downgrades CommonMark **bold** to legacy *bold*', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('*Host path*');
  });

  it('downgrades CommonMark __bold__ to legacy _italic_', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('_label_');
  });

  it('leaves balanced legacy *bold* and _italic_ alone', () => {
    expect(sanitizeTelegramLegacyMarkdown('a *b* c _d_ e')).toBe('a *b* c _d_ e');
  });

  it('preserves inline code spans untouched', () => {
    const input = 'see `file_name.py` and `**not bold**` here';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\nfoo_bar **baz**\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('strips formatting chars on odd delimiter count (unbalanced *)', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a  b c');
  });

  it('strips formatting chars on odd delimiter count (unbalanced _)', () => {
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('filename has one italic');
  });

  it('strips brackets when unbalanced', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('leaves matched brackets (e.g. links) alone when counts balance', () => {
    const input = 'see [docs](https://example.com) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('fixes the real failing message', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    expect(out).toContain('*Host path*');
    expect(out).toContain('`~/projects/webapp`');
    expect((out.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
  });

  it('wraps a bare URL containing an underscore, percent-encoding it in the destination only', () => {
    // The label keeps the human-readable underscore (the adapter's own
    // markdown round-trip backslash-escapes it there); the destination is
    // percent-encoded so @chat-adapter/telegram's post-render safe-boundary
    // trim (a *different*, upstream bug — see the file header) doesn't see
    // an unescaped `_` and truncate the message right before the link.
    const input = 'MR created: https://gitlab.com/lizo-ai/lizo-UI/-/merge_requests/453';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(
      'MR created: [https://gitlab.com/lizo-ai/lizo-UI/-/merge_requests/453](https://gitlab.com/lizo-ai/lizo-UI/-/merge%5Frequests/453)',
    );
  });

  it('protects a wrapped URL from the odd-underscore-count stripping pass', () => {
    // One stray underscore elsewhere makes the total count odd; the URL's
    // own underscore must not be stripped as collateral damage.
    const input = 'file_name and https://gitlab.com/x/-/merge_requests/1';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).toContain('merge_requests'); // label — human-readable
    expect(out).toContain('[https://gitlab.com/x/-/merge_requests/1](https://gitlab.com/x/-/merge%5Frequests/1)');
  });

  it('does not re-wrap a URL already inside a markdown link, but still percent-encodes its destination', () => {
    const input = 'see [docs](https://example.com/a_b) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('see [docs](https://example.com/a%5Fb) for more');
  });

  it('percent-encodes *, ~, and ` in a link destination too, not just _', () => {
    const input = 'see [docs](https://example.com/a*b~c`d) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('see [docs](https://example.com/a%2Ab%7Ec%60d) for more');
  });

  it('leaves a URL already inside a code span untouched', () => {
    const input = 'see `https://example.com/merge_requests/1` for the raw link';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('replaces dash list bullets with • so the adapter does not re-emit `*` markers', () => {
    expect(sanitizeTelegramLegacyMarkdown('- one\n- two')).toBe('• one\n• two');
  });

  it('preserves indented list structure', () => {
    expect(sanitizeTelegramLegacyMarkdown('  - nested')).toBe('  • nested');
  });

  it('flattens Markdown horizontal rules (---, ***, ___)', () => {
    const input = 'before\n---\n***\n___\nafter';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('before\n⎯⎯⎯\n⎯⎯⎯\n⎯⎯⎯\nafter');
  });

  it('leaves horizontal rules inside code blocks alone', () => {
    const input = '```\n---\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });
});
