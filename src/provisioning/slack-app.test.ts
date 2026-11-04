import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_BOT_EVENTS,
  AGENT_BOT_SCOPES,
  BOT_EVENTS,
  BOT_SCOPES,
  DEFAULT_SLACK_SERVICE_BASE,
  MANAGED_APP_DESCRIPTION,
  brokerAppStatus,
  brokerProvision,
  buildManagedAppManifest,
  mapBrokerApp,
  provisionManagedApp,
  readInstallToken,
  readManagerToken,
  readServiceBase,
  slackServiceForRegistry,
  waitForInstall,
} from './slack-app.js';

interface ManifestShape {
  display_information: { name: string; description: string };
  features: {
    bot_user: { display_name: string };
    app_home: { messages_tab_enabled: boolean };
    agent_view?: { agent_description: string };
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    event_subscriptions: { bot_events: string[] };
  };
}

describe('buildManagedAppManifest', () => {
  it('builds a socket-mode manifest; the default variant is agent-mode', () => {
    const manifest = buildManagedAppManifest({ name: 'Trusty' }) as ManifestShape;

    expect(manifest.display_information.name).toBe('Trusty');
    expect(manifest.features.bot_user.display_name).toBe('Trusty');
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    // agent_view default: installs never fail; free workspaces degrade to a
    // plain DM. The agent_description is the fixed attribution line.
    expect(manifest.features.agent_view).toEqual({ agent_description: MANAGED_APP_DESCRIPTION });
    expect(manifest.oauth_config.scopes.bot).toEqual([...BOT_SCOPES, ...AGENT_BOT_SCOPES]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([...BOT_EVENTS, ...AGENT_BOT_EVENTS]);
    // Socket Mode is load-bearing: self-hosted installs have no public URL,
    // and the adapter selects socket mode from SLACK_APP_TOKEN's presence.
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    // The adapter has no refresh-token handling; rotation must stay off.
    expect(manifest.settings.token_rotation_enabled).toBe(false);
  });

  it('agentView:false selects the plain variant (guest-accessible bots)', () => {
    const manifest = buildManagedAppManifest({ name: 'Trusty', agentView: false }) as ManifestShape;
    expect(manifest.features.agent_view).toBeUndefined();
    expect(manifest.oauth_config.scopes.bot).toEqual(BOT_SCOPES);
    expect(manifest.oauth_config.scopes.bot).not.toContain('assistant:write');
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(BOT_EVENTS);
  });

  it('never requests user scopes — bot-scopes-only is what makes auto-install eligible', () => {
    for (const agentView of [true, false]) {
      const manifest = buildManagedAppManifest({ name: 'x', agentView }) as {
        oauth_config: { scopes: Record<string, unknown> };
      };
      expect(Object.keys(manifest.oauth_config.scopes)).toEqual(['bot']);
    }
  });

  it('attribution fields never alter the manifest — they ride the broker body only', () => {
    const plain = buildManagedAppManifest({ name: 'Trusty' });
    const attributed = buildManagedAppManifest({
      name: 'Trusty',
      requested_by: 'U0REQ1234',
      parent_app_id: 'A0PARENT1',
      template: 'research-buddy',
      client_version: '2.2.0',
    });
    expect(attributed).toEqual(plain);
  });
});

describe('brokerProvision attribution fields', () => {
  const fetchMock = vi.fn<(url: string, init?: { body?: unknown }) => Promise<unknown>>();
  const appResponse = { app_id: 'A0NEW1', app_token: 'xapp-1-new', bot_token: 'xoxb-new' };

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.SLACK_SERVICE_BASE = 'https://broker.test';
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.SLACK_SERVICE_BASE;
    vi.unstubAllGlobals();
  });

  function jsonResponse(payload: object): object {
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  }

  /** Route the module's outbound calls: avatar create, avatar poll, app create. */
  function routeFetch(avatar: { avatar_id?: string | null; status?: string }): void {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://broker.test/v1/avatars') return jsonResponse({ avatar_id: avatar.avatar_id ?? null });
      if (url.startsWith('https://broker.test/v1/avatars/')) return jsonResponse({ status: avatar.status ?? 'ready' });
      if (url === 'https://broker.test/v1/apps') return jsonResponse(appResponse);
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  function sentAppBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(([url]) => url === 'https://broker.test/v1/apps');
    expect(call).toBeDefined();
    return JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
  }

  it('rides the POST /v1/apps body verbatim when supplied', async () => {
    routeFetch({ avatar_id: null });
    const app = await brokerProvision('nct_x', {
      team_id: 'T1',
      name: 'Pixel',
      requested_by: 'U0REQ1234',
      parent_app_id: 'A0PARENT1',
      template: 'research-buddy',
      client_version: '2.2.0',
    });
    expect(sentAppBody()).toEqual({
      team_id: 'T1',
      name: 'Pixel',
      requested_by: 'U0REQ1234',
      parent_app_id: 'A0PARENT1',
      template: 'research-buddy',
      client_version: '2.2.0',
    });
    // The response mapping is untouched by the extra request fields.
    expect(app.appId).toBe('A0NEW1');
    expect(app.botToken).toBe('xoxb-new');
  });

  it('sends nothing extra when the fields are absent or explicitly undefined', async () => {
    routeFetch({ avatar_id: null });
    await brokerProvision('nct_x', { team_id: 'T1', name: 'Pixel', requested_by: undefined });
    expect(sentAppBody()).toEqual({ team_id: 'T1', name: 'Pixel' });
  });

  it('keeps the avatar_id merge unchanged alongside attribution fields', async () => {
    routeFetch({ avatar_id: 'av1', status: 'ready' });
    await brokerProvision('nct_x', { team_id: 'T1', name: 'Pixel', client_version: '2.2.0' });
    expect(sentAppBody()).toEqual({ team_id: 'T1', name: 'Pixel', avatar_id: 'av1', client_version: '2.2.0' });
  });
});

