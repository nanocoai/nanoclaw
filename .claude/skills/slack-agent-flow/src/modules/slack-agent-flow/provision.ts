/**
 * Managed Slack app provisioning for the slack-agent-flow leg.
 *
 * CONGRUENCE — this file deliberately duplicates:
 * - src/provisioning/slack-app.ts (trunk provisioning module) — broker
 *   protocol (install token from
 *   ~/.config/nanoclaw/account.json or NANOCLAW_REGISTRY_TOKEN, base
 *   SLACK_SERVICE_BASE else https://slack.nanoclaw.dev, POST /v1/apps) and the
 *   direct apps.manifest.create + apps.managedInstall pair.
 * - .claude/skills/slack-managed-agents/scripts/slack-create-agent.ts —
 *   MANAGED_BOT_SCOPES / MANAGED_BOT_EVENTS / buildManagedAppManifest,
 *   credential resolution order, and the crash-safe persist-before-return
 *   .env write (its step 1/3).
 * This file, both mirrors, and the broker's server template all carry the
 * SAME sets: base + canvas scopes, membership events, and the agent_view
 * variant pair.
 * provision.congruence.test.ts pins the mirrors against this file's sets and
 * this file against the broker contract.
 *
 * The manager/install token is read, used as a Bearer header, and forgotten.
 * Only the derived per-app bot/app tokens persist (to .env). No token value
 * is ever logged or embedded in an error message.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendToEnvList, readEnvValue, upsertEnvKey } from './env-file.js';
import { SlackFlowError, type ProvisionInput, type ProvisionResult } from './types.js';

const SLACK_API = 'https://slack.com/api';

/** The deployed managed-Slack broker. Overridable via SLACK_SERVICE_BASE. */
export const DEFAULT_BROKER_BASE = 'https://slack.nanoclaw.dev';

/**
 * The managed-apps bot scope set — bot scopes only, no user scopes (that is
 * the apps.managedInstall eligibility rule). Superset of MANAGED_BOT_SCOPES
 * in slack-create-agent.ts (the base set) plus the canvas scopes; must stay
 * identical to the broker's server-side BOT_SCOPES — apps provisioned via
 * either transport must be scope-identical (pinned by
 * provision.congruence.test.ts). im:write is what lets the new bot open the
 * operator DM; mpim:* is what lets it open the three-way room; canvases:* +
 * files:read is the room-canvas surface (files:read is the read-back path —
 * canvases are files, the HTML download carries section ids).
 */
export const MANAGED_BOT_SCOPES: readonly string[] = [
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
  'canvases:read',
  'canvases:write',
  'files:read',
  // send_file: agents deliver files they produce (charts, documents,
  // generated artifacts) via files upload — live-verified missing_scope
  // failure without it (filesUploadV2 needs files:write).
  'files:write',
];

