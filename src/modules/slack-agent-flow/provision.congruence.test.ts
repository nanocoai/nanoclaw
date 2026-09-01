/**
 * Congruence pins for provision.ts, which deliberately duplicates its broker
 * protocol and manifest out of the trunk provisioning module
 * src/provisioning/slack-app.ts and
 * .claude/skills/slack-managed-agents/scripts/slack-create-agent.ts.
 *
 * ALL transports carry the same
 * template: BASE + canvas scopes, BASE + membership events, and the
 * agent-mode (agent_view) variant pair — matching the broker's BOT_SCOPES /
 * BOT_EVENTS / AGENT_BOT_* in nanocoai/infra: modules/nanoclaw-slack lambda
 * service/index.mjs. The pins here hold the mirrors (read as source text —
 * they are not importable from src/) equal to provision.ts's own sets, and
 * provision.ts equal to the documented BASE + additions.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BROKER_BASE,
  MANAGED_AGENT_BOT_EVENTS,
  MANAGED_AGENT_BOT_SCOPES,
  MANAGED_APP_DESCRIPTION,
  MANAGED_BOT_EVENTS,
  MANAGED_BOT_SCOPES,
  buildManagedAppManifest,
  provisionSlackApp,
  resolveProvisioningCredential,
} from './provision.js';

const CREATE_AGENT_SCRIPT = path.resolve(
  process.cwd(),
  '.claude/skills/slack-managed-agents/scripts/slack-create-agent.ts',
);
const SLACK_PROVISION = path.resolve(process.cwd(), 'src/provisioning/slack-app.ts');

/**
 * The base managed-app sets, before the additions below. Kept literal so
 * drift in either direction is loud.
 */
const BASE_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'channels:history',
  'groups:history',
  'im:history',
  'channels:read',
  'groups:read',
  'users:read',
  'reactions:write',
  'mpim:write',
  'mpim:history',
  'mpim:read',
  'im:write',
];
const BASE_BOT_EVENTS = ['message.channels', 'message.groups', 'message.im', 'message.mpim', 'app_mention'];

/** Additions over the base set (room canvas + read-back; membership events). */
const CANVAS_SCOPES = ['canvases:read', 'canvases:write', 'files:read'];
const MEMBERSHIP_EVENTS = ['member_joined_channel', 'member_left_channel'];

/** send_file: files.upload needs files:write, distinct from the canvas read-back path. */
const SEND_FILE_SCOPES = ['files:write'];

