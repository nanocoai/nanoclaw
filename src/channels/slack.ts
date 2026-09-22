/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 *
 * Additional bot identities in the same workspace: set
 * SLACK_INSTANCES=<name>[,<name>…] plus a per-instance token set
 * (SLACK_BOT_TOKEN_<NAME> / SLACK_APP_TOKEN_<NAME> /
 * SLACK_SIGNING_SECRET_<NAME>; name uppercased, dashes → underscores). Each
 * name registers under the `slack-<name>` instance key through the same
 * spec-driven construction as the default app — no mirrored construction.
 * channelType stays 'slack' either way, so user ids, formatting, container
 * config, and the wiring-defaults declaration are shared across instances.
 *
 * Every instance is built from a ChannelInstanceSpec (channel-registry.ts).
 * Env mode builds the spec itself when the instance starts: transport
 * follows the app-level token (Socket Mode when present), the route is the
 * legacy single segment (`/webhook/slack`, `/webhook/slack-<name>`), and the
 * workspace pin is SLACK_WORKSPACE_ID (SLACK_WORKSPACE_ID_<NAME> for one
 * instance). A connection registered by an operator surface arrives as a
 * spec through registerChannelInstance → the 'slack' instance factory below:
 * `/webhook/slack/<instance>`, pinned to the connection's workspace.
 *
 * Credentials come from the channel credential provider
 * (credential-provider.ts) when the instance starts — `.env` by default, a
 * vault release in an enterprise overlay — never from process env.
 *
 * Workspace pin: with public distribution on, ANY workspace can install a
 * Slack app, and Socket Mode delivers every installation's events over the
 * one app-level connection; the Chat SDK adapter processes each envelope
 * with the configured bot token and no team check. A pinned instance acks
 * and drops every envelope whose workspace is not its own, before any
 * handler sees it (pinSlackAdapterToWorkspace). Unpinned = the
 * single-workspace behaviour every install had before.
 */
import { createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';

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
import {
  channelInstanceEnvKey,
  getChannelCredentialProvider,
  type ChannelCredentialProvider,
} from './credential-provider.js';
import { extractSlackRawText } from './slack-raw-text.js';

/** Env-key suffix for a named instance: uppercased, dashes → underscores. Lives with the credential provider now. */
export { instanceEnvKeySuffix } from './credential-provider.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * dm.threads:false is a deliberate policy choice, not a capability limit:
 * Slack users can open sub-threads inside a DM, but by default the agent
 * replies top-level and all DM sub-threads collapse into the one DM session.
 * This declaration owns that judgment (it used to be hardcoded router
 * behavior); operators who want in-thread DM replies override per wiring
 * with `--threads true`.
 *
 * Agent-DM anchors (the settled Slack DM shape) — creation-time stamps, so
 * they apply to wirings/rows created from this declaration onward and never
 * flip existing installs:
 * - dm.sessionMode 'per-thread': Slack's agent-mode DM surface materializes
 *   a thread per conversation, so a new DM wiring roots a session per thread.
 *   resolveWiringDefaults derives the threads=1 stamp from this at creation
 *   (per-thread sessions structurally require honored thread ids — no
 *   separate field to declare). The live inherit value dm.threads stays
 *   false, so wirings created earlier (threads column NULL) keep collapsing
 *   DM sub-threads into the one DM session.
 * - dm.unknownSenderPolicy 'decline_notify': an unknown DM sender gets a
 *   polite decline and the owner a one-line FYI — no approval card; access
 *   grants stay explicit (`ncl members add`). A deliberate, reviewed default
 *   change for Slack DM rows auto-created after this lands.
 */
export const SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: false,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'decline_notify',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    // D29: group conversations are per-thread too — Slack channels
    // materialize a thread per top-level message, and ambient context
    // (same-mg fan + channel-timeline backfill) is the continuity layer.
    // Creation-time stamp like dm.sessionMode; existing wirings never flip.
    // Canvas-comment shadow channels deliberately stay shared (wired
    // explicitly in room-canvas, the documented D29 exception).
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'platform',
};

/**
 * Classify a Slack conversation for consumers that render it to a human
 * (e.g. approval cards): a 1:1 DM, a group DM (MPDM), or a channel. Channels
 * resolve their name; MPDMs resolve their human participants through the
 * calling bot's own authenticated client. Returns null when the Slack API
 * can't classify the conversation (network failure, missing scope) so the
 * caller falls through to its generic rendering.
 */
