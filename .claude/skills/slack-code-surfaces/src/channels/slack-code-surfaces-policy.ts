/**
 * Who may speak into a coding session's Slack surface — the admission policy
 * for bot-authored inbound, and the notice filter, on the channel's
 * bot-inbound guard (slack-a2a-guard.ts).
 *
 * A session's channel holds humans, this host's bot, the bots of other
 * sandboxes that joined (possibly on other hosts), and the manager app that
 * runs the channel for the service. The guard drops every bot-authored
 * message by default; this policy admits, for channels that are a surface
 * this host is on, exactly the members the service lists:
 *
 *   - allowlist = the channel record's `members[]` from the service (read
 *     through the community-portal surface module's client, cached a short
 *     while per channel); a bot the record does not list stays dropped;
 *   - the manager's bot is never admitted, listed or not: its status, diff
 *     and system posts are the surface's furniture, not mail for the agent;
 *   - a consecutive-hop cap per channel and bot identity (the rooms skill's
 *     mechanism: N bot messages without a human one, then silence until a
 *     human speaks; `SLACK_A2A_MAX_HOPS`, default 6);
 *   - the `nanoclaw_agent` routing header, when a post carries one: its
 *     `hops` count also bounds the cap and its `addressed_to` list, when
 *     present, must name this host's bot or one of its sandboxes;
 *   - admitted posts are re-attributed as `slack:bot:<bot user id>` so the
 *     users row is distinguishable from a human's `slack:U…`.
 *
 * The manager's system notices ("added view …") reach the adapter WITHOUT
 * a bot id — the platform posts them on the app's behalf — so the guard
 * would pass them as human and they would be typed into the session as
 * mail. The policy names them for the guard (`noticeOf`): in a surface
 * channel, a message from a user the record knows as a bot (the manager,
 * a member, this host's own) or from the platform's own user is a notice.
 *
 * For a channel this host knows as a surface every answer is final: admit
 * or deny, and no later policy on the chain (the rooms skill's, say) can
 * re-admit what was denied here, whatever the order. Every other channel
 * is passed on untouched: bot posts there go to the next policy or the
 * guard's default drop, humans pass as always. The hop budget is reserved
 * when a message is admitted, not when it is delivered, so the cap holds
 * for messages arriving together; a delivery that fails gives it back.
 *
 * The record is read through the surface module's exported client only —
 * never the binding table. A host with no session surface on Slack asks
 * nothing and admits nothing. A human message never waits on the service:
 * the notice filter answers from the cache only, and a channel it has not
 * seen is refreshed in the background for the next message.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import {
  addBotInboundPolicy,
  BOT_INBOUND_POLICY_SEAM,
  type SlackBotInboundContext,
  type SlackBotInboundDecision,
  type SlackBotInboundPolicy,
  type SlackInboundContext,
  type SlackInboundNotice,
} from './slack-a2a-guard.js';
import { resolveBotIdentity } from './slack-bot-identity.js';

/** The policy's name on the guard's chain. */
export const SLACK_CODE_SURFACES_POLICY = 'slack-code-surfaces';

/** The platform kind the surface module serves Slack under (the adapter's channel type). */
const PLATFORM = 'slack';

export const DEFAULT_MAX_HOPS = 6;

/** The message-metadata event type every agent post carries as its routing header. */
export const AGENT_HEADER_EVENT = 'nanoclaw_agent';

/** Slack's own user, the author of platform-generated lines. */
export const PLATFORM_USER = 'USLACKBOT';

/** How long a channel's record is trusted before it is read again. */
export const RECORD_TTL_MS = 60_000;
/** How long "not a surface this host is on" is remembered for a channel. */
export const MISS_TTL_MS = 5 * 60_000;

/** The routing header an agent post carries in its message metadata. */
export interface AgentHeader {
  senderBot?: string;
  sandbox?: string;
  account?: string;
  hops?: number;
  task?: string;
  addressedTo?: string[];
}