/** All single-quoted strings inside `export const <name> = […]`, comments stripped. */
function extractStringArray(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export const ${name}[^=]*= \\[([\\s\\S]*?)\\];`));
  expect(m, `export const ${name} = […] not found in mirror source`).toBeTruthy();
  const body = m![1].replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

// The slack-managed-agents skill is optional (its install leg is coupled to
// the managed-app provisioning service) — the mirror pins run wherever its
// skill directory is present and skip cleanly where it is not. When present
// it MUST match; the path is pinned literally, so a moved script fails loudly.
describe.skipIf(!fs.existsSync(CREATE_AGENT_SCRIPT))('provision.ts congruence with slack-create-agent.ts', () => {
  it("the mirror's scope/event sets match provision.ts exactly", () => {
    const src = fs.readFileSync(CREATE_AGENT_SCRIPT, 'utf-8');
    expect(extractStringArray(src, 'MANAGED_BOT_SCOPES')).toEqual([...MANAGED_BOT_SCOPES]);
    expect(extractStringArray(src, 'MANAGED_BOT_EVENTS')).toEqual([...MANAGED_BOT_EVENTS]);
    expect(extractStringArray(src, 'MANAGED_AGENT_BOT_SCOPES')).toEqual([...MANAGED_AGENT_BOT_SCOPES]);
    expect(extractStringArray(src, 'MANAGED_AGENT_BOT_EVENTS')).toEqual([...MANAGED_AGENT_BOT_EVENTS]);
  });

  it("the mirror's manifest carries the agent_view variant pair", () => {
    const src = fs.readFileSync(CREATE_AGENT_SCRIPT, 'utf-8');
    expect(src).toContain('agentView?: boolean');
    expect(src).toContain('agent_view: { agent_description: MANAGED_APP_DESCRIPTION }');
    expect(src).toContain('--allow-guests');
  });
});

describe('provision.ts congruence with src/provisioning/slack-app.ts sets', () => {
  it("the trunk provisioning module's scope/event sets match provision.ts exactly", () => {
    const src = fs.readFileSync(SLACK_PROVISION, 'utf-8');
    expect(extractStringArray(src, 'BOT_SCOPES')).toEqual([...MANAGED_BOT_SCOPES]);
    expect(extractStringArray(src, 'BOT_EVENTS')).toEqual([...MANAGED_BOT_EVENTS]);
    expect(extractStringArray(src, 'AGENT_BOT_SCOPES')).toEqual([...MANAGED_AGENT_BOT_SCOPES]);
    expect(extractStringArray(src, 'AGENT_BOT_EVENTS')).toEqual([...MANAGED_AGENT_BOT_EVENTS]);
  });

  it("the trunk provisioning module's manifest carries the agent_view variant pair", () => {
    const src = fs.readFileSync(SLACK_PROVISION, 'utf-8');
    expect(src).toContain('agentView?: boolean');
    expect(src).toContain('agent_view: { agent_description: MANAGED_APP_DESCRIPTION }');
  });
});

describe('provision.ts manifest shape (broker-congruent, both variants)', () => {
  it('MANAGED_BOT_SCOPES = base + canvas scopes + send_file scope, bot scopes only', () => {
    expect([...MANAGED_BOT_SCOPES]).toEqual([...BASE_BOT_SCOPES, ...CANVAS_SCOPES, ...SEND_FILE_SCOPES]);
  });

  it('MANAGED_BOT_EVENTS = base + membership events', () => {
    expect([...MANAGED_BOT_EVENTS]).toEqual([...BASE_BOT_EVENTS, ...MEMBERSHIP_EVENTS]);
  });

  it('agent-mode additions are exactly assistant:write + the two agent events', () => {
    expect([...MANAGED_AGENT_BOT_SCOPES]).toEqual(['assistant:write']);
    expect([...MANAGED_AGENT_BOT_EVENTS]).toEqual(['app_home_opened', 'app_context_changed']);
  });

  interface ManifestShape {
    display_information: { name: string; description: string };
    features: {
      bot_user: { display_name: string; always_online: boolean };
      agent_view?: { agent_description: string };
    };
    oauth_config: { scopes: { bot: string[]; user?: string[] } };
    settings: {
      event_subscriptions: { bot_events: string[] };
      socket_mode_enabled: boolean;
      interactivity: { is_enabled: boolean };
    };
  }

  it('default variant is agent-mode: agent_view + assistant:write + agent events', () => {
    const manifest = buildManagedAppManifest('Research') as unknown as ManifestShape;
    expect(manifest.display_information.name).toBe('Research');
    expect(manifest.display_information.description).toBe(MANAGED_APP_DESCRIPTION);
    expect(manifest.features.bot_user).toEqual({ display_name: 'Research', always_online: true });
    // The agent_description doubles as the attribution line (≤300-char field).
    expect(manifest.features.agent_view).toEqual({ agent_description: MANAGED_APP_DESCRIPTION });
    expect(MANAGED_APP_DESCRIPTION.length).toBeLessThanOrEqual(300);
    expect(manifest.oauth_config.scopes.bot).toEqual([...MANAGED_BOT_SCOPES, ...MANAGED_AGENT_BOT_SCOPES]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      ...MANAGED_BOT_EVENTS,
      ...MANAGED_AGENT_BOT_EVENTS,
    ]);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
  });

  it('plain variant (agentView:false) omits agent_view, assistant:write, and the agent events', () => {
    const manifest = buildManagedAppManifest('Research', { agentView: false }) as unknown as ManifestShape;
    expect(manifest.features.agent_view).toBeUndefined();
    expect(manifest.oauth_config.scopes.bot).toEqual([...MANAGED_BOT_SCOPES]);
    expect(manifest.oauth_config.scopes.bot).not.toContain('assistant:write');
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([...MANAGED_BOT_EVENTS]);
    for (const ev of MANAGED_AGENT_BOT_EVENTS) {
      expect(manifest.settings.event_subscriptions.bot_events).not.toContain(ev);
    }
    // Both still carry the always-on additions.
    for (const scope of CANVAS_SCOPES) expect(manifest.oauth_config.scopes.bot).toContain(scope);
    for (const scope of SEND_FILE_SCOPES) expect(manifest.oauth_config.scopes.bot).toContain(scope);
    for (const ev of MEMBERSHIP_EVENTS) expect(manifest.settings.event_subscriptions.bot_events).toContain(ev);
    expect(manifest.display_information.description).toBe(MANAGED_APP_DESCRIPTION);
  });

  it('both variants stay bot-scopes-only (apps.managedInstall eligibility)', () => {
    for (const agentView of [true, false]) {
      const manifest = buildManagedAppManifest('Research', { agentView }) as unknown as ManifestShape;
      expect(Object.keys(manifest.oauth_config.scopes)).toEqual(['bot']);
    }
  });
});

describe('provision.ts congruence with src/provisioning/slack-app.ts', () => {
  it('broker base + override key + endpoint match the trunk provisioning module', () => {
    expect(fs.existsSync(SLACK_PROVISION), `${SLACK_PROVISION} not found — the trunk provisioning module moved?`).toBe(
      true,
    );
    const src = fs.readFileSync(SLACK_PROVISION, 'utf-8');
    const base = src.match(/export const DEFAULT_SLACK_SERVICE_BASE = '([^']+)'/);
    expect(base?.[1]).toBe(DEFAULT_BROKER_BASE);
    expect(src).toContain("'SLACK_SERVICE_BASE'");
    expect(src).toContain("'/v1/apps'");
  });
});

describe('provisionSlackApp broker body (allow_guests threading)', () => {
  let rootDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-prov-broker-'));
    fs.writeFileSync(path.join(rootDir, '.env'), 'NANOCLAW_INSTALL_TOKEN=install-token-1\n');
    for (const key of ['NANOCLAW_REGISTRY_TOKEN', 'SLACK_MANAGER_TOKEN', 'SLACK_SERVICE_BASE']) {
      vi.stubEnv(key, '');
    }
    fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/v1/avatars')) {
        // Generation unavailable → no avatar poll loop, no avatar_id in the create body.
        return new Response(JSON.stringify({ avatar_id: null, status: 'unavailable' }), { status: 200 });
      }
      if (u.endsWith('/v1/apps')) {
        return new Response(JSON.stringify({ app_id: 'A123', app_token: 'xapp-test', bot_token: 'xoxb-test' }), {
          status: 201,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const createBody = (): Record<string, unknown> => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/apps'));
    expect(call, 'POST /v1/apps was never called').toBeTruthy();
    return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
  };

  it('omits allow_guests by default (broker provisions the agent-mode variant)', async () => {
    const result = await provisionSlackApp({ slug: 'pixel', displayName: 'Pixel', rootDir, teamId: 'T1' });
    expect(result.reused).toBe(false);
    expect(createBody()).toEqual({ team_id: 'T1', name: 'Pixel' });
  });

  it('threads allowGuests:true into the body as allow_guests (plain variant)', async () => {
    await provisionSlackApp({ slug: 'pixel', displayName: 'Pixel', rootDir, teamId: 'T1', allowGuests: true });
    expect(createBody()).toEqual({ team_id: 'T1', name: 'Pixel', allow_guests: true });
  });
});

describe('resolveProvisioningCredential', () => {
  let rootDir: string;
  let homeDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-prov-root-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-prov-home-'));
    // Neutralize the real environment — every key this resolver consults.
    for (const key of [
      'NANOCLAW_REGISTRY_TOKEN',
      'NANOCLAW_INSTALL_TOKEN',
      'SLACK_MANAGER_TOKEN',
      'SLACK_SERVICE_BASE',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const writeEnv = (lines: string[]): void => fs.writeFileSync(path.join(rootDir, '.env'), lines.join('\n') + '\n');
  const writeAccount = (content: string): void => {
    const dir = path.join(homeDir, '.config', 'nanoclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'account.json'), content);
  };
  const resolve = (): ReturnType<typeof resolveProvisioningCredential> =>
    resolveProvisioningCredential(rootDir, { homeDir });

  it('returns null when no credential exists anywhere', () => {
    expect(resolve()).toBeNull();
  });

  it('process.env NANOCLAW_REGISTRY_TOKEN wins over every other source', () => {
    vi.stubEnv('NANOCLAW_REGISTRY_TOKEN', 'registry-token-from-env');
    writeEnv(['NANOCLAW_INSTALL_TOKEN=install-token-from-file', 'SLACK_MANAGER_TOKEN=manager-token-1']);
    writeAccount(JSON.stringify({ token: 'account-token' }));
    expect(resolve()).toEqual({
      mode: 'broker',
      installToken: 'registry-token-from-env',
      baseUrl: DEFAULT_BROKER_BASE,
    });
  });

  it('.env NANOCLAW_INSTALL_TOKEN beats account.json and the manager token', () => {
    writeEnv(['NANOCLAW_INSTALL_TOKEN=install-token-from-file', 'SLACK_MANAGER_TOKEN=manager-token-1']);
    writeAccount(JSON.stringify({ token: 'account-token' }));
    expect(resolve()).toEqual({
      mode: 'broker',
      installToken: 'install-token-from-file',
      baseUrl: DEFAULT_BROKER_BASE,
    });
  });

  it('falls back to ~/.config/nanoclaw/account.json before direct mode', () => {
    writeEnv(['SLACK_MANAGER_TOKEN=manager-token-1']);
    writeAccount(JSON.stringify({ token: 'account-token' }));
    expect(resolve()).toEqual({ mode: 'broker', installToken: 'account-token', baseUrl: DEFAULT_BROKER_BASE });
  });

  it('malformed account.json reads as not-enrolled, not an error', () => {
    writeAccount('{not json');
    writeEnv(['SLACK_MANAGER_TOKEN=manager-token-1']);
    expect(resolve()).toEqual({ mode: 'direct', managerToken: 'manager-token-1' });
  });

  it('account.json without a usable token field reads as not-enrolled', () => {
    writeAccount(JSON.stringify({ token: '   ' }));
    expect(resolve()).toBeNull();
  });

  it('SLACK_MANAGER_TOKEN alone selects direct mode', () => {
    writeEnv(['SLACK_MANAGER_TOKEN=manager-token-1']);
    expect(resolve()).toEqual({ mode: 'direct', managerToken: 'manager-token-1' });
  });

  it('SLACK_SERVICE_BASE overrides the broker base, trailing slashes stripped', () => {
    writeEnv(['NANOCLAW_INSTALL_TOKEN=install-token-from-file', 'SLACK_SERVICE_BASE=https://broker.example.test///']);
    expect(resolve()).toEqual({
      mode: 'broker',
      installToken: 'install-token-from-file',
      baseUrl: 'https://broker.example.test',
    });
  });
});
