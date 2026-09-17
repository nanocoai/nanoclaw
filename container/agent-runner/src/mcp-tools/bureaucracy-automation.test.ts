import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { clearPendingCredentialCapture, getPendingCredentialCapture } from '../db/credential-capture.js';
import { requestCredentialSetup } from './bureaucracy-automation.js';

beforeEach(() => initTestSessionDb());
afterEach(() => {
  clearPendingCredentialCapture();
  closeSessionDb();
});

describe('requestCredentialSetup', () => {
  it('starts a pending capture at the username step and never echoes a value back', async () => {
    const result = await requestCredentialSetup.handler({ site: 'har-hakesef', url: 'https://itur.mof.gov.il' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain('password');
    expect(getPendingCredentialCapture()).toEqual({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'username',
    });
  });

  it('rejects a second setup while one is already pending', async () => {
    await requestCredentialSetup.handler({ site: 'har-hakesef', url: 'https://itur.mof.gov.il' });
    const result = await requestCredentialSetup.handler({ site: 'clal', url: 'https://clal.example' });
    expect(result.isError).toBe(true);
  });

  it('requires site and url', async () => {
    const result = await requestCredentialSetup.handler({});
    expect(result.isError).toBe(true);
  });
});
