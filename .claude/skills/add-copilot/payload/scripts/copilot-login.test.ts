import { describe, expect, it } from 'vitest';

import { lastCopilotLogin, parseCopilotAccount } from './copilot-login.js';

describe('parseCopilotAccount', () => {
  it.each([
    ['individual', 'https://api.individual.githubcopilot.com'],
    ['business', 'https://api.business.githubcopilot.com'],
    ['enterprise', 'https://api.enterprise.githubcopilot.com/'],
  ])('returns the %s endpoint origin', (plan, api) => {
    expect(parseCopilotAccount({ copilot_plan: plan, chat_enabled: true, endpoints: { api } })).toEqual({
      apiUrl: new URL(api).origin,
      plan,
    });
  });

  it('rejects missing, non-HTTPS, and chat-disabled accounts', () => {
    expect(() => parseCopilotAccount({})).toThrow('did not return');
    expect(() => parseCopilotAccount({ endpoints: { api: 'http://api.business.githubcopilot.com' } })).toThrow('HTTPS');
    expect(() =>
      parseCopilotAccount({ chat_enabled: false, endpoints: { api: 'https://api.business.githubcopilot.com' } }),
    ).toThrow('disabled');
  });
});

describe('lastCopilotLogin', () => {
  it('reads the last github.com login from the commented CLI config', () => {
    const config = `// managed automatically\n{"lastLoggedInUser": {"host": "https://github.com", "login": "octo"}}`;
    expect(lastCopilotLogin(config)).toBe('octo');
  });

  it('ignores logins on other hosts', () => {
    expect(lastCopilotLogin('{"lastLoggedInUser": {"host": "https://ghe.example", "login": "octo"}}')).toBeUndefined();
  });
});
