import { describe, expect, it } from 'vitest';
import { resolveTodayInfo, type MaintenanceScheduleConfig } from './schedule-config.js';

const CONFIG: MaintenanceScheduleConfig = {
  timezone: 'America/New_York',
  fixed_workdays: [1, 2, 3, 4, 5],
  conditional_workdays: { '6': { enabled: true }, '7': { enabled: false } },
  work_start_hour: 8,
  work_end_hour: 17,
};

describe('resolveTodayInfo', () => {
  it('classifies a weekday within hours as fixed', () => {
    const info = resolveTodayInfo(CONFIG, new Date('2026-08-18T14:00:00Z')); // Tue 10am ET
    expect(info).toMatchObject({ weekday: 2, hour: 10, dayType: 'fixed' });
  });

  it('classifies Saturday (enabled conditional) as conditional, regardless of hour', () => {
    const info = resolveTodayInfo(CONFIG, new Date('2026-08-22T14:00:00Z')); // Sat 10am ET
    expect(info).toMatchObject({ weekday: 6, dayType: 'conditional' });
  });

  it('classifies Sunday (disabled conditional) as off', () => {
    const info = resolveTodayInfo(CONFIG, new Date('2026-08-23T14:00:00Z')); // Sun 10am ET
    expect(info).toMatchObject({ weekday: 7, dayType: 'off' });
  });

  it('resolves the date in the configured timezone, not UTC', () => {
    // 2026-08-18T02:00:00Z is 2026-08-17 22:00 EDT -- previous calendar day locally.
    const info = resolveTodayInfo(CONFIG, new Date('2026-08-18T02:00:00Z'));
    expect(info.date).toBe('2026-08-17');
  });
});