/** What the policy needs from a channel's record: who is on it. */
export interface SurfaceMemberView {
  /** The member's bot user (`U…`), what the adapter reports as the author of its posts. */
  botUserId: string;
  /** The member's bot id (`B…`), when the service records it. */
  botId?: string;
  role?: string;
  sandboxName?: string | null;
}

export interface SurfaceRecordView {
  /** The bot user that opened the channel (its owner), when known. */
  botUserId?: string | null;
  /** The manager app's bot user, when the service names it. */
  managerBotUserId?: string | null;
  members: SurfaceMemberView[];
}

/** Seams the policy goes through; tests swap them. */
export interface SlackCodeSurfacesPolicyDeps {
  /**
   * The channel's record when it is a coding-session surface this host is
   * on; null when it is not (or no surface is served on this host). A
   * throw is a transient failure: bot posts are dropped, humans pass.
   */
  lookup(channelId: string): Promise<SurfaceRecordView | null>;
  /** This host's own bot user on the workspace, for `addressed_to`; null when unknown. */
  ownBotUserId(): Promise<string | null>;
  maxHops(): number;
  now(): number;
}

const hopsOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const stringsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : undefined;

/**
 * The `nanoclaw_agent` header on a bridge-serialized message, from the
 * platform metadata the adapter forwards (`metadata.event_type` +
 * `event_payload`, on the content or on its raw event). Null when the post
 * carries none — a human post, or a bridge that does not forward metadata.
 */
export function agentHeaderOf(content: unknown): AgentHeader | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  const raw = c.raw && typeof c.raw === 'object' ? (c.raw as Record<string, unknown>) : undefined;
  for (const candidate of [c.metadata, raw?.metadata]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const meta = candidate as Record<string, unknown>;
    if (meta.event_type !== AGENT_HEADER_EVENT) continue;
    const payload =
      meta.event_payload && typeof meta.event_payload === 'object'
        ? (meta.event_payload as Record<string, unknown>)
        : {};
    const header: AgentHeader = {};
    if (typeof payload.sender_bot === 'string') header.senderBot = payload.sender_bot;
    if (typeof payload.sandbox === 'string') header.sandbox = payload.sandbox;
    if (typeof payload.account === 'string') header.account = payload.account;
    const hops = hopsOf(payload.hops);
    if (hops !== undefined) header.hops = hops;
    if (typeof payload.task === 'string') header.task = payload.task;
    const addressedTo = stringsOf(payload.addressed_to);
    if (addressedTo) header.addressedTo = addressedTo;
    return header;
  }
  return null;
}

export function parseMaxHops(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_HOPS;
}

/** The guard reports the adapter's channel id (`slack:C0…`); the service keys on the raw id. */
export function channelIdOf(platformId: string): string {
  const idx = platformId.indexOf(':');
  return idx === -1 ? platformId : platformId.slice(idx + 1);
}

function authorUserIdOf(message: SlackInboundContext['message']): string | undefined {
  const content =
    message.content && typeof message.content === 'object' ? (message.content as Record<string, unknown>) : undefined;
  const author =
    content?.author && typeof content.author === 'object' ? (content.author as Record<string, unknown>) : undefined;
  return typeof author?.userId === 'string' ? author.userId : undefined;
}

/** Every bot user the record names, by role, for the notice filter. */
function botUsersOf(record: SurfaceRecordView): Map<string, string> {
  const users = new Map<string, string>();
  for (const member of record.members) users.set(member.botUserId, member.role ?? 'member');
  if (record.botUserId) users.set(record.botUserId, 'owner');
  if (record.managerBotUserId) users.set(record.managerBotUserId, 'manager');
  return users;
}

/** The record's member for the guard's bot author, matched on either id the platform reports. */
function memberOf(record: SurfaceRecordView, botId: string): SurfaceMemberView | undefined {
  return record.members.find((m) => m.botUserId === botId || m.botId === botId);
}

// ---------------------------------------------------------------------------
// The default seams: the surface module's client, the platform half's identity
// ---------------------------------------------------------------------------

