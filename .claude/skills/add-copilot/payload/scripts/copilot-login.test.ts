import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COPILOT_API_SECRET,
  COPILOT_CREDENTIAL_PLACEHOLDER,
  COPILOT_GITHUB_SECRET,
  copilotApiTarget,
  copilotGitHubTarget,
  lastCopilotLogin,
  parseCopilotAccount,
} from './copilot-login.js';

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

describe('copilotApiTarget', () => {
  it('scopes the token host-wide to the licensed API host with a bearer header', () => {
    expect(copilotApiTarget('https://api.business.githubcopilot.com')).toEqual({
      name: COPILOT_API_SECRET,
      kind: 'api-key',
      host: 'api.business.githubcopilot.com',
      proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
      provider: 'copilot',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
  });

  it('names the provider so per-agent gateways grant it to Copilot groups', () => {
    expect(copilotApiTarget('https://api.individual.githubcopilot.com').provider).toBe('copilot');
  });

  it('uses the placeholder the container provider sends', () => {
    // scripts/ and container/ are siblings both in the payload and once installed.
    const source = path.join(import.meta.dirname, '..', 'container', 'agent-runner', 'src', 'providers', 'copilot.ts');
    expect(fs.readFileSync(source, 'utf8')).toContain(
      `COPILOT_GATEWAY_PLACEHOLDER = '${COPILOT_CREDENTIAL_PLACEHOLDER}'`,
    );
  });
});

describe('copilotGitHubTarget', () => {
  it('limits api.github.com to the one Copilot path, for the copilot provider', () => {
    expect(copilotGitHubTarget()).toEqual({
      name: COPILOT_GITHUB_SECRET,
      kind: 'api-key',
      host: 'api.github.com',
      path: '/copilot_internal/user',
      proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
      provider: 'copilot',
      injection: { headerName: 'Authorization', valueFormat: 'token {value}' },
    });
  });
});