describe('provisionManagedApp attribution fields', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never forwards them to Slack — neither in the manifest nor as call params', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { body?: unknown }) => {
      if (url === 'https://slack.com/api/apps.manifest.create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, app_id: 'A1', app_token: 'xapp-1', oauth_authorize_url: 'https://x' }),
        };
      }
      if (url === 'https://slack.com/api/apps.managedInstall') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, api_access_tokens: { bot_access_token: 'xoxb-1' } }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await provisionManagedApp('xoxp-mgr', {
      name: 'Trusty',
      requested_by: 'U0REQ1234',
      parent_app_id: 'A0PARENT1',
      template: 'research-buddy',
      client_version: '2.2.0',
    });
    expect(app.botToken).toBe('xoxb-1');

    const createCall = fetchMock.mock.calls.find(([url]) => url === 'https://slack.com/api/apps.manifest.create');
    expect(createCall).toBeDefined();
    const params = new URLSearchParams((createCall![1] as { body: string }).body);
    expect([...params.keys()].sort()).toEqual(['generate_app_token', 'manifest']);
    // The manifest is byte-identical to one built without attribution fields.
    expect(JSON.parse(params.get('manifest')!)).toEqual(buildManagedAppManifest({ name: 'Trusty' }));
  });
});

describe('readManagerToken', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.SLACK_MANAGER_TOKEN;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('prefers process env over .env', () => {
    process.env.SLACK_MANAGER_TOKEN = 'xoxp-from-env';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    fs.writeFileSync(path.join(dir, '.env'), 'SLACK_MANAGER_TOKEN=xoxp-from-file\n');
    expect(readManagerToken(dir)).toBe('xoxp-from-env');
  });

  it('reads from .env, stripping quotes', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    fs.writeFileSync(path.join(dir, '.env'), 'OTHER=1\nSLACK_MANAGER_TOKEN="xoxp-from-file"\n');
    expect(readManagerToken(dir)).toBe('xoxp-from-file');
  });

  it('returns undefined when absent', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    fs.writeFileSync(path.join(dir, '.env'), 'OTHER=1\n');
    expect(readManagerToken(dir)).toBeUndefined();
  });
});