/** The record from the service, through the surface module; null when the channel is not a surface this host is on. */
async function serviceLookup(channelId: string): Promise<SurfaceRecordView | null> {
  // Loaded on first use: the surface module is the community-portal's, and
  // this policy must cost the channel barrel nothing when it is absent.
  const surface = await import('../modules/community-portal/surface/index.js');
  const found = await surface.clientForRow({ provider: PLATFORM });
  if (!found) return null;
  const { isNotFound } = await import('../modules/community-portal/surface/client.js');
  let record;
  try {
    record = await found.client.get(channelId);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const managed = record as { managerBotUserId?: string | null };
  return {
    botUserId: record.botUserId ?? null,
    managerBotUserId: typeof managed.managerBotUserId === 'string' ? managed.managerBotUserId : null,
    members: (record.members ?? []).map((m) => {
      const withBotId = m as { botId?: string };
      return {
        botUserId: m.botUserId,
        ...(typeof withBotId.botId === 'string' ? { botId: withBotId.botId } : {}),
        ...(m.role ? { role: m.role } : {}),
        ...(m.sandboxName ? { sandboxName: m.sandboxName } : {}),
      };
    }),
  };
}

async function serviceOwnBotUserId(): Promise<string | null> {
  const surface = await import('../modules/community-portal/surface/index.js');
  const install = await surface.managedInstall(PLATFORM);
  if (!install) return null;
  const identity = await resolveBotIdentity({
    root: process.cwd(),
    appId: install.appId,
    ...(install.botToken ? { botToken: install.botToken } : {}),
  });
  return identity?.botUserId ?? null;
}

const defaultDeps: SlackCodeSurfacesPolicyDeps = {
  lookup: serviceLookup,
  ownBotUserId: serviceOwnBotUserId,
  maxHops: () => parseMaxHops(readEnvFile(['SLACK_A2A_MAX_HOPS']).SLACK_A2A_MAX_HOPS),
  now: () => Date.now(),
};

let deps: SlackCodeSurfacesPolicyDeps = defaultDeps;

export function setSlackCodeSurfacesPolicyDeps(overrides: Partial<SlackCodeSurfacesPolicyDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  cache.clear();
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

interface CachedRecord {
  at: number;
  record: SurfaceRecordView | null;
}

const cache = new Map<string, CachedRecord>();
/** Lookups in flight, so two rapid messages for one channel share a read. */
const inFlight = new Map<string, Promise<SurfaceRecordView | null>>();
/** Consecutive accepted bot hops, keyed `<instanceKey>:<channel>`. */
const hops = new Map<string, number>();

/** Slack conversation ids a coding session's surface can be (a channel, public or private). */
const SURFACE_ID = /^[CG][A-Z0-9]+$/;

/** Forget every cached record, in-flight lookup and hop count. */
export function resetSlackCodeSurfacesPolicyForTesting(): void {
  cache.clear();
  inFlight.clear();
  hops.clear();
}

/** The cached record when it is fresh (a hit for RECORD_TTL_MS, a miss for MISS_TTL_MS); undefined otherwise. */
function freshRecord(channelId: string): SurfaceRecordView | null | undefined {
  const cached = cache.get(channelId);
  if (!cached) return undefined;
  return deps.now() - cached.at < (cached.record ? RECORD_TTL_MS : MISS_TTL_MS) ? cached.record : undefined;
}

/** Read the record once, however many callers ask while the read is in flight. */
function refreshRecord(channelId: string): Promise<SurfaceRecordView | null> {
  let pending = inFlight.get(channelId);
  if (!pending) {
    pending = deps
      .lookup(channelId)
      .then((record) => {
        cache.set(channelId, { at: deps.now(), record });
        return record;
      })
      .finally(() => {
        if (inFlight.get(channelId) === pending) inFlight.delete(channelId);
      });
    inFlight.set(channelId, pending);
  }
  return pending;
}

/** The channel's record, from the cache when fresh, else read (once) from the service. */
function recordOf(channelId: string): Promise<SurfaceRecordView | null> {
  const fresh = freshRecord(channelId);
  return fresh === undefined ? refreshRecord(channelId) : Promise.resolve(fresh);
}

/** Whether an `addressed_to` list names this host: its bot user, or a sandbox of its on the channel. */
async function addressedToUs(record: SurfaceRecordView, addressedTo: string[]): Promise<boolean> {
  const own = await deps.ownBotUserId();
  if (!own) return false;
  const names = new Set<string>([own]);
  for (const member of record.members) {
    if (member.botUserId === own && member.sandboxName) names.add(member.sandboxName);
  }
  return addressedTo.some((target) => names.has(target));
}

export function createSlackCodeSurfacesPolicy(): SlackBotInboundPolicy {
  return {
    async decideBotInbound(ctx: SlackBotInboundContext): Promise<SlackBotInboundDecision> {
      const channelId = channelIdOf(ctx.platformId);
      let record: SurfaceRecordView | null;
      try {
        record = await recordOf(channelId);
      } catch (err) {
        log.warn('slack-code-surfaces: surface record unreadable — denying bot-authored inbound', {
          channelId,
          botId: ctx.botId,
          err,
        });
        // Fail closed and final: a channel that may be a surface must not be
        // re-admitted by a later policy while the service cannot say.
        return { action: 'deny', reason: 'surface record unreadable' };
      }
      if (!record) return { action: 'pass', reason: 'not a coding-session surface this host is on' };

      const member = memberOf(record, ctx.botId);
      if (ctx.botId === record.managerBotUserId || member?.role === 'manager') {
        return { action: 'deny', reason: 'the surface manager is never admitted' };
      }
      if (!member) return { action: 'deny', reason: 'not a member of the surface' };

      const header = agentHeaderOf(ctx.message.content);
      if (header?.addressedTo?.length && !(await addressedToUs(record, header.addressedTo))) {
        return { action: 'deny', reason: 'not addressed to this host' };
      }

      // The budget is checked and reserved in one synchronous step (no await
      // between the two), so messages arriving together cannot all pass under
      // the same count; a delivery that fails releases its reservation.
      const cap = deps.maxHops();
      const key = `${ctx.instanceKey}:${channelId}`;
      const count = hops.get(key) ?? 0;
      if (count >= cap || (header?.hops ?? 0) >= cap) {
        log.info('slack-code-surfaces: hop limit reached — denying bot messages until a human speaks', {
          channelId,
          botId: ctx.botId,
          maxHops: cap,
          ...(header?.hops !== undefined ? { headerHops: header.hops } : {}),
        });
        return { action: 'deny', reason: 'hop limit reached' };
      }
      hops.set(key, count + 1);

      return {
        action: 'admit',
        senderId: `slack:bot:${ctx.botId}`,
        onFailed: () => hops.set(key, Math.max(0, (hops.get(key) ?? 1) - 1)),
      };
    },

    onHumanInbound(ctx: SlackInboundContext): void {
      hops.delete(`${ctx.instanceKey}:${channelIdOf(ctx.platformId)}`);
    },

    noticeOf(ctx: SlackInboundContext): SlackInboundNotice | null {
      const userId = authorUserIdOf(ctx.message);
      if (!userId) return null;
      const channelId = channelIdOf(ctx.platformId);
      if (!SURFACE_ID.test(channelId)) return null; // a DM or group DM is never a surface
      // A human message never waits on the service: answer from the cache,
      // and let a channel not seen yet be read in the background for the
      // next message. Unreadable is the same as unknown: the message goes on.
      const record = freshRecord(channelId);
      if (record === undefined) {
        refreshRecord(channelId).catch(() => {});
        return null;
      }
      if (!record) return null;
      if (userId === PLATFORM_USER) return { reason: 'platform notice' };
      const role = botUsersOf(record).get(userId);
      return role ? { reason: `${role} bot notice without a bot id` } : null;
    },
  };
}

addBotInboundPolicy(SLACK_CODE_SURFACES_POLICY, createSlackCodeSurfacesPolicy(), { seam: BOT_INBOUND_POLICY_SEAM });
