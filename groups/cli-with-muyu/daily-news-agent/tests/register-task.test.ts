import { describe, expect, it } from 'vitest';

import { nextLocal9am } from '../lib/next-local-9am.js';

describe('nextLocal9am', () => {
  it('returns today 09:00 when before 9am in Asia/Shanghai', () => {
    // 2026-06-30 08:00 CST = 2026-06-30T00:00:00.000Z
    const now = new Date('2026-06-30T00:00:00.000Z');
    expect(nextLocal9am(now)).toBe('2026-06-30T09:00:00');
  });

  it('returns tomorrow 09:00 when after 9am in Asia/Shanghai', () => {
    // 2026-06-30 10:00 CST = 2026-06-30T02:00:00.000Z
    const now = new Date('2026-06-30T02:00:00.000Z');
    expect(nextLocal9am(now)).toBe('2026-07-01T09:00:00');
  });

  it('returns today 09:00 at exactly 9:00:00 in Asia/Shanghai', () => {
    // 2026-06-30 09:00:00 CST = 2026-06-30T01:00:00.000Z
    const now = new Date('2026-06-30T01:00:00.000Z');
    expect(nextLocal9am(now)).toBe('2026-06-30T09:00:00');
  });
});
