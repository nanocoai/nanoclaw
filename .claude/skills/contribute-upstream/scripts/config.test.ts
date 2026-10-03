import { describe, expect, it } from 'vitest';

import { DEFAULTS, flagValue, flagValues, resolveForkOwner } from './config.js';

describe('flagValue / flagValues', () => {
  it('reads a flag value or falls back', () => {
    const argv = ['--ledger', 'notes/ledger.md', '--exclude', 'a/', '--exclude', 'b/'];
    expect(flagValue(argv, '--ledger', DEFAULTS.ledger)).toBe('notes/ledger.md');
    expect(flagValue(argv, '--status-file', DEFAULTS.status)).toBe(DEFAULTS.status);
    expect(flagValue(['--ledger'], '--ledger', DEFAULTS.ledger)).toBe(DEFAULTS.ledger);
    expect(flagValues(argv, '--exclude')).toEqual(['a/', 'b/']);
  });
});

describe('resolveForkOwner', () => {
  it('prefers --owner, then CONTRIB_FORK_OWNER', () => {
    expect(resolveForkOwner(['--owner', 'flag-owner'], { CONTRIB_FORK_OWNER: 'env-owner' })).toBe('flag-owner');
    expect(resolveForkOwner([], { CONTRIB_FORK_OWNER: 'env-owner' })).toBe('env-owner');
  });
});
