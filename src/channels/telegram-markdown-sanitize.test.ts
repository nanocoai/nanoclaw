import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('passes CommonMark **bold** through untouched for the adapter to convert', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('**Host path**');
  });

  it('passes CommonMark __bold__ through untouched for the adapter to convert', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('__label__');
  });

  it('leaves *italic* and _italic_ alone', () => {
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

  it('passes through unbalanced * — adapter handles it via CommonMark parsing', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a * b *c*');
  });

  it('passes through mixed _ — adapter handles it via CommonMark parsing', () => {
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('file_name has _one italic_');
  });

  it('strips brackets when unbalanced', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('leaves matched brackets (e.g. links) alone when counts balance', () => {
    const input = 'see [docs](https://example.com) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('converts list bullets and preserves code spans in a real message', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).toContain('**Host path**');
    expect(out).toContain('`~/projects/webapp`');
    expect(out).not.toContain('- **');
    expect(out).toContain('• **');
  });

  it('does not corrupt nested bold+italic like **title *italic***', () => {
    const input =
      '- **TODAY: Pope Leo XIV releases *Magnifica Humanitas*** at 5:30 PM PHT. **Christopher Olah** among the speakers.';
    const out = sanitizeTelegramLegacyMarkdown(input);
    // Both bold spans must survive intact for the adapter to convert correctly
    expect(out).toContain('**TODAY: Pope Leo XIV releases *Magnifica Humanitas***');
    expect(out).toContain('**Christopher Olah**');
  });

  it('percent-encodes underscores inside link URLs (Telegram "Can\'t find end of a URL" bug)', () => {
    const input = 'still developing. [Wikipedia](https://en.wikipedia.org/wiki/2026_Philippine_energy_crisis)';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(
      'still developing. [Wikipedia](https://en.wikipedia.org/wiki/2026%5FPhilippine%5Fenergy%5Fcrisis)',
    );
  });

  it('does not touch underscores in visible link text, only the URL', () => {
    const input = '[file_name.py](https://example.com/a_b)';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('[file_name.py](https://example.com/a%5Fb)');
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
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