export async function resolveSlackConversation(
  slackAdapter: SlackAdapter,
  platformId: string,
): Promise<{
  type: 'direct' | 'group_dm' | 'channel';
  name: string | null;
  participantNames?: string[];
  participantIds?: string[];
} | null> {
  const channelId = platformId.replace(/^slack:/, '').split(':')[0];
  if (channelId.startsWith('D')) return { type: 'direct', name: null };

  try {
    const info = await slackAdapter.fetchThread(`slack:${channelId}`);
    const channel = (info.metadata as { channel?: { is_mpim?: boolean } }).channel;
    if (!channel?.is_mpim) return { type: 'channel', name: info.channelName ?? null };

    try {
      const { members = [] } = await slackAdapter.webClient.conversations.members({
        channel: channelId,
        limit: 100,
      });
      const users = await Promise.all(members.map((id) => slackAdapter.getUser(id)));
      // participantIds (raw Slack "U…" ids) MUST stay parallel to
      // participantNames — same length, same order. A consumer pairing the
      // two arrays positionally (e.g. to exclude one participant by id)
      // breaks silently if a member is filtered from only ONE array (bot,
      // failed profile lookup). Both arrays are therefore projected from a
      // single filtered list: bots and members whose profile lookup failed
      // drop from BOTH.
      const humans = members
        .map((id, i) => ({ id, user: users[i] }))
        .filter((entry): entry is { id: string; user: NonNullable<(typeof users)[number]> } =>
          Boolean(entry.user && !entry.user.isBot),
        );
      return {
        type: 'group_dm',
        name: null,
        participantNames: humans.map(({ user }) => user.userName || user.fullName),
        participantIds: humans.map(({ id }) => id),
      };
    } catch {
      return { type: 'group_dm', name: null };
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** What one Slack instance starts with, as the credential provider resolved it. */
export interface SlackCredentials {
  botToken?: string;
  signingSecret?: string;
  appToken?: string;
}

/** Resolve an instance's token set through the provider (`.env` by default). */
export async function resolveSlackCredentials(
  instance: string,
  provider: ChannelCredentialProvider = getChannelCredentialProvider(),
): Promise<SlackCredentials> {
  const [botToken, signingSecret, appToken] = await Promise.all([
    provider.get(instance, 'bot_token'),
    provider.get(instance, 'signing_secret'),
    provider.get(instance, 'app_token'),
  ]);
  return { botToken, signingSecret, appToken };
}

// ---------------------------------------------------------------------------
// Workspace pin
// ---------------------------------------------------------------------------

/**
 * The workspace an inbound envelope belongs to, or null when it names none.
 * Slack puts it at `team_id` on events_api and slash_commands envelopes, at
 * `team.id` on interactive payloads, and lists the installations an event
 * is visible to under `authorizations[].team_id`.
 */
export function envelopeTeamId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as { team_id?: unknown; team?: unknown; authorizations?: unknown };
  if (typeof b.team_id === 'string' && b.team_id !== '') return b.team_id;
  if (b.team !== null && typeof b.team === 'object') {
    const id = (b.team as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  if (Array.isArray(b.authorizations)) {
    const first = b.authorizations[0] as { team_id?: unknown } | undefined;
    if (first && typeof first.team_id === 'string' && first.team_id !== '') return first.team_id;
  }
  return null;
}

/**
 * The workspace a webhook request's envelope names, read off a clone so the
 * adapter still gets the untouched body (its signature check needs the exact
 * bytes). 'verification' is Slack's url_verification handshake, which names
 * no workspace and must reach the adapter (it answers after its own
 * signature check). 'unparseable' is left to the adapter's own rejection.
 */
export async function webhookEnvelopeTeamId(
  request: Request,
): Promise<{ teamId: string | null } | 'verification' | 'unparseable'> {
  let body: string;
  try {
    body = await request.clone().text();
  } catch {
    return 'unparseable';
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    const payload = params.get('payload');
    if (payload === null) return { teamId: params.get('team_id') || null };
    try {
      return { teamId: envelopeTeamId(JSON.parse(payload)) };
    } catch {
      return 'unparseable';
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'unparseable';
  }
  if (parsed !== null && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'url_verification') {
    return 'verification';
  }
  return { teamId: envelopeTeamId(parsed) };
}

type SocketAck = (response?: Record<string, unknown>) => Promise<void>;
type SocketRouter = (
  body: Record<string, unknown>,
  eventType: string,
  ack: SocketAck,
  options?: unknown,
) => Promise<void>;
type WebhookHandler = (request: Request, options?: unknown) => Promise<Response>;

/**
 * Pin `adapter` to `workspaceId`: an envelope from any other workspace (or
 * from none — the pin fails closed) is acked and dropped with one warning
 * line before any handler sees it, on both transports:
 *  - Socket Mode: `routeSocketEvent` is the adapter's one entry point for
 *    every envelope type (events_api, slash_commands, interactive), so the
 *    pin shadows it on this one instance;
 *  - webhook: `handleWebhook`, probed on a clone of the request so the
 *    adapter's signature check still sees the exact bytes. The
 *    url_verification handshake names no workspace and passes through: the
 *    adapter answers it after verifying the signature.
 * Throws when the adapter has no Socket Mode router to wrap (a version that
 * moved it): an instance asked to pin must not start unpinned.
 */
export function pinSlackAdapterToWorkspace(adapter: SlackAdapter, workspaceId: string): void {
  const target = adapter as unknown as { routeSocketEvent?: SocketRouter; handleWebhook: WebhookHandler };
  const route = target.routeSocketEvent;
  if (typeof route !== 'function') {
    throw new Error(
      `slack: cannot pin the workspace: the adapter has no routeSocketEvent to wrap; refusing to start pinned to '${workspaceId}' unpinned`,
    );
  }
  const dropped = (transport: 'socket' | 'webhook', teamId: string | null, eventType?: string): void => {
    log.warn('slack: dropped an envelope from another workspace', {
      transport,
      eventType,
      teamId: teamId ?? '(none)',
      workspaceId,
    });
  };
  target.routeSocketEvent = async (body, eventType, ack, options) => {
    const teamId = envelopeTeamId(body);
    if (teamId !== workspaceId) {
      await ack();
      dropped('socket', teamId, eventType);
      return;
    }
    await route.call(adapter, body, eventType, ack, options);
  };
  const handleWebhook = target.handleWebhook;
  target.handleWebhook = async (request, options) => {
    const probe = await webhookEnvelopeTeamId(request);
    if (typeof probe === 'object' && probe.teamId !== workspaceId) {
      dropped('webhook', probe.teamId);
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
 * when the spec names a workspace. Null when the instance cannot start: no
 * bot token, or Socket Mode asked for without an app-level token. Webhook
 * transport hands the signing secret to the SDK, which refuses to construct
 * without one — the same fail-fast as before.
 */
export function createSlackAdapterForSpec(
  spec: ChannelInstanceSpec,
  credentials: SlackCredentials,
): SlackAdapter | null {
  if (!credentials.botToken) return null;
  const socket = spec.transport === 'socket';
  if (socket && !credentials.appToken) {
    log.warn('Slack instance asks for Socket Mode but has no app-level token, skipping', { instance: spec.instance });
    return null;
  }
  // An xapp-… token enables Socket Mode: events arrive over an outbound
  // WebSocket, so no public HTTPS endpoint is required. When set, the
  // signing secret is optional (Slack signs socket frames separately).
  const slackAdapter = createSlackAdapter({
    botToken: credentials.botToken,
    signingSecret: credentials.signingSecret,
    appToken: socket ? credentials.appToken : undefined,
    mode: socket ? 'socket' : 'webhook',
  });
  if (spec.externalScope) pinSlackAdapterToWorkspace(slackAdapter, spec.externalScope);
  return slackAdapter;
}

/** The bridge every Slack instance gets: same construction for the default app, env-mode names, and connections. */
function assembleSlackBridge(spec: ChannelInstanceSpec, slackAdapter: SlackAdapter): ChannelAdapter {
  const bridge = createChatSdkBridge({
    adapter: slackAdapter,
    extractRawText: extractSlackRawText,
    // The default instance stays keyed by channelType (instance undefined),
    // which keeps its registry key and state namespace unchanged.
    instance: spec.instance === 'slack' ? undefined : spec.instance,
    webhookPath: webhookRoutingPath(spec),
    concurrency: 'concurrent',
    supportsThreads: true,
    defaults: SLACK_DEFAULTS,
  });
  bridge.resolveChannelName = async (platformId: string) => {
    try {
      const info = await slackAdapter.fetchThread(platformId);
      return (info as { channelName?: string }).channelName ?? null;
    } catch {
      return null;
    }
  };
  // Conversation classification closes over THIS identity's adapter, so
  // every instance (default or named) resolves through its own token.
  // ChannelAdapter does not declare resolveConversation yet — the extension
  // rides on the returned object until the core seam lands.
  return Object.assign(bridge, {
    resolveConversation: (platformId: string) => resolveSlackConversation(slackAdapter, platformId),
  });
}

/**
 * Build a connection-registered instance's bridge from its spec, resolving
 * credentials through the provider now (instance start), not at boot.
 * Returns null when the instance cannot start so the registry surfaces its
 * "credentials missing, skipping" path. A webhook-transport instance whose
 * bot token or signing secret is not available yet holds a pending route
 * instead: Slack's url_verification for its Request URL is answered while
 * the connection is completed, everything else is acked and dropped, and
 * the next start replaces the pending entry with the live route.
 */
export async function createSlackBridgeFromSpec(
  spec: ChannelInstanceSpec,
  provider: ChannelCredentialProvider = getChannelCredentialProvider(),
): Promise<ChannelAdapter | null> {
  const credentials = await resolveSlackCredentials(spec.instance, provider);
  if (spec.transport === 'webhook' && !(credentials.botToken && credentials.signingSecret)) {
    const route = webhookRoutingPath(spec);
    registerPendingWebhookRoute(route);
    log.warn('Slack instance credentials not available yet — webhook route held pending', {
      instance: spec.instance,
      path: `/webhook/${route}`,
    });
    return null;
  }
  const slackAdapter = createSlackAdapterForSpec(spec, credentials);
  return slackAdapter ? assembleSlackBridge(spec, slackAdapter) : null;
}

/** Construction knobs for one env-mode Slack bot identity. */
export interface SlackBridgeOptions {
  /**
   * Registry/bridge instance key (e.g. 'slack-alpha'). Omit for the default
   * instance, keyed by channelType. The credential provider derives the
   * `.env` suffix from it (`slack-alpha` → SLACK_BOT_TOKEN_ALPHA …).
   * channelType stays 'slack' either way — instance is a host-side routing
   * key only, so user ids, formatting, container config, and the
   * wiring-defaults declaration are shared with the default Slack app.
   */
  instanceKey?: string;
}

/** SLACK_WORKSPACE_ID_<NAME> for one instance, else the SLACK_WORKSPACE_ID every instance shares, else no pin. */
function envWorkspacePin(instance: string): string | undefined {
  const own = channelInstanceEnvKey('SLACK_WORKSPACE_ID', 'slack', instance);
  const env = readEnvFile([own, 'SLACK_WORKSPACE_ID']);
  return env[own] ?? env.SLACK_WORKSPACE_ID;
}

/**
 * Env-mode construction: the default app (no options) or a SLACK_INSTANCES
 * name. Builds the instance's spec at start — transport follows the
 * app-level token (Socket Mode when present, as before), the route is the
 * legacy single segment, the pin is SLACK_WORKSPACE_ID — and feeds the same
 * spec-driven construction a registered connection gets. Returns null when
 * the bot token is missing so the registry surfaces its normal "credentials
 * missing, skipping" warning.
 */
export async function createSlackBridge(options: SlackBridgeOptions = {}): Promise<ChannelAdapter | null> {
  const instance = options.instanceKey ?? 'slack';
  const credentials = await resolveSlackCredentials(instance);
  const spec: ChannelInstanceSpec = {
    instance,
    channelType: 'slack',
    externalScope: envWorkspacePin(instance),
    transport: credentials.appToken ? 'socket' : 'webhook',
    webhookPath: `/webhook/${instance}`,
  };
  const slackAdapter = createSlackAdapterForSpec(spec, credentials);
  return slackAdapter ? assembleSlackBridge(spec, slackAdapter) : null;
}

/**
 * Build one named instance's bridge from its per-instance token set, through
 * the shared env-mode construction. Returns null when the bot token is
 * missing so the registry surfaces its normal "credentials missing,
 * skipping" warning.
 *
 * Exported so a test (and the slack-agent-flow hot start) can drive the real
 * factory against a token set.
 */
export function slackInstanceBridgeFactory(name: string): Promise<ChannelAdapter | null> {
  return createSlackBridge({ instanceKey: `slack-${name}` });
}

registerChannelAdapter('slack', {
  factory: () => createSlackBridge(),
  defaults: SLACK_DEFAULTS,
});

// Named instances — registration is unconditional for every listed name so a
// missing token set surfaces as the registry's "credentials missing, skipping"
// warning at boot rather than a silently absent bot. Every registration carries
// the same SLACK_DEFAULTS declaration as the default app, so offline creation
// paths (setup, ncl) resolve declared wiring defaults for named instances too.
for (const raw of (readEnvFile(['SLACK_INSTANCES']).SLACK_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  registerChannelAdapter(`slack-${name}`, {
    factory: () => slackInstanceBridgeFactory(name),
    defaults: SLACK_DEFAULTS,
  });
}

// Connection-registered instances (registerChannelInstance with channelType
// 'slack'): the same construction from a stored spec — credentials through
// the provider at start, pinned to the connection's workspace, routed at
// /webhook/slack/<instance>.
registerChannelInstanceFactory('slack', (spec) => ({
  factory: () => createSlackBridgeFromSpec(spec),
  defaults: SLACK_DEFAULTS,
}));