// member_joined/left_channel ride on the channels/groups/mpim:read scopes
// already present (join-time adopt flow + membership bookkeeping).
export const MANAGED_BOT_EVENTS: readonly string[] = [
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
 * agent-enabled apps, so allowGuests selects the plain variant instead.
 */
export const MANAGED_AGENT_BOT_SCOPES: readonly string[] = ['assistant:write'];

export const MANAGED_AGENT_BOT_EVENTS: readonly string[] = ['app_home_opened', 'app_context_changed'];

/**
 * Fixed attribution line: admins see this, never the creation prompt. Also
 * the agent_view.agent_description (≤300 chars) on the agent-mode variant.
 */
export const MANAGED_APP_DESCRIPTION =
  'Personal AI agent, provisioned and managed by the NanoClaw app. Learn more at nanoclaw.dev/slack.';

/**
 * Socket-Mode-only managed-app manifest (see the congruence note above).
 * Two variants, chosen at provision time — agent_view is a one-way door:
 * agent-mode (default; free workspaces degrade to a plain DM) and plain
 * (agentView:false, for workspaces that need guest access).
 */
export function buildManagedAppManifest(
  displayName: string,
  opts: { agentView?: boolean } = {},
): Record<string, unknown> {
  const agentView = opts.agentView ?? true;
  return {
    display_information: {
      name: displayName,
      description: MANAGED_APP_DESCRIPTION,
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: displayName,
        always_online: true,
      },
      ...(agentView ? { agent_view: { agent_description: MANAGED_APP_DESCRIPTION } } : {}),
    },
    oauth_config: {
      scopes: { bot: agentView ? [...MANAGED_BOT_SCOPES, ...MANAGED_AGENT_BOT_SCOPES] : [...MANAGED_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        bot_events: agentView ? [...MANAGED_BOT_EVENTS, ...MANAGED_AGENT_BOT_EVENTS] : [...MANAGED_BOT_EVENTS],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Which provisioning credential this install holds, in the decisive order:
 * process.env.NANOCLAW_REGISTRY_TOKEN → .env NANOCLAW_INSTALL_TOKEN →
 * ~/.config/nanoclaw/account.json (broker mode; base = SLACK_SERVICE_BASE
 * else DEFAULT_BROKER_BASE) → .env SLACK_MANAGER_TOKEN (direct mode) → null.
 *
 * `opts.homeDir` overrides os.homedir() for tests only — the account.json
 * credential is deliberately per-user, not per-checkout.
 */
export function resolveProvisioningCredential(
  rootDir: string,
  opts: { homeDir?: string } = {},
): { mode: 'broker'; installToken: string; baseUrl: string } | { mode: 'direct'; managerToken: string } | null {
  const baseUrl = (readEnvValue(rootDir, 'SLACK_SERVICE_BASE') ?? DEFAULT_BROKER_BASE).replace(/\/+$/, '');

  const fromEnv = process.env.NANOCLAW_REGISTRY_TOKEN?.trim();
  if (fromEnv) return { mode: 'broker', installToken: fromEnv, baseUrl };

  const installToken = readEnvValue(rootDir, 'NANOCLAW_INSTALL_TOKEN');
  if (installToken) return { mode: 'broker', installToken, baseUrl };

  // Enrollment persists the install token at ~/.config/nanoclaw/account.json
  // ({ token: "…" }). Malformed or missing reads as "not enrolled".
  try {
    const accountPath = path.join(opts.homeDir ?? os.homedir(), '.config', 'nanoclaw', 'account.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(accountPath, 'utf-8'));
    const token = (parsed as { token?: unknown } | null)?.token;
    if (typeof token === 'string' && token.trim()) {
      return { mode: 'broker', installToken: token.trim(), baseUrl };
    }
  } catch {
    // fall through to direct mode
  }

  const managerToken = readEnvValue(rootDir, 'SLACK_MANAGER_TOKEN');
  if (managerToken) return { mode: 'direct', managerToken };

  return null;
}

interface RawProvisioned {
  appId: string;
  appToken: string;
  botToken?: string;
  installUrl?: string;
  installError?: string;
}

/**
 * Optional request-origin metadata on the broker's POST /v1/apps body
 * (requested_by / parent_app_id / template / client_version on the wire).
 * Sent only when defined; a broker that predates them ignores unknown body
 * fields. Names and no-value-no-key behavior are pinned across every
 * provisioning home by provision.congruence.test.ts. The direct transport has
 * nowhere to record them and never forwards them.
 */
interface ProvisionAttribution {
  requestedBy?: string;
  parentAppId?: string;
  template?: string;
  clientVersion?: string;
}

/**
 * The installing host's package.json version — the client_version metadata
 * field. Optional-shaped: unreadable/absent → undefined and the field is
 * simply omitted (never a placeholder value).
 */
function readClientVersion(rootDir: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    const version = (pkg as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version.trim() ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Broker mode: POST /v1/apps with the install token; 60s budget. */
/** Poll cap for the pre-create avatar job — beyond it the bot is born with the mascot. */
const AVATAR_WAIT_MS = 75_000;
// Generation measures ~20-23s at the broker's floor settings (quality 'low',
// 1024px is the model's minimum) — a 2s poll wastes at most ~2s of that,
// where the old 4s poll wasted up to 4.
const AVATAR_POLL_MS = 2_000;

// ── Avatar prefetch (multi-agent creates) ──
//
// Each generation is an independent async Lambda on the broker, so N avatars
// CAN run concurrently — the serialization was ours: flows run one at a time,
// each paying the full ~23s avatar wait. The delivery batch preview
// (index.ts) starts a prefetch for every create_agent in the batch in
// parallel; requestAvatar consumes the matching prefetch instead of starting
// a fresh job, collapsing N waits to ~one. Keyed by the exact
// (displayName, description) derivation the flow uses, so a miss just means
// a normal fresh request.
const avatarPrefetches = new Map<string, { promise: Promise<string | undefined>; at: number }>();
const AVATAR_PREFETCH_TTL_MS = 10 * 60_000;

function avatarKey(displayName: string, description: string | undefined): string {
  return `${displayName}\u0000${description ?? ''}`;
}

/** Start an avatar generation in the background for a create that is about to
 *  be processed. Fire-and-forget; never throws. Deduped per key. */
export function prefetchAvatar(
  baseUrl: string,
  installToken: string,
  displayName: string,
  description: string | undefined,
): void {
  const key = avatarKey(displayName, description);
  const existing = avatarPrefetches.get(key);
  if (existing && Date.now() - existing.at < AVATAR_PREFETCH_TTL_MS) return;
  avatarPrefetches.set(key, {
    promise: requestAvatarFresh(baseUrl, installToken, displayName, description).catch(() => undefined),
    at: Date.now(),
  });
}

/** Test seam: drop all pending prefetches. */
export function clearAvatarPrefetches(): void {
  avatarPrefetches.clear();
}

/**
 * Ask the broker to generate the agent's avatar BEFORE the app exists, so the
 * bot's very first workspace appearance wears its face — the mascot default
 * never shows on the happy path. Consumes a matching prefetch when one is
 * pending (multi-agent creates start them in parallel). Returns undefined
 * when generation is unavailable, failed, or over the wait cap (degraded
 * path: mascot).
 */
export async function requestAvatar(
  baseUrl: string,
  installToken: string,
  displayName: string,
  description: string | undefined,
): Promise<string | undefined> {
  const key = avatarKey(displayName, description);
  const hit = avatarPrefetches.get(key);
  if (hit) {
    avatarPrefetches.delete(key);
    if (Date.now() - hit.at < AVATAR_PREFETCH_TTL_MS) return hit.promise;
  }
  return requestAvatarFresh(baseUrl, installToken, displayName, description);
}

async function requestAvatarFresh(
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

async function provisionViaBroker(
  baseUrl: string,
  installToken: string,
  displayName: string,
  teamId: string | undefined,
  description: string | undefined,
  allowGuests = false,
  attribution: ProvisionAttribution = {},
): Promise<RawProvisioned> {
  if (!teamId) {
    throw new SlackFlowError(
      'broker',
      'broker mode needs the origin workspace team_id (origin auth.test returned none)',
    );
  }
  const avatarId = await requestAvatar(baseUrl, installToken, displayName, description);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}/v1/apps`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${installToken}`,
        'Content-Type': 'application/json',
      },
      // The deployed broker's contract (POST /v1/apps): it builds the manifest
      // server-side (agent-mode variant unless allow_guests) and generates
      // the per-agent avatar from the description.
      body: JSON.stringify({
        team_id: teamId,
        name: displayName,
        ...(avatarId ? { avatar_id: avatarId } : {}),
        ...(allowGuests ? { allow_guests: true } : {}),
        // Request-origin metadata — optional both ways: omitted when
        // unknown, ignored by a broker that predates the fields.
        ...(attribution.requestedBy ? { requested_by: attribution.requestedBy } : {}),
        ...(attribution.parentAppId ? { parent_app_id: attribution.parentAppId } : {}),
        ...(attribution.template ? { template: attribution.template } : {}),
        ...(attribution.clientVersion ? { client_version: attribution.clientVersion } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    text = await res.text();
  } catch (err) {
    throw new SlackFlowError(
      'broker',
      `broker POST /v1/apps failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new SlackFlowError('broker', `broker POST /v1/apps failed: HTTP ${res.status}, non-JSON body`);
  }
  if (!res.ok) {
    // message is the human sentence, error the machine code — show the human one.
    const detail = (data as { message?: string; error?: string }).message ?? (data as { error?: string }).error;
    throw new SlackFlowError(
      'broker',
      `broker POST /v1/apps failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
    );
  }
  // Contract shape is camelCase; the deployed broker speaks snake_case
  // (BrokerAppResponse in src/provisioning/slack-app.ts) — accept both.
  const pick = (a: unknown, b: unknown): string | undefined =>
    typeof a === 'string' && a ? a : typeof b === 'string' && b ? b : undefined;
  const appId = pick(data.appId, data.app_id);
  const appToken = pick(data.appToken, data.app_token);
  if (!appId || !appToken) {
    throw new SlackFlowError('broker', 'broker POST /v1/apps failed: response missing app id or app token');
  }
  return {
    appId,
    appToken,
    botToken: pick(data.botToken, data.bot_token),
    installUrl: pick(data.installUrl, data.install_url),
    installError: pick(data.installError, data.install_error),
  };
}

// ── Deferred install completion (broker transport) ──
//
// A workspace with an admin-approval policy refuses auto-install: POST
// /v1/apps answers with an install_url and no bot token. That URL carries its
// own signed state and stays valid for days, so the app is not lost — it sits
// at pending_install until a human completes the install in the browser, and
// GET /v1/apps/{app_id} then releases the bot token exactly once. Mirrors
// waitForInstall in src/provisioning/slack-app.ts.

/** Poll cadence while a workspace install approval is outstanding. */
export const INSTALL_POLL_INTERVAL_MS = 5_000;
/** How long the flow waits inline before parking the app for a later resume. */
export const INSTALL_POLL_TIMEOUT_MS = 5 * 60_000;

type AppStatus = 'installed' | 'pending_install' | 'deleted';

interface AppState {
  status: AppStatus;
  botToken?: string;
}

/**
 * One app's state, or undefined when the service does not know it (404) —
 * which for every caller here means the same as "stop waiting". Transport
 * failures throw so the poll loop can decide whether they are worth retrying.
 */
async function fetchAppState(baseUrl: string, installToken: string, appId: string): Promise<AppState | undefined> {
  const res = await fetch(`${baseUrl}/v1/apps/${encodeURIComponent(appId)}`, {
    headers: { Authorization: `Bearer ${installToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return undefined;
  if (res.status === 401 || res.status === 403) {
    throw new SlackFlowError(
      'install-wait',
      `the Slack service refused this install's credentials (HTTP ${res.status})`,
    );
  }
  if (!res.ok) throw new Error(`GET /v1/apps/${appId}: HTTP ${res.status}`);
  const data = (await res.json()) as { status?: string; bot_token?: string | null; botToken?: string | null };
  const status = data.status;
  if (status !== 'installed' && status !== 'pending_install' && status !== 'deleted') {
    throw new Error(`GET /v1/apps/${appId}: unrecognized status '${String(status)}'`);
  }
  // Contract shape is snake_case; accept camelCase the way the create call does.
  const botToken = data.bot_token ?? data.botToken ?? undefined;
  return { status, ...(botToken ? { botToken } : {}) };
}

/**
 * Wait out a pending install and return the one-time bot token.
 *
 * Undefined means "stop waiting and park the app": the deadline passed, the
 * service does not know the app, it was deleted, or it reads as installed with
 * no token left to give (someone else already took it — no further poll
 * recovers it). A credential refusal is the one failure worth surfacing, since
 * the next poll cannot change that answer.
 */
export async function waitForInstall(
  baseUrl: string,
  installToken: string,
  appId: string,
  opts: { intervalMs?: number; timeoutMs?: number; checkImmediately?: boolean } = {},
): Promise<string | undefined> {
  const intervalMs = opts.intervalMs ?? INSTALL_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? INSTALL_POLL_TIMEOUT_MS);
  // A resume checks straight away — the approval may have landed while nobody
  // was waiting, and that is worth one call even when the budget is zero. A
  // fresh refusal sleeps first: nothing can have changed in the instant since
  // the service said no.
  let due = opts.checkImmediately === true;
  while (due || Date.now() < deadline) {
    if (!due) await new Promise((r) => setTimeout(r, intervalMs));
    due = false;
    let state: AppState | undefined;
    try {
      state = await fetchAppState(baseUrl, installToken, appId);
    } catch (err) {
      if (err instanceof SlackFlowError) throw err;
      continue; // transient — the deadline already bounds this
    }
    if (!state || state.status === 'deleted') return undefined;
    if (state.status === 'installed') return state.botToken;
  }
  return undefined;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackApi<T extends SlackApiResponse>(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new SlackFlowError('direct-create', `${method} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok && res.status !== 200) throw new SlackFlowError('direct-create', `${method}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Direct mode: apps.manifest.create + apps.managedInstall with the manager token. */
async function provisionDirect(
  managerToken: string,
  displayName: string,
  allowGuests = false,
): Promise<RawProvisioned> {
  const created = await slackApi<
    SlackApiResponse & { app_id?: string; app_token?: string; oauth_authorize_url?: string }
  >('apps.manifest.create', managerToken, {
    manifest: JSON.stringify(buildManagedAppManifest(displayName, { agentView: !allowGuests })),
    generate_app_token: 'true',
  });
  if (!created.ok || !created.app_id) {
    throw new SlackFlowError(
      'direct-create',
      `apps.manifest.create failed: ${created.error ?? 'no app_id in response'}`,
    );
  }
  if (!created.app_token) {
    throw new SlackFlowError(
      'direct-create',
      'apps.manifest.create returned no app-level token (generate_app_token unsupported?)',
    );
  }
  const result: RawProvisioned = {
    appId: created.app_id,
    appToken: created.app_token,
    installUrl: created.oauth_authorize_url ?? '',
  };
  const installed = await slackApi<SlackApiResponse & { api_access_tokens?: { bot_access_token?: string } }>(
    'apps.managedInstall',
    managerToken,
    { app_id: created.app_id },
  );
  if (installed.ok && installed.api_access_tokens?.bot_access_token) {
    result.botToken = installed.api_access_tokens.bot_access_token;
  } else {
    result.installError = installed.error ?? 'no bot token in response';
  }
  return result;
}

/** slug.toUpperCase().replace(/-/g, '_') — the .env key suffix shape. */
export function envKeySuffix(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/**
 * The .env keys one provisioned instance owns. The app id and install URL are
 * the resume state for an app whose workspace has not approved the install
 * yet: without them a retry has nothing to poll and can only create a second
 * Slack app for the same agent.
 */
export function envKeysForSlug(slug: string): {
  botKey: string;
  appKey: string;
  appIdKey: string;
  installUrlKey: string;
} {
  const suffix = envKeySuffix(slug);
  return {
    botKey: `SLACK_BOT_TOKEN_${suffix}`,
    appKey: `SLACK_APP_TOKEN_${suffix}`,
    appIdKey: `SLACK_APP_ID_${suffix}`,
    installUrlKey: `SLACK_INSTALL_URL_${suffix}`,
  };
}

/**
 * The app this slug has parked awaiting a workspace install approval, if any:
 * an app token and an app id on record, no bot token yet. Callers use it to
 * tell "finish what you started" apart from "start something new".
 */
export function pendingInstall(rootDir: string, slug: string): { appId: string; installUrl?: string } | undefined {
  const { botKey, appKey, appIdKey, installUrlKey } = envKeysForSlug(slug);
  if (readEnvValue(rootDir, botKey)) return undefined;
  if (!readEnvValue(rootDir, appKey)) return undefined;
  const appId = readEnvValue(rootDir, appIdKey);
  if (!appId) return undefined;
  return { appId, installUrl: readEnvValue(rootDir, installUrlKey) };
}

/** Best-effort: a caller's notification must never take the flow down with it. */
async function announcePending(
  input: ProvisionInput,
  info: { appId: string; installUrl?: string; resumed: boolean },
): Promise<void> {
  try {
    await input.onInstallPending?.(info);
  } catch {
    // The wait is the point; the announcement is a courtesy.
  }
}

/** What the human is told when the wait runs out and the app stays parked. */
function parkedError(displayName: string, appId: string, installUrl: string | undefined): SlackFlowError {
  return new SlackFlowError(
    'install-wait',
    `Slack app ${appId} for "${displayName}" is still waiting on a workspace install approval. ` +
      `Nothing was lost and nothing needs re-creating — the app is saved. ` +
      `${installUrl ? `Approve the install at ${installUrl}, then ask` : 'Once the install is approved, ask'} ` +
      `to finish setting up ${displayName} and it picks up from here.`,
  );
}

/**
 * Provision (or reuse, or finish) the named instance's Slack app and persist
 * its tokens.
 *
 * Three entries, decided by what .env already holds:
 *  - both tokens → reuse, no network.
 *  - app token + app id, no bot token → an app parked awaiting a workspace
 *    install approval: poll for it rather than provision a second one.
 *  - nothing → provision. A refused auto-install is not the end of the road:
 *    the app is real and its install URL stays valid, so the flow announces
 *    the approval and waits inline for the install to land.
 *
 * .env is the resume state, so everything derivable is written the moment it
 * exists (mirrors slack-create-agent.ts) — a failure after that point never
 * re-provisions a duplicate Slack app on retry.
 */
export async function provisionSlackApp(input: ProvisionInput): Promise<ProvisionResult> {
  const { slug, displayName, rootDir } = input;
  const envSuffix = envKeySuffix(slug);
  const { botKey, appKey, appIdKey, installUrlKey } = envKeysForSlug(slug);

  const existingBot = readEnvValue(rootDir, botKey);
  const existingApp = readEnvValue(rootDir, appKey);
  if (existingBot && existingApp) {
    return {
      slug,
      envSuffix,
      botToken: existingBot,
      appToken: existingApp,
      // Recorded since the deferred-install work; older installs have no row,
      // and nothing downstream of provisioning needs the id.
      appId: readEnvValue(rootDir, appIdKey) ?? '',
      reused: true,
    };
  }
  if (existingBot && !existingApp) {
    throw new SlackFlowError(
      'no-credentials',
      `${botKey} is set but ${appKey} is missing — add the app-level xapp-… token to .env as ${appKey} and retry.`,
    );
  }

  const credential = resolveProvisioningCredential(rootDir);

  if (existingApp && !existingBot) {
    const parked = pendingInstall(rootDir, slug);
    // No app id on record (or no broker to ask) leaves the hand-finish
    // instructions as the only honest answer.
    if (!parked || credential?.mode !== 'broker') {
      throw new SlackFlowError(
        'no-credentials',
        `${appKey} is set but ${botKey} is missing — the app exists but was never installed. ` +
          `Finish the install from the app's page in Slack, put the xoxb-… token in .env as ${botKey}, and retry.`,
      );
    }
    await announcePending(input, { appId: parked.appId, installUrl: parked.installUrl, resumed: true });
    const botToken = await waitForInstall(credential.baseUrl, credential.installToken, parked.appId, {
      ...input.installWait,
      checkImmediately: true,
    });
    if (!botToken) throw parkedError(displayName, parked.appId, parked.installUrl);
    persistInstalled(rootDir, slug, botToken);
    return {
      slug,
      envSuffix,
      botToken,
      appToken: existingApp,
      appId: parked.appId,
      reused: false,
      deferredInstall: true,
    };
  }

  if (!credential) {
    throw new SlackFlowError(
      'no-credentials',
      'no Slack provisioning credential: set NANOCLAW_INSTALL_TOKEN (managed service) or ' +
        'SLACK_MANAGER_TOKEN (direct) in .env, or enroll this install with the registry.',
    );
  }

  const allowGuests = input.allowGuests ?? false;
  const app =
    credential.mode === 'broker'
      ? await provisionViaBroker(
          credential.baseUrl,
          credential.installToken,
          displayName,
          input.teamId,
          input.description,
          allowGuests,
          {
            requestedBy: input.requestedBy,
            parentAppId: input.parentAppId,
            template: input.template,
            clientVersion: readClientVersion(rootDir),
          },
        )
      : await provisionDirect(credential.managerToken, displayName, allowGuests);

  // Persist what we have before anything else can fail. App token, app id and
  // instance slug land even when auto-install was refused, so a later run can
  // finish this app instead of creating another.
  try {
    upsertEnvKey(rootDir, appKey, app.appToken);
    if (app.appId) upsertEnvKey(rootDir, appIdKey, app.appId);
    if (app.botToken) upsertEnvKey(rootDir, botKey, app.botToken);
    else if (app.installUrl) upsertEnvKey(rootDir, installUrlKey, app.installUrl);
    appendToEnvList(rootDir, 'SLACK_INSTANCES', slug);
  } catch (err) {
    throw new SlackFlowError(
      'env-write',
      `failed writing ${appKey}/${botKey}/SLACK_INSTANCES to .env: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!app.botToken) {
    // Usually a workspace admin-approval policy refusing auto-install. On the
    // broker transport that is a wait, not a dead end — the install URL is
    // signed and long-lived, and the service releases the bot token once the
    // install lands. The direct transport has no such read-back.
    if (credential.mode === 'broker' && app.installUrl) {
      await announcePending(input, { appId: app.appId, installUrl: app.installUrl, resumed: false });
      const botToken = await waitForInstall(
        credential.baseUrl,
        credential.installToken,
        app.appId,
        input.installWait ?? {},
      );
      if (!botToken) throw parkedError(displayName, app.appId, app.installUrl);
      persistInstalled(rootDir, slug, botToken);
      return {
        slug,
        envSuffix,
        botToken,
        appToken: app.appToken,
        appId: app.appId,
        reused: false,
        deferredInstall: true,
      };
    }
    throw new SlackFlowError(
      credential.mode === 'broker' ? 'broker' : 'direct-create',
      `Slack refused to auto-install app ${app.appId} (${app.installError ?? 'unknown reason'}). ` +
        `Install it by hand${app.installUrl ? ` from ${app.installUrl}` : " from the app's page at api.slack.com/apps"}, ` +
        `put the xoxb-… token in .env as ${botKey}, and retry — the app token is already saved.`,
    );
  }

  return { slug, envSuffix, botToken: app.botToken, appToken: app.appToken, appId: app.appId, reused: false };
}

/**
 * Record a bot token that arrived after the wait, and retire the install URL
 * that produced it — a consumed link left on disk reads as work still to do.
 */
function persistInstalled(rootDir: string, slug: string, botToken: string): void {
  const { botKey, installUrlKey } = envKeysForSlug(slug);
  try {
    upsertEnvKey(rootDir, botKey, botToken);
    upsertEnvKey(rootDir, installUrlKey, '');
    appendToEnvList(rootDir, 'SLACK_INSTANCES', slug);
  } catch (err) {
    throw new SlackFlowError(
      'env-write',
      `failed writing ${botKey} to .env: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
