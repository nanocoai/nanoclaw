/**
 * Managed Slack app provisioning.
 *
 * When the operator holds a manager-app user token (xoxp-… with
 * app_configurations:write + managed_apps:install), we can create the
 * bot's Slack app programmatically instead of walking the operator through
 * api.slack.com/apps by hand:
 *
 *   1. apps.manifest.create — socket-mode manifest, generate_app_token=true
 *      so the response carries the xapp-… app-level token (no public URL
 *      needed, exactly matching the adapter's Socket Mode path)
 *   2. apps.managedInstall — bot-scopes-only apps auto-install and return
 *      the xoxb-… bot token directly
 *
 * Auto-install does not bypass Admin Approved Apps: on workspaces where the
 * admin rules reject it, managedInstall errors and the caller falls back to
 * the manual install URL (oauth_authorize_url from step 1).
 *
 * The manager token is read from SLACK_MANAGER_TOKEN (process env or .env).
 * It never persists into the container or session env — only the derived
 * bot + app tokens are handed to the add-slack skill.
 *
 * Broker transport ("hosts are always the initiator"): when this install is
 * enrolled with the NanoClaw registry, the same install token that gates the
 * hardened agent image also authenticates against the managed-Slack broker
 * (slack.nanoclaw.dev). The broker holds the Slack manager credential
 * server-side; the host only ever sees the derived per-app tokens. The
 * broker client lives here next to the direct-Slack path so callers can
 * pick whichever the install is set up for.
 *
 * This is the provisioning CORE — transport + manifest only, no prompts and
 * no wizard state. It lives under src/ (main build + test pass) rather than
 * setup/ because provisioning serves every agent's app creation, not just
 * first-time setup; the setup wizard is just one caller. Wizard UX stays in
 * setup/channels/slack-auto.ts.
 *
 * Nothing in this module loads on the default wizard path — it is reached
 * only through the NANOCLAW_SLACK_AGENTS-gated dynamic import chain rooted
 * in setup/channels/slack-auto-register.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SLACK_API = 'https://slack.com/api';

/** The deployed managed-Slack broker. Overridable via SLACK_SERVICE_BASE. */
export const DEFAULT_SLACK_SERVICE_BASE = 'https://slack.nanoclaw.dev';

/**
 * Superset of the add-slack skill's manual walkthrough: managed apps
 * additionally carry the mpim + im:write scopes for multi-bot rooms and the
 * post-provision welcome DM. Baked in at provision time deliberately —
 * adding scopes to a live app later needs a manifest update AND a reinstall,
 * a fleet migration we avoid by shipping the full template from day one.
 * Must match the broker service's server-side template — the two transports
 * must produce identical apps.
 */
export const BOT_SCOPES = [
  // Required by the app_mention event subscription; the Slack UI adds it
  // implicitly, so the manual walkthrough never lists it.
  'app_mentions:read',
  'chat:write',
  'channels:history',
  'groups:history',
  'im:history',
  'channels:read',
  'groups:read',
  'users:read',
  // users:read.email is deliberately ABSENT: it is outside the approved
  // scope set for provisioned apps. Scope additions must be approved for
  // that set BEFORE landing in any transport, or the manual-install
  // fallback breaks on the unapproved scope.
  'reactions:write',
  'mpim:write',
  'mpim:history',
  'mpim:read',
  'im:write',
  // Room-canvas surface: create/edit conversation canvases; files:read is
  // the read-back path (canvases are files, HTML download carries section ids).
  'canvases:read',
  'canvases:write',
  'files:read',
  // send_file: agents deliver files they produce (charts, documents,
  // generated artifacts) via files upload — live-verified missing_scope
  // failure without it (filesUploadV2 needs files:write).
  'files:write',
];

// member_joined/left_channel ride on the channels/groups/mpim:read scopes
// already present above (join-time adopt flow + membership bookkeeping).
export const BOT_EVENTS = [
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'app_mention',
  'member_joined_channel',
  'member_left_channel',
];

/**
 * Agent-mode (features.agent_view) additions — the default variant. Slack
 * auto-adds assistant:write when agent_view is enabled; declared explicitly
 * so the manifest states what the app holds. Guests are hard-blocked from
 * agent-enabled apps, so agentView:false selects the plain variant instead.
 */
export const AGENT_BOT_SCOPES = ['assistant:write'];

