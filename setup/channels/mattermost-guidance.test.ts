import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseDirectives } from '../../scripts/skill-directives.js';
import { upsertEnvVar } from '../set-env.js';
import { channelDmLabel, initialChannelOptions, runInitialChannel } from './initial-setup.js';

const skill = readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8');
const localServer = readFileSync('.claude/skills/add-mattermost/LOCAL_SERVER.md', 'utf8');
const compose = readFileSync('.claude/skills/add-mattermost/assets/compose.yml', 'utf8');
const directives = parseDirectives(skill);

describe('Mattermost bot setup guidance', () => {
  it('distinguishes enabling bot creation from creating the bot', () => {
    expect(skill).toContain(
      'System Console → Integrations → Bot Accounts. Turn on Enable Bot Account Creation',
    );
    expect(skill).toContain(
      'Open Product menu → Integrations → Bot Accounts. Select Add Bot Account',
    );
  });

  it('requires both team and channel membership', () => {
    expect(skill).toMatch(/Add the bot to each required team and channel\./);
  });

  it('offers and dispatches Mattermost as a first-class initial setup option', async () => {
    expect(initialChannelOptions()).toContainEqual({
      value: 'mattermost',
      label: 'Yes, connect Mattermost',
      hint: 'use your server or create an evaluation server',
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

  it('requires the operator to choose how a detected server is used', () => {
    const choice = directives.find(
      (directive) => directive.kind === 'prompt' && directive.args.includes('server_choice'),
    );
    const install = directives.find(
      (directive) => directive.kind === 'prompt' && directive.args.includes('local_install_approval'),
    );
    expect(choice?.attrs.validate).toBe('^(use|enter|create)$');
    expect(install?.attrs.validate).toBe('^install$');
  });

  it('keeps every evaluation-server command self-contained and preserves shell control flow', () => {
    const install = directives.find(
      (directive) => directive.kind === 'run' && directive.body.some((line) => line.includes('for attempt in')),
    );
    expect(install?.body).toHaveLength(7);
    expect(install?.body[0]).toContain('docker info >/dev/null && docker compose version >/dev/null');
    expect(install?.body).not.toContain('umask 077');
    expect(install?.body).not.toContain('exit 1');

    const envCommand = install?.body.find((line) => line.includes('MATTERMOST_DB_PASSWORD'));
    const retryCommand = install?.body.find((line) => line.includes('for attempt in'));
    expect(envCommand).toContain('{ umask 077;');
    expect(retryCommand).toContain('done; docker compose');
    expect(retryCommand).toMatch(/; exit 1$/);

    const root = mkdtempSync(join(tmpdir(), 'nanoclaw-mattermost-shell-'));
    const bin = join(root, 'bin');
    const log = join(root, 'docker.log');
    mkdirSync(join(root, '.nanoclaw/mattermost'), { recursive: true });
    mkdirSync(bin);
    const fake = (name: string, body: string) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    };

    try {
      fake('openssl', "printf '0123456789abcdef0123456789abcdef0123456789abcdef'");
      fake('seq', "printf '1\\n2\\n'");
      fake('sleep', 'exit 0');
      fake('docker', 'printf "logs\\n" >> "$MM_TEST_LOG"');
      fake('curl', 'exit "${MM_CURL_EXIT:-0}"');
      const env = { ...process.env, PATH: bin, MM_TEST_LOG: log };

      execFileSync('/bin/sh', ['-c', envCommand!], { cwd: root, env });
      expect(statSync(join(root, '.nanoclaw/mattermost/.env')).mode & 0o777).toBe(0o600);

      execFileSync('/bin/sh', ['-c', retryCommand!], { cwd: root, env: { ...env, MM_CURL_EXIT: '0' } });
      expect(existsSync(log)).toBe(false);

      const failed = spawnSync('/bin/sh', ['-c', retryCommand!], {
        cwd: root,
        env: { ...env, MM_CURL_EXIT: '1' },
      });
      expect(failed.status).toBe(1);
      expect(readFileSync(log, 'utf8')).toBe('logs\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes the managed SiteURL state and journals removal for the refreshed base URL', () => {
    const managed = directives.find(
      (directive) => directive.kind === 'operator' && directive.attrs.when === 'config_access=managed',
    );
    const baseUrlUpdate = directives.find(
      (directive) =>
        directive.kind === 'run' && directive.body.some((line) => line.includes('--key MATTERMOST_BASE_URL')),
    );
    const envSet = directives.find((directive) => directive.kind === 'env-set');
    expect(managed).toBeDefined();
    expect(baseUrlUpdate?.attrs.remove).toBe(
      '.claude/skills/add-mattermost/scripts/remove-base-url.mjs',
    );
    expect(envSet?.body.some((line) => line.startsWith('MATTERMOST_BASE_URL='))).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'nanoclaw-mattermost-remove-'));
    try {
      writeFileSync(
        join(root, '.env'),
        'MATTERMOST_BASE_URL=http://localhost:8065\nMATTERMOST_BOT_TOKEN=keep-me\n',
      );
      execFileSync(
        join(process.cwd(), '.claude/skills/add-mattermost/scripts/remove-base-url.mjs'),
        { cwd: root },
      );
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
    expect(skill).toContain(
      'setup/index.ts --step set-env -- --key MATTERMOST_BASE_URL --value "{{base_url}}"',
    );
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

  it('keeps the evaluation server canonical and declarative', () => {
    expect(compose).toContain('MM_SERVICESETTINGS_SITEURL: "http://localhost:8065"');
    expect(compose).not.toContain('MM_SERVICESETTINGS_ALLOWCORSFROM');
    expect(localServer).toContain('Keep `WebsocketURL` blank');
    expect(localServer).toContain('/api/v4/config/client?format=old');
  });
});
