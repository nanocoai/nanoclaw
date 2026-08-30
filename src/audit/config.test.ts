import { describe, expect, it } from 'vitest';

import { parseRetentionHours } from './config.js';

describe('audit transfer-buffer configuration', () => {
  it.each([undefined, '', ' ', '-1', '1day', '13.5', '10000001', '9007199254740992'])(
    'keeps the 12-hour default for malformed value %j',
    (value) => expect(parseRetentionHours(value)).toBe(12),
  );

  it('accepts explicit whole-hour horizons and zero-as-forever', () => {
    expect(parseRetentionHours('30')).toBe(30);
    expect(parseRetentionHours('0')).toBe(0);
  });
});
