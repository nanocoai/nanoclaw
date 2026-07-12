import { describe, it, expect } from 'bun:test';

import { formatLocalTime, isValidTimezone, nowInZone, parseZonedToUtc, resolveTimezone } from './timezone.js';

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime('2026-02-04T18:30:00.000Z', 'America/New_York');
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('includes the weekday so the agent does not have to infer day-of-week from the date', () => {
    // 2026-02-04 is a Wednesday
    const result = formatLocalTime('2026-02-04T18:30:00.000Z', 'America/New_York');
    expect(result).toContain('Wednesday');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });

  it('does not throw on invalid timezone, falls back to UTC', () => {
    expect(() => formatLocalTime('2026-01-01T00:00:00.000Z', 'IST-2')).not.toThrow();
    const result = formatLocalTime('2026-01-01T12:00:00.000Z', 'IST-2');
    // Should format as UTC (noon UTC = 12:00 PM)
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
  });
});

// --- nowInZone ---

describe('nowInZone', () => {
  it('renders the current time in the given zone with a weekday', () => {
    const result = nowInZone('America/New_York');
    // weekday, month, year and a 12h clock marker are always present
    expect(result).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),/);
    expect(result).toMatch(/\b(AM|PM)\b/);
  });

  it('falls back to UTC on an invalid timezone without throwing', () => {
    expect(() => nowInZone('Not/AZone')).not.toThrow();
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA identifiers', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Asia/Jerusalem')).toBe(true);
  });

  it('rejects invalid timezone strings', () => {
    expect(isValidTimezone('IST-2')).toBe(false);
    expect(isValidTimezone('XYZ+3')).toBe(false);
  });

  it('rejects empty and garbage strings', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('NotATimezone')).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('returns the timezone if valid', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for invalid timezone', () => {
    expect(resolveTimezone('IST-2')).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });
});

describe('parseZonedToUtc', () => {
  it('passes strings with Z suffix through unchanged', () => {
    const d = parseZonedToUtc('2026-01-15T09:00:00Z', 'America/New_York');
    expect(d.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('passes strings with numeric offset through unchanged', () => {
    const d = parseZonedToUtc('2026-01-15T09:00:00+02:00', 'America/New_York');
    expect(d.toISOString()).toBe('2026-01-15T07:00:00.000Z');
  });

  it('interprets naive ISO as wall-clock in the given timezone', () => {
    // 09:00 naive in NY in January = 09:00 EST = 14:00 UTC
    const d = parseZonedToUtc('2026-01-15T09:00:00', 'America/New_York');
    expect(d.toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('handles a different positive-offset zone', () => {
    // 09:00 naive in Tokyo (UTC+9) = 00:00 UTC
    const d = parseZonedToUtc('2026-06-15T09:00:00', 'Asia/Tokyo');
    expect(d.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('treats invalid timezone as UTC', () => {
    const d = parseZonedToUtc('2026-01-15T09:00:00', 'NotATimezone');
    expect(d.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });
});
