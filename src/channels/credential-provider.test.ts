/**
 * The channel credential provider seam: the `.env` default resolves exactly
 * the keys the Slack and Teams adapters read today (same names, same
 * per-instance suffix rule), and another provider can be installed for
 * every later instance start.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EnvFileCredentialProvider,
  channelInstanceEnvKey,
  credentialEnvKey,
  getChannelCredential,
  getChannelCredentialProvider,
  instanceEnvKeySuffix,
  setChannelCredentialProvider,
} from './credential-provider.js';

describe('credentialEnvKey', () => {
  it('default instances read the bare keys the adapters always read', () => {
    expect(credentialEnvKey('slack', 'bot_token')).toBe('SLACK_BOT_TOKEN');
    expect(credentialEnvKey('slack', 'signing_secret')).toBe('SLACK_SIGNING_SECRET');
    expect(credentialEnvKey('slack', 'app_token')).toBe('SLACK_APP_TOKEN');
    expect(credentialEnvKey('teams', 'app_id')).toBe('TEAMS_APP_ID');
    expect(credentialEnvKey('teams', 'app_password')).toBe('TEAMS_APP_PASSWORD');
    expect(credentialEnvKey('teams', 'tenant_id')).toBe('TEAMS_APP_TENANT_ID');
    expect(credentialEnvKey('teams', 'app_type')).toBe('TEAMS_APP_TYPE');
  });

  it('env-mode named instances read the suffixed keys (name uppercased, dashes → underscores)', () => {
    expect(credentialEnvKey('slack-gh-bot', 'bot_token')).toBe('SLACK_BOT_TOKEN_GH_BOT');
    expect(credentialEnvKey('slack-dana', 'app_token')).toBe('SLACK_APP_TOKEN_DANA');
    expect(credentialEnvKey('slack-dana', 'signing_secret')).toBe('SLACK_SIGNING_SECRET_DANA');
    expect(credentialEnvKey('teams-hq', 'app_password')).toBe('TEAMS_APP_PASSWORD_HQ');
    expect(credentialEnvKey('teams-hq', 'tenant_id')).toBe('TEAMS_APP_TENANT_ID_HQ');
  });

  it('a connection slug reads its own suffix, so a spec instance can still be hand-provisioned from .env', () => {
    expect(credentialEnvKey('acme-hq', 'bot_token')).toBe('SLACK_BOT_TOKEN_ACME_HQ');
    expect(credentialEnvKey('acme-hq', 'app_password')).toBe('TEAMS_APP_PASSWORD_ACME_HQ');
  });

  it('maps nothing for a key trunk does not know', () => {
    expect(credentialEnvKey('slack', 'client_secret')).toBeUndefined();
    expect(credentialEnvKey('acme-hq', '')).toBeUndefined();
  });

  it("instanceEnvKeySuffix / channelInstanceEnvKey are the adapters' suffix rule for any base key", () => {
    expect(instanceEnvKeySuffix('gh-bot')).toBe('GH_BOT');
    expect(instanceEnvKeySuffix('dana')).toBe('DANA');
    expect(channelInstanceEnvKey('SLACK_WORKSPACE_ID', 'slack', 'slack')).toBe('SLACK_WORKSPACE_ID');
    expect(channelInstanceEnvKey('SLACK_WORKSPACE_ID', 'slack', 'slack-alpha')).toBe('SLACK_WORKSPACE_ID_ALPHA');
    expect(channelInstanceEnvKey('SLACK_WORKSPACE_ID', 'slack', 'acme-hq')).toBe('SLACK_WORKSPACE_ID_ACME_HQ');
  });
});

describe('EnvFileCredentialProvider', () => {
  it('reads the mapped key from the project .env; empty and missing values resolve undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-provider-'));
    writeFileSync(
      join(dir, '.env'),
      [
        'SLACK_BOT_TOKEN=xoxb-default',
        'SLACK_BOT_TOKEN_ALPHA="xoxb-alpha"',
        'SLACK_APP_TOKEN_ALPHA=',
        'TEAMS_APP_ID=app-1',
        '',
      ].join('\n'),
    );
    const provider = new EnvFileCredentialProvider(dir);
    await expect(provider.get('slack', 'bot_token')).resolves.toBe('xoxb-default');
    await expect(provider.get('slack-alpha', 'bot_token')).resolves.toBe('xoxb-alpha');
    await expect(provider.get('slack-alpha', 'app_token')).resolves.toBeUndefined();
    await expect(provider.get('slack-alpha', 'signing_secret')).resolves.toBeUndefined();
    await expect(provider.get('teams', 'app_id')).resolves.toBe('app-1');
    await expect(provider.get('teams', 'not-a-key')).resolves.toBeUndefined();
  });

  it('resolves per call, so a rotated value is seen at the next instance start without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-provider-'));
    writeFileSync(join(dir, '.env'), 'SLACK_BOT_TOKEN_ACME_HQ=xoxb-one\n');
    const provider = new EnvFileCredentialProvider(dir);
    await expect(provider.get('acme-hq', 'bot_token')).resolves.toBe('xoxb-one');
    writeFileSync(join(dir, '.env'), 'SLACK_BOT_TOKEN_ACME_HQ=xoxb-two\n');
    await expect(provider.get('acme-hq', 'bot_token')).resolves.toBe('xoxb-two');
  });

  it('resolves nothing when there is no .env at all', async () => {
    const provider = new EnvFileCredentialProvider(mkdtempSync(join(tmpdir(), 'cred-provider-empty-')));
    await expect(provider.get('slack', 'bot_token')).resolves.toBeUndefined();
  });
});

describe('setChannelCredentialProvider', () => {
  afterEach(() => {
    setChannelCredentialProvider(null);
  });

  it('ships the .env provider by default', () => {
    expect(getChannelCredentialProvider()).toBeInstanceOf(EnvFileCredentialProvider);
  });

  it('installs another provider for every later resolution, and null restores the default', async () => {
    const calls: Array<[string, string]> = [];
    setChannelCredentialProvider({
      async get(instance, key) {
        calls.push([instance, key]);
        return key === 'bot_token' ? 'xoxb-vault' : undefined;
      },
    });
    await expect(getChannelCredential('acme-hq', 'bot_token')).resolves.toBe('xoxb-vault');
    await expect(getChannelCredential('acme-hq', 'signing_secret')).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['acme-hq', 'bot_token'],
      ['acme-hq', 'signing_secret'],
    ]);

    setChannelCredentialProvider(null);
    expect(getChannelCredentialProvider()).toBeInstanceOf(EnvFileCredentialProvider);
  });
});