export const AGENT_BOT_EVENTS = ['app_home_opened', 'app_context_changed'];

/**
 * Fixed attribution: admins see this line, never a caller-supplied text.
 * Also the agent_view.agent_description (≤300 chars) on the agent-mode variant.
 */
export const MANAGED_APP_DESCRIPTION =
  'Personal AI agent, provisioned and managed by the NanoClaw app. Learn more at nanoclaw.dev/slack.';

/**
 * Optional request-origin metadata fields, all additive. On the broker
 * transport they ride the POST /v1/apps HTTP body verbatim (sent only when
 * defined — JSON serialization drops undefined values); a service that does
 * not know them ignores them. They NEVER influence the Slack app manifest,
 * scopes, or events, and the direct-Slack transport has nowhere to record
 * them, so it ignores them entirely. Field names are the wire contract —
 * snake_case, shared across every transport that provisions managed apps.
 */
export interface ProvisionAttribution {
  /** Slack user id of the human who asked for this app, when known. */
  requested_by?: string;
  /** The creating agent's own Slack app id, when an agent created this agent. */
  parent_app_id?: string;
  /** Template name, when the app was stamped from one. */
  template?: string;
  /** The installing host's package.json version. */
  client_version?: string;
}

export interface ManagedAppSpec extends ProvisionAttribution {
  name: string;
  description?: string;
  /**
   * agent_view is a one-way door decided at provision time (default true):
   * installs never fail on free plans (chrome degrades to a plain DM), but
   * agent apps are unusable by workspace guests — pass false for workspaces
   * that need guest access.
   */
  agentView?: boolean;
}

