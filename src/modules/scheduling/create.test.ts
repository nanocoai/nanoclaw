import { describe, expect, it } from 'vitest';

import { validateRecurrence } from './create.js';

// cron-parser 5.10.1 bounds a field to 256 values and 5.10.2 an expression to 1,024 characters (CVE-2026-137058: up to
// 5.10.0 an oversized expression expanded into arrays that ran the process out of memory). Both refuse before expanding.
describe('validateRecurrence', () => {
  it('takes an ordinary cron', () => {
    expect(() => validateRecurrence('0 9 * * 1-5', 'UTC')).not.toThrow();
  });

  it('refuses a field that lists past 256 values', () => {
    expect(() => validateRecurrence('*,*,*,*,*,* 9 * * *', 'UTC')).toThrow(/too many values/);
  });

  it('refuses an expression past 1,024 characters', () => {
    expect(() => validateRecurrence(`0 9 * * ${'1,'.repeat(600)}2`, 'UTC')).toThrow(/too long/);
  });
});