describe('slackServiceForRegistry', () => {
  it('swaps the host, keeping everything else about the deployment', () => {
    expect(slackServiceForRegistry('https://registry.nanoclaw.dev')).toBe('https://slack.nanoclaw.dev');
    expect(slackServiceForRegistry('https://registry.sandbox.nanoclaw.dev')).toBe('https://slack.sandbox.nanoclaw.dev');
    expect(slackServiceForRegistry('http://registry.localhost:8080')).toBe('http://slack.localhost:8080');
  });

  it('drops the path, query and userinfo a credential may have recorded', () => {
    expect(slackServiceForRegistry('https://user:pw@registry.sandbox.nanoclaw.dev/private?token=secret')).toBe(
      'https://slack.sandbox.nanoclaw.dev',
    );
  });

  it('declines to guess for anything that is not a registry host', () => {
    expect(slackServiceForRegistry(undefined)).toBeUndefined();
    expect(slackServiceForRegistry('')).toBeUndefined();
    expect(slackServiceForRegistry('not a url')).toBeUndefined();
    expect(slackServiceForRegistry('file:///registry.nanoclaw.dev')).toBeUndefined();
    // Same deployment, different naming: derive nothing rather than invent it.
    expect(slackServiceForRegistry('https://accounts.example.test')).toBeUndefined();
  });
});

describe('readServiceBase', () => {
  let dir: string | undefined;
  let configDir: string | undefined;

  /** An isolated pair of directories: never the developer's own credential. */
  function dirs(accountApi?: string): [string, string] {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-cfg-'));
    if (accountApi !== undefined) {
      fs.writeFileSync(path.join(configDir, 'account.json'), JSON.stringify({ api: accountApi, token: 'nct_x' }));
    }
    return [dir, configDir];
  }

  afterEach(() => {
    delete process.env.SLACK_SERVICE_BASE;
    for (const d of [dir, configDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
    dir = configDir = undefined;
  });

  it('defaults to the deployed service when nothing says otherwise', () => {
    expect(readServiceBase(...dirs())).toBe(DEFAULT_SLACK_SERVICE_BASE);
  });

  it('prefers process env and strips trailing slashes', () => {
    process.env.SLACK_SERVICE_BASE = 'https://slack-sandbox.example.dev/';
    expect(readServiceBase(...dirs())).toBe('https://slack-sandbox.example.dev');
  });

  it('reads from .env, stripping quotes', () => {
    const [root, cfg] = dirs();
    fs.writeFileSync(path.join(root, '.env'), 'SLACK_SERVICE_BASE="https://broker.example.test"\n');
    expect(readServiceBase(root, cfg)).toBe('https://broker.example.test');
  });

  it('follows the credential to its own deployment rather than the default', () => {
    expect(readServiceBase(...dirs('https://registry.sandbox.nanoclaw.dev'))).toBe(
      'https://slack.sandbox.nanoclaw.dev',
    );
  });

  it('lets an explicit setting override the credential it was issued against', () => {
    process.env.SLACK_SERVICE_BASE = 'https://slack.example.test';
    expect(readServiceBase(...dirs('https://registry.sandbox.nanoclaw.dev'))).toBe('https://slack.example.test');
  });

  it('falls back to the default when the credential records nothing to derive from', () => {
    expect(readServiceBase(...dirs('https://accounts.example.test'))).toBe(DEFAULT_SLACK_SERVICE_BASE);
    for (const d of [dir, configDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
    expect(readServiceBase(...dirs())).toBe(DEFAULT_SLACK_SERVICE_BASE);
  });
});

describe('readInstallToken', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.NANOCLAW_REGISTRY_TOKEN;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const writeAccount = (configDir: string, content: string): void => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'account.json'), content);
  };

  it('reads the token from account.json (the enrollment convention)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    writeAccount(
      dir,
      JSON.stringify({ version: 1, api: 'https://registry.example', account_id: 'acct_1', token: 'nct_abc123' }),
    );
    expect(readInstallToken(process.cwd(), dir)).toBe('nct_abc123');
  });

  it('prefers NANOCLAW_REGISTRY_TOKEN from the process env', () => {
    process.env.NANOCLAW_REGISTRY_TOKEN = 'nct_from_env';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    writeAccount(dir, JSON.stringify({ token: 'nct_from_file' }));
    expect(readInstallToken(process.cwd(), dir)).toBe('nct_from_env');
  });

  it('returns undefined when no account file exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    expect(readInstallToken(process.cwd(), dir)).toBeUndefined();
  });

  it('reads malformed or token-less files as "not enrolled" rather than throwing', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-prov-'));
    writeAccount(dir, 'not json{');
    expect(readInstallToken(process.cwd(), dir)).toBeUndefined();
    writeAccount(dir, JSON.stringify({ version: 1, token: '' }));
    expect(readInstallToken(process.cwd(), dir)).toBeUndefined();
    writeAccount(dir, JSON.stringify({ version: 1 }));
    expect(readInstallToken(process.cwd(), dir)).toBeUndefined();
    writeAccount(dir, JSON.stringify(['token']));
    expect(readInstallToken(process.cwd(), dir)).toBeUndefined();
  });
});

