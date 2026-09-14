import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseDirectives } from '../../scripts/skill-directives.js';
import { upsertEnvVar } from '../set-env.js';
import { channelDmLabel, initialChannelOptions, runInitialChannel } from './initial-setup.js';

const skill = readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8');
const serverSetup = readFileSync('.claude/skills/add-mattermost/SERVER_SETUP.md', 'utf8');
const fixtureReadme = readFileSync('setup/channels/fixtures/mattermost/README.md', 'utf8');
const compose = readFileSync('setup/channels/fixtures/mattermost/compose.yml', 'utf8');
const directives = parseDirectives(skill);

describe('Mattermost bot setup guidance', () => {
  it('distinguishes enabling bot creation from creating the bot', () => {
    expect(skill).toContain('System Console → Integrations → Bot Accounts. Turn on Enable Bot Account Creation');
    expect(skill).toContain('Open Product menu → Integrations → Bot Accounts. Select Add Bot Account');
  });

  it('requires both team and channel membership', () => {
    expect(skill).toMatch(/Add the bot to each required team and channel\./);
  });

  it('offers and dispatches Mattermost as a first-class initial setup option', async () => {
    expect(initialChannelOptions()).toContainEqual({
      value: 'mattermost',
      label: 'Yes, connect Mattermost',
      hint: 'connect your server or get setup guidance',
    });
    const calls: unknown[][] = [];
    await runInitialChannel('mattermost', 'Ethan', async (...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([['mattermost', 'Ethan', { offerBack: true }]]);
    expect(channelDmLabel('mattermost')).toBe('Mattermost DMs');
  });

  it('installs and runs focused adapter regressions with the registration test', () => {
    expect(skill).toContain('src/channels/mattermost-adapter/adapter.test.ts');
    expect(skill).toContain('src/channels/mattermost-adapter/websocket.test.ts');
    expect(skill).toContain(
      'pnpm exec vitest run src/channels/mattermost-registration.test.ts src/channels/mattermost-adapter/adapter.test.ts src/channels/mattermost-adapter/websocket.test.ts',
    );
  });

  it('selects an existing server without offering NanoClaw-managed installation', () => {
    const choice = directives.find(
      (directive) => directive.kind === 'prompt' && directive.args.includes('server_choice'),
    );
    const missingServerUrl = directives.find(
      (directive) => directive.kind === 'prompt' && directive.args.includes('entered_url_new'),
    );
    expect(choice?.attrs.validate).toBe('^(use|enter)$');
    expect(missingServerUrl?.attrs.when).toBe('discovery=none');
    expect(directives.some((directive) => directive.args.includes('local_install_approval'))).toBe(false);
    expect(skill).not.toContain('docker compose');
    expect(skill).not.toContain('select-server.mjs create');
  });

  it('offers maintained Mattermost server guidance when discovery finds nothing', () => {
    const guidance = directives.find(
      (directive) => directive.kind === 'operator' && directive.attrs.when === 'discovery=none',
    );
    expect(guidance?.body.join(' ')).toContain('https://docs.mattermost.com/deployment-guide/quick-start-evaluation');
    expect(guidance?.body.join(' ')).toContain('https://docs.mattermost.com/deployment-guide/server/deploy-server');
    expect(serverSetup).toContain('NanoClaw connects to a Mattermost server');
    expect(serverSetup).toContain('Mattermost labels this path for testing and evaluation rather than production');
  });

  it('journals removal for the selected settings', () => {
    const baseUrlUpdate = directives.find(
      (directive) => directive.kind === 'run' && directive.body.some((line) => line.includes('scripts/configure.ts')),
    );
    const envSet = directives.find((directive) => directive.kind === 'env-set');
    expect(baseUrlUpdate?.attrs.remove).toBe('.claude/skills/add-mattermost/scripts/remove-config.mjs');
    expect(envSet).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), 'nanoclaw-mattermost-remove-'));
    try {
      writeFileSync(join(root, '.env'), 'MATTERMOST_BASE_URL=http://localhost:8065\nMATTERMOST_BOT_TOKEN=keep-me\n');
      execFileSync(join(process.cwd(), '.claude/skills/add-mattermost/scripts/remove-base-url.mjs'), { cwd: root });
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('MATTERMOST_BOT_TOKEN=keep-me\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('configures and verifies the exact canonical SiteURL without weakening origin checks', () => {
    expect(skill).toContain('mmctl config set ServiceSettings.SiteURL "{{base_url}}" --local');
    expect(skill).toContain('/api/v4/config/client?format=old');
    expect(skill).toContain('ServiceSettings.AllowCorsFrom');
    expect(directives.some((directive) => directive.attrs.when === 'config_access=docker')).toBe(true);
    expect(skill).toContain('scripts/configure.ts "{{base_url}}" "{{bot_token}}" "{{callback_url}}"');
  });

  it('binds the generic wizard owner handle to the resolved Mattermost user ID', () => {
    const ownerLookup = directives.find(
      (directive) =>
        directive.kind === 'run' &&
        directive.body.some((line) => line.includes('/api/v4/users/username/{{owner_username}}')),
    );
    expect(ownerLookup?.attrs.capture).toBe('owner_user_id=.id,owner_handle=.id');
  });

  it('replaces a stale canonical URL without changing existing credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'nanoclaw-mattermost-rerun-'));
    const previousCwd = process.cwd();
    const before = [
      'MATTERMOST_BASE_URL=http://localhost:8065',
      'MATTERMOST_BOT_TOKEN=existing-bot-token',
      'MATTERMOST_CALLBACK_URL=http://host.docker.internal:3000/webhook/mattermost',
      'MATTERMOST_CALLBACK_SECRET=existing-callback-secret',
      '',
    ].join('\n');

    try {
      writeFileSync(join(root, '.env'), before);
      process.chdir(root);
      expect(upsertEnvVar('MATTERMOST_BASE_URL', 'http://127.0.0.1:8065')).toEqual({ existed: true });
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
        before.replace('http://localhost:8065', 'http://127.0.0.1:8065'),
      );
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the real-server E2E fixture outside the user-facing skill', () => {
    expect(fixtureReadme).toContain('development and E2E only');
    expect(fixtureReadme.replace(/\s+/g, ' ')).toContain(
      'The `/add-mattermost` skill does not install, start, or manage it',
    );
    expect(compose).toContain('MM_SERVICESETTINGS_SITEURL: "http://localhost:8065"');
    expect(compose).not.toContain('MM_SERVICESETTINGS_ALLOWCORSFROM');
    expect(skill).not.toContain('setup/channels/fixtures/mattermost');
  });
});
