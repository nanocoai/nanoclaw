import { describe, expect, it } from 'vitest';

import { parseIncognitoCommand, rewriteContentText } from './incognito.js';

/** Build a channel content blob the way adapters do. */
function content(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ text, ...extra });
}

describe('parseIncognitoCommand', () => {
  it('bare /incognito starts with empty body', () => {
    expect(parseIncognitoCommand(content('/incognito'))).toEqual({ kind: 'start', body: '' });
  });

  it('/incognito <message> starts with the stripped body', () => {
    expect(parseIncognitoCommand(content('/incognito what is the capital of France'))).toEqual({
      kind: 'start',
      body: 'what is the capital of France',
    });
  });

  it('/incognito end ends', () => {
    expect(parseIncognitoCommand(content('/incognito end'))).toEqual({ kind: 'end', body: '' });
  });

  it('/exit and /endincognito are end aliases', () => {
    expect(parseIncognitoCommand(content('/exit')).kind).toBe('end');
    expect(parseIncognitoCommand(content('/endincognito')).kind).toBe('end');
  });

  it('is case-insensitive on the command token', () => {
    expect(parseIncognitoCommand(content('/INCOGNITO Hi'))).toEqual({ kind: 'start', body: 'Hi' });
    expect(parseIncognitoCommand(content('/Exit')).kind).toBe('end');
  });

  it('trims leading/surrounding whitespace', () => {
    expect(parseIncognitoCommand(content('   /incognito   spaced   '))).toEqual({ kind: 'start', body: 'spaced' });
  });

  it('only exact "end" after /incognito is an end; anything else is a start body', () => {
    expect(parseIncognitoCommand(content('/incognito end the meeting'))).toEqual({
      kind: 'start',
      body: 'end the meeting',
    });
  });

  it('does not match a prefixed word like /incognitofoo', () => {
    expect(parseIncognitoCommand(content('/incognitofoo')).kind).toBe('none');
  });

  it('plain text and other slash commands are none', () => {
    expect(parseIncognitoCommand(content('hello there')).kind).toBe('none');
    expect(parseIncognitoCommand(content('/help')).kind).toBe('none');
  });

  it('handles non-JSON content by treating it as raw text', () => {
    expect(parseIncognitoCommand('/incognito raw')).toEqual({ kind: 'start', body: 'raw' });
  });

  it('empty text is none', () => {
    expect(parseIncognitoCommand(content('')).kind).toBe('none');
  });
});

describe('rewriteContentText', () => {
  it('replaces .text and preserves other fields', () => {
    const original = content('/incognito hello', { sender: 'Ann', senderId: 'u:1' });
    const rewritten = JSON.parse(rewriteContentText(original, 'hello'));
    expect(rewritten).toEqual({ text: 'hello', sender: 'Ann', senderId: 'u:1' });
  });

  it('falls back to a bare {text} blob for non-JSON input', () => {
    expect(JSON.parse(rewriteContentText('not json', 'hi'))).toEqual({ text: 'hi' });
  });
});