export function buildManagedAppManifest(spec: ManagedAppSpec): object {
  const agentView = spec.agentView ?? true;
  return {
    display_information: {
      name: spec.name,
      description: MANAGED_APP_DESCRIPTION,
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: spec.name,
        always_online: true,
      },
      ...(agentView ? { agent_view: { agent_description: MANAGED_APP_DESCRIPTION } } : {}),
    },
    oauth_config: {
      // Copies, not the module constants — callers extend these per app.
      scopes: { bot: agentView ? [...BOT_SCOPES, ...AGENT_BOT_SCOPES] : [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { bot_events: agentView ? [...BOT_EVENTS, ...AGENT_BOT_EVENTS] : [...BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export interface ProvisionedApp {
  appId: string;
  /** xapp-… app-level token for Socket Mode. */
  appToken: string;
  /** xoxb-… bot token — absent when auto-install was refused. */
  botToken?: string;
  /**
   * Install URL for the browser — the fallback when auto-install was refused.
   * On the broker transport it arrives with its own signed state and stays
   * valid for days, so a caller can hand it to a human and pick the app up
   * afterwards with `waitForInstall` instead of provisioning a second one.
   */
  installUrl: string;
  teamDomain?: string;
  /** managedInstall error when auto-install was refused (e.g. app_approval_request_eligible). */
  installError?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

async function slackApi<T extends SlackApiResponse>(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`${method}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Create and (attempt to) install a managed Slack app. Throws on creation
 * failure; a refused auto-install is not an error — the result carries the
 * manual install URL and `installError` instead of `botToken`.
 */
export async function provisionManagedApp(managerToken: string, spec: ManagedAppSpec): Promise<ProvisionedApp> {
  const manifest = buildManagedAppManifest(spec);
  const created = await slackApi<
    SlackApiResponse & {
      app_id?: string;
      app_token?: string;
      oauth_authorize_url?: string;
      team_domain?: string;
    }
  >('apps.manifest.create', managerToken, {
    manifest: JSON.stringify(manifest),
    generate_app_token: 'true',
  });
  if (!created.ok || !created.app_id) {
    throw new Error(`apps.manifest.create failed: ${created.error ?? 'no app_id in response'}`);
  }
  if (!created.app_token) {
    throw new Error('apps.manifest.create returned no app-level token (generate_app_token unsupported?)');
  }

  const result: ProvisionedApp = {
    appId: created.app_id,
    appToken: created.app_token,
    installUrl: created.oauth_authorize_url ?? '',
    teamDomain: created.team_domain,
  };

  const installed = await slackApi<
    SlackApiResponse & {
      api_access_tokens?: { bot_access_token?: string };
    }
  >('apps.managedInstall', managerToken, { app_id: created.app_id });
  if (installed.ok && installed.api_access_tokens?.bot_access_token) {
    result.botToken = installed.api_access_tokens.bot_access_token;
  } else {
    result.installError = installed.error ?? 'no bot token in response';
  }
  return result;
}

/** Process env first, then the install's .env — the same order everywhere. */
function readEnvSetting(key: string, projectRoot: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const envFile = fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8');
    const match = envFile.match(new RegExp(`^${key}=(.+)$`, 'm'));
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Manager token from process env or the install's .env. Presence of the
 * token is what unlocks the auto-provision option in the setup flow.
 */
export function readManagerToken(projectRoot = process.cwd()): string | undefined {
  return readEnvSetting('SLACK_MANAGER_TOKEN', projectRoot);
}

// ---------------------------------------------------------------------------
// Broker transport — the managed-Slack service at slack.nanoclaw.dev.

/** Per-user credential directory — where enrollment persists account.json. */
function defaultConfigDir(): string {
  return path.join(os.homedir(), '.config', 'nanoclaw');
}

/**
 * The Slack-side service belonging to a given account service.
 *
 * The two are halves of one deployment: this service authenticates the
 * install token that service minted, so a token from one is not a credential
 * at the other. Nothing on disk records the pairing, and the two are
 * configured independently — which is how an install ends up presenting a
 * token from one deployment to the other and reading the refusal as an
 * outage.
 *
 * Host swap only, `registry.<rest>` → `slack.<rest>`, so a deployment that
 * follows the same naming is derived correctly and one that does not yields
 * undefined rather than a guess.
 */
export function slackServiceForRegistry(api: string | undefined): string | undefined {
  if (!api) return undefined;
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (!url.hostname.startsWith('registry.')) return undefined;
  url.hostname = `slack.${url.hostname.slice('registry.'.length)}`;
  // `origin` drops any path, query and userinfo the credential recorded.
  return url.origin;
}

/** The account service that issued the credential on disk, if it recorded one. */
function readAccountApi(configDir: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'account.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const api = (parsed as { api?: unknown }).api;
  return typeof api === 'string' && api.trim() ? api.trim() : undefined;
}

/**
 * Broker base URL: SLACK_SERVICE_BASE (process env or .env) first, then the
 * service implied by whoever issued the credential we are about to send, and
 * only then the default.
 *
 * Deriving beats defaulting because the credential is the thing being spent:
 * pairing it with a service that cannot know it produces a 401 that reads as
 * "Slack is down". An explicit setting still wins — pointing the two halves
 * at different deployments is a thing an operator may need to do deliberately.
 *
 * A token supplied through NANOCLAW_REGISTRY_TOKEN has no account record to
 * derive from and falls through to the default, so a CI caller retargeting
 * the service must set SLACK_SERVICE_BASE too.
 */
export function readServiceBase(projectRoot = process.cwd(), configDir = defaultConfigDir()): string {
  const explicit = readEnvSetting('SLACK_SERVICE_BASE', projectRoot);
  const value = explicit ?? slackServiceForRegistry(readAccountApi(configDir)) ?? DEFAULT_SLACK_SERVICE_BASE;
  return value.replace(/\/+$/, '');
}

/**
 * The registry install token, exactly where enrollment persists it:
 * `~/.config/nanoclaw/account.json` (per-user, not per-checkout — see
 * `readRegistryAccount` in setup/lib/registry-state.ts; `{ token: "…" }` is
 * the only required field). A malformed or missing file reads as "not
 * enrolled" rather than throwing — the next move (fall back to the
 * manager-token or manual path) is the same either way.
 *
 * `NANOCLAW_REGISTRY_TOKEN` in the process env wins, matching the login
 * driver's CI path. `projectRoot` is accepted for signature parity with
 * `readManagerToken` but the credential is deliberately per-user;
 * `configDir` is overridable for tests only.
 */
export function readInstallToken(_projectRoot = process.cwd(), configDir = defaultConfigDir()): string | undefined {
  const fromEnv = process.env.NANOCLAW_REGISTRY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'account.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const token = (parsed as { token?: unknown }).token;
  return typeof token === 'string' && token.trim() ? token : undefined;
}

/** Broker failure with enough context to say what broke, never the token. */
export class BrokerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail?: string,
  ) {
    super(`Slack service ${path}: HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'BrokerHttpError';
  }
}

/**
 * One authenticated round-trip to the broker. Throws `BrokerHttpError` on any
 * non-2xx (with the body's `error`/`message` when it has one) and on a 2xx
 * body that isn't JSON — callers never have to inspect a Response.
 */
export async function brokerRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  apiPath: string,
  token: string,
  body?: object,
  base = readServiceBase(),
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new BrokerHttpError(0, apiPath, err instanceof Error ? err.message : String(err));
  }
  const text = await res.text();
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      // message is the human sentence ("Install token expired. Re-run
      // nanoclaw login."); error is the machine code. Show the human one.
      detail = parsed.message ?? parsed.error;
    } catch {
      detail = text.trim().slice(0, 200) || undefined;
    }
    throw new BrokerHttpError(res.status, apiPath, detail);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BrokerHttpError(res.status, apiPath, 'response was not JSON');
  }
}

/** A workspace the operator has connected to the broker via OAuth. */
export interface BrokerWorkspace {
  team_id: string;
  team_name: string;
  status: string;
  connected_as?: string;
  connected_at?: string;
}

/** OAuth URL the operator opens to connect a workspace to the broker. */
export async function brokerOauthUrl(token: string): Promise<{ url: string }> {
  const res = await brokerRequest<{ url?: string }>('POST', '/v1/slack/oauth/url', token, {});
  if (!res.url) throw new BrokerHttpError(200, '/v1/slack/oauth/url', 'no url in response');
  return { url: res.url };
}

export async function brokerListWorkspaces(token: string): Promise<BrokerWorkspace[]> {
  const res = await brokerRequest<{ workspaces?: BrokerWorkspace[] }>('GET', '/v1/workspaces', token);
  return res.workspaces ?? [];
}

// ── Avatar generation (broker-side) ──

/** Poll cap for the pre-create avatar job — beyond it the bot keeps the default icon. */
const AVATAR_WAIT_MS = 75_000;
// Generation measures ~20-23s at the broker's floor settings — a 2s poll
// wastes at most ~2s of that.
const AVATAR_POLL_MS = 2_000;

/**
 * Ask the broker to generate the agent's avatar BEFORE the app exists, so
 * the bot's first workspace appearance already carries it. Returns undefined
 * when generation is unavailable, failed, or over the wait cap — the
 * degraded path is the default icon, never an error.
 */
export async function requestAvatar(
  baseUrl: string,
  installToken: string,
  displayName: string,
  description: string | undefined,
): Promise<string | undefined> {
  let avatarId: string | undefined;
  try {
    const res = await fetch(`${baseUrl}/v1/avatars`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${installToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: displayName, ...(description ? { description } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { avatar_id?: string | null };
    avatarId = data.avatar_id ?? undefined;
  } catch {
    return undefined;
  }
  if (!avatarId) return undefined;
  const deadline = Date.now() + AVATAR_WAIT_MS;
  for (let first = true; Date.now() < deadline; first = false) {
    if (!first) await new Promise((r) => setTimeout(r, AVATAR_POLL_MS));
    try {
      const res = await fetch(`${baseUrl}/v1/avatars/${avatarId}`, {
        headers: { Authorization: `Bearer ${installToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { status?: string };
      if (data.status === 'ready') return avatarId;
      if (data.status && data.status !== 'pending') return undefined;
    } catch {
      // Transient — bounded by the deadline.
    }
  }
  return undefined;
}

// ── Deferred install completion ──
//
// A workspace with an admin-approval policy refuses auto-install, so
// POST /v1/apps answers with `install_url` and no bot token. That URL carries
// its own signed state and stays valid for days, so the app is not lost — it
// sits at `pending_install` until someone completes the OAuth install in the
// browser. These two helpers are the client half of finishing that: ask the
// service what state the app is in, and wait for the bot token that appears
// when the install lands.

/** Poll cadence for a pending install — the workspace-connect cadence. */
export const INSTALL_POLL_INTERVAL_MS = 5_000;
/** How long a caller waits inline before parking the app and moving on. */
export const INSTALL_POLL_TIMEOUT_MS = 5 * 60_000;

/** GET /v1/apps/{app_id} — one provisioned app's current state. */
export interface BrokerAppState {
  app_id: string;
  team_id?: string;
  name?: string;
  status: 'installed' | 'pending_install' | 'deleted';
  /**
   * xoxb-… — released EXACTLY ONCE, on the first read after the install
   * completes. Absent before the install and on every read after the one that
   * carried it, so a caller that drops it cannot ask for it again.
   */
  bot_token?: string | null;
}

/**
 * One app's state. Throws `BrokerHttpError` like every other broker call —
 * 404 means the service has no such app under this install's credentials.
 */
export async function brokerAppStatus(token: string, appId: string): Promise<BrokerAppState> {
  return brokerRequest<BrokerAppState>('GET', `/v1/apps/${encodeURIComponent(appId)}`, token);
}

/**
 * Wait for a pending install to complete, then hand back the one-time bot
 * token. Resolves null when the wait runs out, when the service does not know
 * the app (404), and when the app is gone (`deleted`) — all of which mean the
 * same thing to a caller: stop waiting and offer the manual path. Transient
 * failures (5xx, a dropped connection) are polled through rather than
 * surfaced, since the deadline already bounds them.
 *
 * A credential refusal is the exception: it is not going to change on the next
 * poll, and reading it as a timeout would blame the workspace for something
 * that is the install's to fix, so it is rethrown.
 */
export async function waitForInstall(
  token: string,
  appId: string,
  opts: { intervalMs?: number; timeoutMs?: number; onPoll?: (elapsedMs: number) => void } = {},
): Promise<{ botToken: string } | null> {
  const intervalMs = opts.intervalMs ?? INSTALL_POLL_INTERVAL_MS;
  const start = Date.now();
  const deadline = start + (opts.timeoutMs ?? INSTALL_POLL_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    opts.onPoll?.(Date.now() - start);
    let state: BrokerAppState;
    try {
      state = await brokerAppStatus(token, appId);
    } catch (err) {
      if (err instanceof BrokerHttpError && (err.status === 401 || err.status === 403)) throw err;
      if (err instanceof BrokerHttpError && err.status === 404) return null;
      continue;
    }
    if (state.status === 'deleted') return null;
    if (state.status === 'installed') {
      // Installed with no token is the read AFTER the one that released it —
      // terminal, not slow, so waiting out the deadline would only delay the
      // manual path by five minutes.
      return state.bot_token ? { botToken: state.bot_token } : null;
    }
  }
  return null;
}

/** The broker's POST /v1/apps response shape. */
export interface BrokerAppResponse {
  app_id: string;
  team_id?: string;
  name?: string;
  /** xapp-… app-level token for Socket Mode. */
  app_token: string;
  /** xoxb-… bot token — null when auto-install was refused. */
  bot_token?: string | null;
  install_url?: string | null;
  install_error?: string | null;
}

/**
 * Broker response → the same `ProvisionedApp` shape the direct-Slack path
 * produces, so everything downstream of provisioning is transport-agnostic.
 */
export function mapBrokerApp(res: BrokerAppResponse): ProvisionedApp {
  return {
    appId: res.app_id,
    appToken: res.app_token,
    botToken: res.bot_token ?? undefined,
    installUrl: res.install_url ?? '',
    installError: res.install_error ?? undefined,
  };
}

/**
 * Create (and attempt to install) a managed app via the broker. Mirrors
 * `provisionManagedApp`'s contract: throws on creation failure; a refused
 * auto-install comes back as `installError` + `installUrl`, not an error.
 */
export async function brokerProvision(
  token: string,
  spec: {
    team_id: string;
    name: string;
    description?: string;
    icon_url?: string;
    allow_guests?: boolean;
  } & ProvisionAttribution,
): Promise<ProvisionedApp> {
  // Avatar-first: generate the avatar BEFORE the app exists so the bot's
  // first appearance already wears it — undefined degrades to the default icon.
  const avatarId = await requestAvatar(readServiceBase(), token, spec.name, spec.description);
  const res = await brokerRequest<Partial<BrokerAppResponse>>('POST', '/v1/apps', token, {
    ...spec,
    ...(avatarId ? { avatar_id: avatarId } : {}),
  });
  if (!res.app_id || !res.app_token) {
    throw new BrokerHttpError(200, '/v1/apps', 'response missing app_id or app_token');
  }
  return mapBrokerApp(res as BrokerAppResponse);
}
