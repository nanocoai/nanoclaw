import { describe, it, expect } from 'vitest';
import { findSecretForHost, findGithubGitSecret, type OneCliSecret } from './onecli-vault-helpers.js';

const apiOnly: OneCliSecret = {
  id: '1',
  name: 'GitHub',
  type: 'generic',
  hostPattern: 'api.github.com',
  pathPattern: null,
  injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
};

const gitClone: OneCliSecret = {
  id: '2',
  name: 'GitHub Git Clone',
  type: 'generic',
  hostPattern: 'github.com',
  pathPattern: null,
  injectionConfig: { headerName: 'Authorization', valueFormat: 'Basic {value}' },
};

const otherHost: OneCliSecret = {
  id: '3',
  name: 'Anthropic',
  type: 'generic',
  hostPattern: 'api.anthropic.com',
  pathPattern: null,
  injectionConfig: { headerName: 'X-API-Key', valueFormat: '{value}' },
};

const noPattern: OneCliSecret = {
  id: '4',
  name: 'Misconfigured',
  type: 'generic',
  hostPattern: null,
  pathPattern: null,
};

describe('findSecretForHost', () => {
  it('returns null on empty list', () => {
    expect(findSecretForHost('github.com', [])).toBeNull();
  });

  it('finds exact-match host', () => {
    const r = findSecretForHost('github.com', [apiOnly, gitClone, otherHost]);
    expect(r?.id).toBe('2');
  });

  it('does NOT match api.github.com against github.com (exact)', () => {
    // Confirms the bug class: github.com pattern wouldn't fire on api.github.com.
    const r = findSecretForHost('github.com', [apiOnly]);
    expect(r).toBeNull();
  });

  it('matches regex patterns', () => {
    const regex: OneCliSecret = {
      ...gitClone,
      hostPattern: '^github\\.com$',
    };
    expect(findSecretForHost('github.com', [regex])?.id).toBe('2');
  });

  it('skips entries with null hostPattern', () => {
    expect(findSecretForHost('github.com', [noPattern])).toBeNull();
  });

  it('returns first match in list order', () => {
    const r = findSecretForHost('github.com', [gitClone, { ...gitClone, id: 'second', name: 'Dup' }]);
    expect(r?.id).toBe('2');
  });
});

describe('findGithubGitSecret', () => {
  it('returns null when only api.github.com Bearer entry present', () => {
    expect(findGithubGitSecret([apiOnly])).toBeNull();
  });

  it('returns null when github.com entry exists but valueFormat is not Basic', () => {
    const wrongFormat: OneCliSecret = {
      ...gitClone,
      injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    };
    expect(findGithubGitSecret([wrongFormat])).toBeNull();
  });

  it('returns null when headerName is wrong', () => {
    const wrongHeader: OneCliSecret = {
      ...gitClone,
      injectionConfig: { headerName: 'X-Custom', valueFormat: 'Basic {value}' },
    };
    expect(findGithubGitSecret([wrongHeader])).toBeNull();
  });

  it('finds the correctly-shaped github.com secret', () => {
    const r = findGithubGitSecret([apiOnly, gitClone, otherHost]);
    expect(r?.id).toBe('2');
  });

  it('case-insensitive on header name', () => {
    const lower: OneCliSecret = {
      ...gitClone,
      injectionConfig: { headerName: 'authorization', valueFormat: 'Basic {value}' },
    };
    expect(findGithubGitSecret([lower])?.id).toBe('2');
  });

  it('returns null when no injectionConfig', () => {
    const stripped: OneCliSecret = { ...gitClone, injectionConfig: undefined };
    expect(findGithubGitSecret([stripped])).toBeNull();
  });
});
