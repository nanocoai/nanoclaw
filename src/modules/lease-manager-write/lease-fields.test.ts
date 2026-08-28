import { describe, expect, it } from 'vitest';
import {
  buildLeaseChangeLines,
  isValidDateString,
  LeaseFieldValidationError,
  resolveLeaseFields,
} from './lease-fields.js';

describe('isValidDateString', () => {
  it('accepts a real calendar date', () => {
    expect(isValidDateString('2026-06-30')).toBe(true);
  });
  it('rejects an impossible calendar date', () => {
    expect(isValidDateString('2026-02-30')).toBe(false);
  });
  it('rejects malformed strings', () => {
    expect(isValidDateString('06/30/2026')).toBe(false);
    expect(isValidDateString('')).toBe(false);
  });
});

describe('resolveLeaseFields: three-state semantics', () => {
  it('omitted key produces no key in the resolved object (untouched)', () => {
    const resolved = resolveLeaseFields({});
    expect('LeaseStartDate' in resolved).toBe(false);
    expect('LeaseEndDate' in resolved).toBe(false);
    expect('LeaseStatus' in resolved).toBe(false);
  });

  it('explicit null clears', () => {
    const resolved = resolveLeaseFields({ LeaseStartDate: null });
    expect(resolved.LeaseStartDate).toBeNull();
  });

  it('explicit value sets', () => {
    const resolved = resolveLeaseFields({ LeaseStartDate: '2026-01-01' });
    expect(resolved.LeaseStartDate).toBe('2026-01-01');
  });
});

describe('resolveLeaseFields: Fixed Term', () => {
  it('throws when Fixed Term has no LeaseEndDate key', () => {
    expect(() => resolveLeaseFields({ LeaseStatus: 'Fixed Term' })).toThrow(LeaseFieldValidationError);
  });
  it('throws when Fixed Term explicitly nulls LeaseEndDate', () => {
    expect(() => resolveLeaseFields({ LeaseStatus: 'Fixed Term', LeaseEndDate: null })).toThrow(
      LeaseFieldValidationError,
    );
  });
  it('computes Lease Reminder Date as 60 days before Lease End Date', () => {
    const resolved = resolveLeaseFields({ LeaseStatus: 'Fixed Term', LeaseEndDate: '2026-12-31' });
    expect(resolved.LeaseEndDate).toBe('2026-12-31');
    expect(resolved.LeaseReminderDate).toBe('2026-11-01');
  });
  it('an explicit reminder override is honored instead of the computed one', () => {
    const resolved = resolveLeaseFields({
      LeaseStatus: 'Fixed Term',
      LeaseEndDate: '2026-12-31',
      LeaseReminderDate: '2026-10-01',
    });
    expect(resolved.LeaseReminderDate).toBe('2026-10-01');
  });
});

describe('resolveLeaseFields: Month-to-Month defaults', () => {
  it('defaults End Date and Reminder Date to cleared when not explicitly given', () => {
    const resolved = resolveLeaseFields({ LeaseStatus: 'Month-to-Month' });
    expect(resolved.LeaseEndDate).toBeNull();
    expect(resolved.LeaseReminderDate).toBeNull();
  });
  it('does not touch Lease Start Date by default', () => {
    const resolved = resolveLeaseFields({ LeaseStatus: 'Month-to-Month' });
    expect('LeaseStartDate' in resolved).toBe(false);
  });
  it('an explicit End Date override is honored, not cleared', () => {
    const resolved = resolveLeaseFields({ LeaseStatus: 'Month-to-Month', LeaseEndDate: '2027-01-01' });
    expect(resolved.LeaseEndDate).toBe('2027-01-01');
    expect(resolved.LeaseReminderDate).toBe('2026-11-02'); // still auto-computed since no explicit reminder override
  });
});

describe('resolveLeaseFields: Vacant defaults', () => {
  it('clears Start, End, and Reminder Date by default', () => {
    const resolved = resolveLeaseFields({ LeaseStatus: 'Vacant' });
    expect(resolved.LeaseStartDate).toBeNull();
    expect(resolved.LeaseEndDate).toBeNull();
    expect(resolved.LeaseReminderDate).toBeNull();
    expect(resolved.LeaseStatus).toBe('Vacant');
  });
});

describe('resolveLeaseFields: never infers Month-to-Month from a blank End Date', () => {
  it('a row that only sets LeaseEndDate to null does not touch LeaseStatus', () => {
    const resolved = resolveLeaseFields({ LeaseEndDate: null });
    expect('LeaseStatus' in resolved).toBe(false);
  });
});

describe('buildLeaseChangeLines', () => {
  it('shows a clear explicitly', () => {
    const lines = buildLeaseChangeLines(
      { LeaseEndDate: null },
      { LeaseStartDate: null, LeaseEndDate: '2027-08-31', LeaseReminderDate: '2027-07-02', LeaseStatus: 'Fixed Term' },
    );
    expect(lines).toEqual(['Lease End Date: 2027-08-31 → (cleared)']);
  });
  it('shows (none) for a new value with no prior existing value', () => {
    const lines = buildLeaseChangeLines({ LeaseStatus: 'Vacant' }, null);
    expect(lines).toEqual(['Lease Status: (none) → Vacant']);
  });
  it('produces no line for an untouched (absent) field', () => {
    const lines = buildLeaseChangeLines(
      {},
      { LeaseStartDate: '2026-01-01', LeaseEndDate: null, LeaseReminderDate: null, LeaseStatus: null },
    );
    expect(lines).toEqual([]);
  });
  it('produces no line when the resolved value equals the existing value', () => {
    const lines = buildLeaseChangeLines(
      { LeaseStatus: 'Fixed Term' },
      { LeaseStartDate: null, LeaseEndDate: null, LeaseReminderDate: null, LeaseStatus: 'Fixed Term' },
    );
    expect(lines).toEqual([]);
  });
});