describe('mapBrokerApp', () => {
  it('maps a fully auto-installed app into the ProvisionedApp shape', () => {
    const app = mapBrokerApp({
      app_id: 'A0TEST123',
      team_id: 'T0TEAM456',
      name: 'Trusty',
      app_token: 'xapp-1-A0TEST123-x',
      bot_token: 'xoxb-000-bot',
      install_url: 'https://slack.com/oauth/install/A0TEST123',
      install_error: null,
    });
    expect(app).toEqual({
      appId: 'A0TEST123',
      appToken: 'xapp-1-A0TEST123-x',
      botToken: 'xoxb-000-bot',
      installUrl: 'https://slack.com/oauth/install/A0TEST123',
      installError: undefined,
    });
  });

  it('maps a refused auto-install: null bot_token → undefined, install_error carried', () => {
    const app = mapBrokerApp({
      app_id: 'A0TEST123',
      app_token: 'xapp-1-A0TEST123-x',
      bot_token: null,
      install_url: 'https://slack.com/oauth/install/A0TEST123',
      install_error: 'app_approval_request_eligible',
    });
    expect(app.botToken).toBeUndefined();
    expect(app.installError).toBe('app_approval_request_eligible');
    expect(app.installUrl).toBe('https://slack.com/oauth/install/A0TEST123');
  });

  it('tolerates absent optional fields — installUrl falls back to empty string', () => {
    const app = mapBrokerApp({ app_id: 'A1', app_token: 'xapp-1' });
    expect(app).toEqual({
      appId: 'A1',
      appToken: 'xapp-1',
      botToken: undefined,
      installUrl: '',
      installError: undefined,
    });
  });
});

