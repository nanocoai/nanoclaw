import { describe, expect, it } from 'vitest';

import { parseFlags, readFromEnv } from './setup-config-parse.js';
import { validateHttpUrl } from './setup-config.js';

describe('setup URL validation', () => {
  it('accepts only fully parsed HTTP(S) URLs without control characters', () => {
    expect(validateHttpUrl('https://api.example.com/v1')).toBeUndefined();
    expect(validateHttpUrl('https://api.example.com\nINJECTED=value')).toMatch(/control/);
    expect(validateHttpUrl('https://api.example.com trailing')).toMatch(/whitespace/);
    expect(validateHttpUrl('file:///tmp/secret')).toMatch(/http/);
  });

  it('rejects unsafe URL flags and environment values at both config boundaries', () => {
    const unsafe = 'https://api.example.com\nINJECTED=value';
    expect(parseFlags(['--anthropic-base-url', unsafe]).errors).toHaveLength(1);
    expect(readFromEnv({ NANOCLAW_ANTHROPIC_BASE_URL: unsafe })).toEqual({});
  });
});
