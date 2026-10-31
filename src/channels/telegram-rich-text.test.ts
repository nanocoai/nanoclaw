import { describe, expect, it } from 'vitest';

import { fixTelegramRichText } from './telegram-rich-text.js';

describe('fixTelegramRichText', () => {
  it('escapes dollar signs so prices are not read as inline math', () => {
    expect(fixTelegramRichText('MU ~$950 (-3.3% from $983.23)')).toBe('MU ~\\$950 (-3.3% from \\$983.23)');
  });

  it('leaves already-escaped dollars alone', () => {
    expect(fixTelegramRichText('cost \\$5')).toBe('cost \\$5');
  });

  it('does not touch inline code or fenced blocks', () => {
    expect(fixTelegramRichText('run `echo $HOME` for $5')).toBe('run `echo $HOME` for \\$5');
    const fenced = '```\necho $A\necho $B\n```';
    expect(fixTelegramRichText(fenced)).toBe(fenced);
  });

  it('turns single newlines between plain lines into hard breaks', () => {
    expect(fixTelegramRichText('**Pre-market**\n• S&P -0.5%\n• MU ~$950')).toBe(
      '**Pre-market**\\\n• S&P -0.5%\\\n• MU ~\\$950',
    );
  });

  it('keeps paragraph breaks and block starts as they are', () => {
    expect(fixTelegramRichText('One.\n\nTwo.')).toBe('One.\n\nTwo.');
    expect(fixTelegramRichText('Intro\n- a\n- b')).toBe('Intro\n- a\n- b');
    expect(fixTelegramRichText('## Head\nbody')).toBe('## Head\nbody');
    expect(fixTelegramRichText('| a |\n| b |')).toBe('| a |\n| b |');
    expect(fixTelegramRichText('text\n```\ncode\n```')).toBe('text\n```\ncode\n```');
  });

  it('does not double up an existing hard break', () => {
    expect(fixTelegramRichText('a\\\nb')).toBe('a\\\nb');
    expect(fixTelegramRichText('a  \nb')).toBe('a  \nb');
  });
});
