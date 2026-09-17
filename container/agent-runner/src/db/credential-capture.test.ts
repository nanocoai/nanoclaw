import { beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  clearPendingCredentialCapture,
  getPendingCredentialCapture,
  setPendingCredentialCapture,
} from './credential-capture.js';

beforeEach(() => {
  initTestSessionDb();
});

describe('pending credential capture state', () => {
  it('is undefined when nothing is pending', () => {
    clearPendingCredentialCapture();
    expect(getPendingCredentialCapture()).toBeUndefined();
  });

  it('round-trips a set value', () => {
    setPendingCredentialCapture({ site: 'har-hakesef', url: 'https://itur.mof.gov.il', step: 'username' });
    expect(getPendingCredentialCapture()).toEqual({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'username',
    });
  });

  it('advances to the password step carrying the captured username', () => {
    setPendingCredentialCapture({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'password',
      username: '123456789',
    });
    expect(getPendingCredentialCapture()?.step).toBe('password');
    expect(getPendingCredentialCapture()?.username).toBe('123456789');
  });

  it('clears', () => {
    setPendingCredentialCapture({ site: 'x', url: 'https://x.example', step: 'username' });
    clearPendingCredentialCapture();
    expect(getPendingCredentialCapture()).toBeUndefined();
  });
});
