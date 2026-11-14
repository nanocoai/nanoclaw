import { describe, expect, it } from 'vitest';

import {
  anthropicCredentialError,
  anthropicCredentialPrompt,
  isAnthropicOAuthToken,
  pastedCredential,
} from './anthropic-credential.js';

describe('anthropicCredentialError', () => {
  it.each(['sk-ant-api03-fixture', 'sk-ant-usr01-fixture', 'sk-ant-svc01-fixture'])(
    'accepts %s as an API key',
    (key) => {
      expect(anthropicCredentialError('api', key)).toBeUndefined();
    },
  );

  it('accepts an API key type the Console adds later', () => {
    expect(anthropicCredentialError('api', 'sk-ant-xyz01-fixture')).toBeUndefined();
  });

  it('accepts an OAuth token pasted as an API key, so the menu choice is no dead end', () => {
    expect(anthropicCredentialError('api', 'sk-ant-oat01-fixture')).toBeUndefined();
  });

  it('rejects an Admin API key, which cannot call models', () => {
    expect(anthropicCredentialError('api', 'sk-ant-admin01-fixture')).toMatch(/Admin/);
  });

  it('rejects an OAuth refresh token, which cannot call models', () => {
    expect(anthropicCredentialError('api', 'sk-ant-ort01-fixture')).toMatch(/refresh token/);
    expect(anthropicCredentialError('oauth', 'sk-ant-ort01-fixture')).toMatch(/sk-ant-oat/);
  });

  it('accepts an OAuth token as an OAuth token', () => {
    expect(anthropicCredentialError('oauth', 'sk-ant-oat01-fixture')).toBeUndefined();
  });

  it.each(['sk-ant-api03-fixture', 'sk-ant-usr01-fixture', 'sk-ant-svc01-fixture'])(
    'rejects the API key %s as an OAuth token',
    (key) => {
      expect(anthropicCredentialError('oauth', key)).toMatch(/sk-ant-oat/);
    },
  );

  it.each(['hello', 'sk-ant-', 'sk-ant-01-fixture', 'sk-proj-fixture', 'SK-ANT-API03-fixture', '"sk-ant-api03-x"'])(
    'rejects %s as an API key, naming everything the prompt takes',
    (value) => {
      const error = anthropicCredentialError('api', value);
      expect(error).toMatch(/sk-ant-api…, sk-ant-usr… or sk-ant-svc…/);
      expect(error).toMatch(/OAuth token \(sk-ant-oat…\)/);
    },
  );

  it.each(['api', 'oauth'] as const)('requires a value for %s', (kind) => {
    expect(anthropicCredentialError(kind, '')).toBe('Required');
    expect(anthropicCredentialError(kind, ' \n ')).toBe('Required');
    expect(anthropicCredentialError(kind, undefined)).toBe('Required');
  });

  it('validates the value with whitespace stripped', () => {
    expect(anthropicCredentialError('api', '  sk-ant-svc01-\nfixture \n')).toBeUndefined();
    expect(anthropicCredentialError('oauth', ' sk-ant-oat01-\r\nfixture ')).toBeUndefined();
  });
});

describe('pastedCredential', () => {
  it('drops every whitespace character, including a wrapped line break', () => {
    expect(pastedCredential('  sk-ant-svc01-\nfix\tture \r\n')).toBe('sk-ant-svc01-fixture');
  });
});

describe('isAnthropicOAuthToken', () => {
  it('recognises only the sk-ant-oat prefix', () => {
    expect(isAnthropicOAuthToken('sk-ant-oat01-fixture')).toBe(true);
    expect(isAnthropicOAuthToken('sk-ant-svc01-fixture')).toBe(false);
    expect(isAnthropicOAuthToken('sk-ant-api03-fixture')).toBe(false);
  });
});

describe('anthropicCredentialPrompt', () => {
  it('asks for a single-workspace key, since NanoClaw sends no anthropic-workspace-id header', () => {
    expect(anthropicCredentialPrompt('api')).toMatch(/one workspace/);
    expect(anthropicCredentialPrompt('oauth')).toBe('Paste your OAuth token');
  });
});
