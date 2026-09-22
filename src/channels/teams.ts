/**
 * Microsoft Teams channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Additional bot identities: set TEAMS_INSTANCES=<name>[,<name>…] plus a
 * per-instance credential set (TEAMS_APP_ID_<NAME> /
 * TEAMS_APP_PASSWORD_<NAME> / TEAMS_APP_TENANT_ID_<NAME> /
 * TEAMS_APP_TYPE_<NAME>; name uppercased, dashes → underscores). Each name
 * registers under the `teams-<name>` instance key and serves
 * `/webhook/teams-<name>`; channelType stays 'teams', so user ids,
 * formatting, container config, and the wiring-defaults declaration are
 * shared across instances.
 *
 * Every instance is built from a ChannelInstanceSpec (channel-registry.ts).
 * Env mode builds the spec itself when the instance starts (webhook
 * transport, legacy single-segment route, no tenant pin). A connection
 * registered by an operator surface arrives as a spec through
 * registerChannelInstance → the 'teams' instance factory below:
 * `/webhook/teams/<instance>`, pinned to the connection's tenant.
 *
 * Credentials come from the channel credential provider
 * (credential-provider.ts) when the instance starts — `.env` by default, a
 * vault release in an enterprise overlay — never from process env.
 *
 * Tenant pin: a pinned instance acks and drops every activity whose tenant
 * (`conversation.tenantId`, else `channelData.tenant.id`) is not its own,
 * before the Teams SDK sees it (pinTeamsAdapterToTenant). Unpinned = the
 * behaviour every install had before.
 */
import { createTeamsAdapter } from '@chat-adapter/teams';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerPendingWebhookRoute } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import {
  registerChannelAdapter,
  registerChannelInstanceFactory,
  webhookRoutingPath,
  type ChannelInstanceSpec,
} from './channel-registry.js';
import { getChannelCredentialProvider, type ChannelCredentialProvider } from './credential-provider.js';

type TeamsSdkAdapter = ReturnType<typeof createTeamsAdapter>;

/**
 * Dedicated bot app on a threaded platform. 'mention' (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
export const TEAMS_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** What one Teams instance starts with, as the credential provider resolved it. */
export interface TeamsCredentials {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  appType?: string;
}

/** Resolve an instance's app registration through the provider (`.env` by default). */
export async function resolveTeamsCredentials(
  instance: string,
  provider: ChannelCredentialProvider = getChannelCredentialProvider(),
): Promise<TeamsCredentials> {
  const [appId, appPassword, tenantId, appType] = await Promise.all([
    provider.get(instance, 'app_id'),
    provider.get(instance, 'app_password'),
    provider.get(instance, 'tenant_id'),
    provider.get(instance, 'app_type'),
  ]);
  return { appId, appPassword, tenantId, appType };
}

// ---------------------------------------------------------------------------
// Tenant pin
// ---------------------------------------------------------------------------

/**
 * The tenant an inbound Bot Framework activity belongs to, or null when it
 * names none: `conversation.tenantId`, else `channelData.tenant.id` (the
 * two places the Teams SDK itself reads it from).
 */
export function activityTenantId(activity: unknown): string | null {
  if (activity === null || typeof activity !== 'object') return null;
  const a = activity as { conversation?: unknown; channelData?: unknown };
  if (a.conversation !== null && typeof a.conversation === 'object') {
    const id = (a.conversation as { tenantId?: unknown }).tenantId;
    if (typeof id === 'string' && id !== '') return id;
  }
  if (a.channelData !== null && typeof a.channelData === 'object') {
    const tenant = (a.channelData as { tenant?: unknown }).tenant;
    if (tenant !== null && typeof tenant === 'object') {
      const id = (tenant as { id?: unknown }).id;
      if (typeof id === 'string' && id !== '') return id;
    }
  }
  return null;
}

type WebhookHandler = (request: Request, options?: unknown) => Promise<Response>;

/**
 * Pin `adapter` to `tenantId`: an activity from any other tenant (or from
 * none — the pin fails closed) is acked (200) and dropped with one warning
 * line before the Teams SDK sees it. The probe reads a clone of the request
 * so the SDK still gets the untouched body for its own token validation;
 * a body that is not JSON is left to the SDK's own rejection.
 */