describe('deferred install completion', () => {
  const fetchMock =
    vi.fn<(url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<unknown>>();

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.SLACK_SERVICE_BASE = 'https://broker.test';
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.SLACK_SERVICE_BASE;
    vi.unstubAllGlobals();
  });

  function response(status: number, payload: unknown): object {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
  }

  /** Answer each successive GET with the next scripted state. */
  function script(...states: Array<{ status: number; body: unknown }>): void {
    let i = 0;
    fetchMock.mockImplementation(async () => {
      const next = states[Math.min(i, states.length - 1)];
      i++;
      return response(next.status, next.body);
    });
  }

  /** A fast wait: the cadence under test is the constants' job, not the clock's. */
  const fast = { intervalMs: 1, timeoutMs: 60 };

  describe('brokerAppStatus', () => {
    it('reads one app over the authenticated GET', async () => {
      script({ status: 200, body: { app_id: 'A0PEND1', team_id: 'T1', name: 'Pixel', status: 'pending_install' } });

      await expect(brokerAppStatus('nct_x', 'A0PEND1')).resolves.toEqual({
        app_id: 'A0PEND1',
        team_id: 'T1',
        name: 'Pixel',
        status: 'pending_install',
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://broker.test/v1/apps/A0PEND1');
      expect(init?.method).toBe('GET');
      expect(init?.headers?.Authorization).toBe('Bearer nct_x');
    });

    it('escapes the app id rather than pasting it into the path', async () => {
      script({ status: 200, body: { app_id: 'x', status: 'installed' } });
      await brokerAppStatus('nct_x', 'A0/../v1/workspaces');
      expect(fetchMock.mock.calls[0][0]).toBe('https://broker.test/v1/apps/A0%2F..%2Fv1%2Fworkspaces');
    });

    it('surfaces an unknown app as a BrokerHttpError like every other call', async () => {
      script({ status: 404, body: { error: 'not_found' } });
      await expect(brokerAppStatus('nct_x', 'A0GONE')).rejects.toMatchObject({ name: 'BrokerHttpError', status: 404 });
    });
  });

  describe('waitForInstall', () => {
    it('polls while the workspace has not approved yet, then takes the one-time token', async () => {
      script(
        { status: 200, body: { app_id: 'A0PEND1', status: 'pending_install' } },
        { status: 200, body: { app_id: 'A0PEND1', status: 'pending_install' } },
        { status: 200, body: { app_id: 'A0PEND1', status: 'installed', bot_token: 'xoxb-finally' } },
      );

      await expect(waitForInstall('nct_x', 'A0PEND1', fast)).resolves.toEqual({ botToken: 'xoxb-finally' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('reports progress to the caller once per attempt', async () => {
      script(
        { status: 200, body: { status: 'pending_install' } },
        { status: 200, body: { status: 'installed', bot_token: 'xoxb-1' } },
      );
      const onPoll = vi.fn();

      await waitForInstall('nct_x', 'A0PEND1', { ...fast, onPoll });
      expect(onPoll).toHaveBeenCalledTimes(2);
      expect(onPoll.mock.calls.every(([elapsed]) => typeof elapsed === 'number')).toBe(true);
    });

    it('resolves null when the approval never lands — a timeout is not an error', async () => {
      script({ status: 200, body: { app_id: 'A0PEND1', status: 'pending_install' } });

      await expect(waitForInstall('nct_x', 'A0PEND1', fast)).resolves.toBeNull();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    it('stops on an app the service does not know (404) instead of waiting it out', async () => {
      script({ status: 404, body: { error: 'not_found' } });

      await expect(waitForInstall('nct_x', 'A0GONE', fast)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('stops on a deleted app', async () => {
      script({ status: 200, body: { app_id: 'A0DEAD', status: 'deleted' } });

      await expect(waitForInstall('nct_x', 'A0DEAD', fast)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('stops when the token was already released — polling cannot get a second copy', async () => {
      script({ status: 200, body: { app_id: 'A0PEND1', status: 'installed' } });

      await expect(waitForInstall('nct_x', 'A0PEND1', fast)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('polls through a service hiccup rather than giving up on it', async () => {
      script(
        { status: 502, body: { error: 'bad_gateway' } },
        { status: 200, body: { status: 'installed', bot_token: 'xoxb-after-hiccup' } },
      );

      await expect(waitForInstall('nct_x', 'A0PEND1', fast)).resolves.toEqual({ botToken: 'xoxb-after-hiccup' });
    });

    it('rethrows a credential refusal — the next poll cannot change that answer', async () => {
      script({ status: 401, body: { message: 'Install token expired.' } });

      await expect(waitForInstall('nct_x', 'A0PEND1', fast)).rejects.toMatchObject({
        name: 'BrokerHttpError',
        status: 401,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