export function pinTeamsAdapterToTenant(adapter: TeamsSdkAdapter, tenantId: string): void {
  const target = adapter as unknown as { handleWebhook: WebhookHandler };
  const handleWebhook = target.handleWebhook;
  target.handleWebhook = async (request, options) => {
    let activity: unknown;
    try {
      activity = JSON.parse(await request.clone().text());
    } catch {
      return handleWebhook.call(adapter, request, options);
    }
    const actual = activityTenantId(activity);
    if (actual !== tenantId) {
      log.warn('teams: dropped an activity from another tenant', {
        tenantId: actual ?? '(none)',
        pinnedTenantId: tenantId,
      });
      return new Response(null, { status: 200 });
    }
    return handleWebhook.call(adapter, request, options);
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * The Chat SDK adapter for one spec from its resolved credentials, pinned
 * when the spec names a tenant. Null when there is no app id. The app's own
 * tenant (SingleTenant auth) is the provider's `tenant_id`, else the spec's
 * external scope.
 */
export function createTeamsAdapterForSpec(
  spec: ChannelInstanceSpec,
  credentials: TeamsCredentials,
): TeamsSdkAdapter | null {
  if (!credentials.appId) return null;
  const teamsAdapter = createTeamsAdapter({
    appId: credentials.appId,
    appPassword: credentials.appPassword,
    appType: (credentials.appType as 'SingleTenant' | 'MultiTenant') || undefined,
    appTenantId: credentials.tenantId || spec.externalScope || undefined,
  });
  if (spec.externalScope) pinTeamsAdapterToTenant(teamsAdapter, spec.externalScope);
  return teamsAdapter;
}

/** The bridge every Teams instance gets: same construction for the default app, env-mode names, and connections. */
function assembleTeamsBridge(spec: ChannelInstanceSpec, teamsAdapter: TeamsSdkAdapter): ChannelAdapter {
  return createChatSdkBridge({
    adapter: teamsAdapter,
    // The default instance stays keyed by channelType (instance undefined),
    // which keeps its registry key and state namespace unchanged.
    instance: spec.instance === 'teams' ? undefined : spec.instance,
    webhookPath: webhookRoutingPath(spec),
    concurrency: 'concurrent',
    supportsThreads: true,
    defaults: TEAMS_DEFAULTS,
  });
}

/**
 * Build a connection-registered instance's bridge from its spec, resolving
 * credentials through the provider now (instance start), not at boot.
 * Returns null when the instance cannot start so the registry surfaces its
 * "credentials missing, skipping" path. An instance whose app id or
 * password is not available yet holds a pending route instead, so the
 * messaging endpoint answers (200) while the connection is completed and
 * the next start replaces the pending entry with the live route.
 */
export async function createTeamsBridgeFromSpec(
  spec: ChannelInstanceSpec,
  provider: ChannelCredentialProvider = getChannelCredentialProvider(),
): Promise<ChannelAdapter | null> {
  if (spec.transport !== 'webhook') {
    log.warn('Teams instance asks for a transport Teams does not have, skipping', {
      instance: spec.instance,
      transport: spec.transport,
    });
    return null;
  }
  const credentials = await resolveTeamsCredentials(spec.instance, provider);
  if (!(credentials.appId && credentials.appPassword)) {
    const route = webhookRoutingPath(spec);
    registerPendingWebhookRoute(route);
    log.warn('Teams instance credentials not available yet — webhook route held pending', {
      instance: spec.instance,
      path: `/webhook/${route}`,
    });
    return null;
  }
  const teamsAdapter = createTeamsAdapterForSpec(spec, credentials);
  return teamsAdapter ? assembleTeamsBridge(spec, teamsAdapter) : null;
}

/** Construction knobs for one env-mode Teams bot identity. */
export interface TeamsBridgeOptions {
  /**
   * Registry/bridge instance key (e.g. 'teams-hq'). Omit for the default
   * instance, keyed by channelType. The credential provider derives the
   * `.env` suffix from it (`teams-hq` → TEAMS_APP_ID_HQ …).
   */
  instanceKey?: string;
}

/**
 * Env-mode construction: the default app (no options) or a TEAMS_INSTANCES
 * name. Builds the instance's spec at start (webhook transport, legacy
 * single-segment route, no tenant pin) and feeds the same spec-driven
 * construction a registered connection gets. Returns null when the app id
 * is missing so the registry surfaces its normal "credentials missing,
 * skipping" warning.
 */
export async function createTeamsBridge(options: TeamsBridgeOptions = {}): Promise<ChannelAdapter | null> {
  const instance = options.instanceKey ?? 'teams';
  const credentials = await resolveTeamsCredentials(instance);
  const spec: ChannelInstanceSpec = {
    instance,
    channelType: 'teams',
    transport: 'webhook',
    webhookPath: `/webhook/${instance}`,
  };
  const teamsAdapter = createTeamsAdapterForSpec(spec, credentials);
  return teamsAdapter ? assembleTeamsBridge(spec, teamsAdapter) : null;
}

/** Build one named instance's bridge from its per-instance credential set, through the shared env-mode construction. */
export function teamsInstanceBridgeFactory(name: string): Promise<ChannelAdapter | null> {
  return createTeamsBridge({ instanceKey: `teams-${name}` });
}

registerChannelAdapter('teams', {
  factory: () => createTeamsBridge(),
  defaults: TEAMS_DEFAULTS,
});

// Named instances — registration is unconditional for every listed name so a
// missing credential set surfaces as the registry's "credentials missing,
// skipping" warning at boot rather than a silently absent bot. Every
// registration carries the same TEAMS_DEFAULTS declaration as the default app.
for (const raw of (readEnvFile(['TEAMS_INSTANCES']).TEAMS_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  registerChannelAdapter(`teams-${name}`, {
    factory: () => teamsInstanceBridgeFactory(name),
    defaults: TEAMS_DEFAULTS,
  });
}

// Connection-registered instances (registerChannelInstance with channelType
// 'teams'): the same construction from a stored spec — credentials through
// the provider at start, pinned to the connection's tenant, routed at
// /webhook/teams/<instance>.
registerChannelInstanceFactory('teams', (spec) => ({
  factory: () => createTeamsBridgeFromSpec(spec),
  defaults: TEAMS_DEFAULTS,
}));
