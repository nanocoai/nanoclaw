/**
 * Slack agent-to-agent (A2A) rooms — the admission policy for bot-authored
 * inbound: room allowlist + consecutive-hop limit + `slack:bot:<bot_id>`
 * re-attribution.
 *
 * The Slack channel layer's bot-inbound guard (src/channels/slack-a2a-guard.ts,
 * installed with the Slack channel) drops every bot-authored inbound message
 * at the bridge boundary by default — sibling and foreign bots never reach the
 * router, so they can neither spam unknown-sender approval cards nor feed each
 * other into loops. The guard exposes a single admission seam
 * (`setBotInboundPolicy`); this module is that policy:
 *
 *   - Rooms allowlisted in `SLACK_A2A_ROOMS` (comma-separated Slack channel
 *     ids, e.g. the MPIM ids printed by scripts/open-a2a-room.ts): bot-authored
 *     inbound is admitted, re-attributed with sender id `slack:bot:<bot_id>`,
 *     under a consecutive-hop limit (`SLACK_A2A_MAX_HOPS`, default 6) that any
 *     human message in the room resets.
 *   - Every other room: bot-authored inbound stays dropped (the guard logs the
 *     drop with this policy's reason).
 *
 * Human-authored messages are structurally outside this policy's power: the
 * guard passes them through untouched and only lets the policy observe them
 * (for the hop-counter reset).
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { setBotInboundPolicy, type SlackBotInboundPolicy } from './slack-a2a-guard.js';

export const DEFAULT_MAX_HOPS = 6;

/** How long a read of SLACK_A2A_ROOMS / SLACK_A2A_MAX_HOPS is cached.
 * Short enough that a room appended to .env by scripts/open-a2a-room.ts is
 * picked up without a service restart. */
const CONFIG_TTL_MS = 30_000;

export interface A2aConfig {
  /** Raw Slack channel ids (C…/G…) allowed to carry bot-authored inbound. */
  rooms: Set<string>;
  /** Consecutive bot-authored inbound messages allowed without a human one. */
  maxHops: number;
}

export function parseRooms(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function parseMaxHops(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_HOPS;
}

let cached: { at: number; config: A2aConfig } | null = null;

function readA2aConfig(): A2aConfig {
  const now = Date.now();
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.config;
  const env = readEnvFile(['SLACK_A2A_ROOMS', 'SLACK_A2A_MAX_HOPS']);
  cached = {
    at: now,
    config: {
      rooms: parseRooms(env.SLACK_A2A_ROOMS),
      maxHops: parseMaxHops(env.SLACK_A2A_MAX_HOPS),
    },
  };
  return cached.config;
}

/** The guard reports the adapter's channel id (`slack:C0…`); the allowlist
 * holds raw Slack channel ids. */
function roomFromPlatformId(platformId: string): string {
  const idx = platformId.indexOf(':');
  return idx === -1 ? platformId : platformId.slice(idx + 1);
}

/**
 * Build the A2A room policy. The hop counter is per bot identity and per room
 * — keyed on the guard's instanceKey, since each bridge instance is one bot
 * identity, and a bot's own outbound never arrives here (the SDK drops `isMe`
 * upstream). With two bots the effective conversation length is therefore
 * roughly 2×maxHops messages. Any human message in a room resets that room's
 * counter for the identity that heard it; every co-hosted identity hears the
 * same human message over its own connection, so the budgets reset together.
 *
 * `getConfig` is injectable for tests; production reads .env with a short TTL
 * cache.
 */
export function createA2aRoomPolicy(getConfig: () => A2aConfig = readA2aConfig): SlackBotInboundPolicy {
  /** Consecutive accepted bot hops, keyed `<instanceKey>:<room>`. */
  const hops = new Map<string, number>();

  return {
    decideBotInbound(ctx) {
      const room = roomFromPlatformId(ctx.platformId);
      const { rooms, maxHops } = getConfig();
      if (!rooms.has(room)) {
        return { action: 'drop', reason: 'room not in SLACK_A2A_ROOMS' };
      }
      const key = `${ctx.instanceKey}:${room}`;
      const count = hops.get(key) ?? 0;
      if (count >= maxHops) {
        log.info('slack-a2a: hop limit reached — dropping bot messages until a human speaks', {
          room,
          botId: ctx.botId,
          maxHops,
        });
        return { action: 'drop', reason: 'hop limit reached' };
      }
      return {
        action: 'admit',
        // The permissions module uses a senderId that already contains a ':'
        // verbatim (see extractAndUpsertUser), so the users row becomes
        // `slack:bot:<bot_id>` — distinguishable from human `slack:U…` ids.
        senderId: `slack:bot:${ctx.botId}`,
        // The guard fires this only after downstream accepted the message —
        // a throw in the host's onInbound must not consume budget for a
        // message that never reached a session.
        onAccepted: () => hops.set(key, count + 1),
      };
    },
    onHumanInbound(ctx) {
      // Human message — reset this identity's hop counter for the room.
      hops.delete(`${ctx.instanceKey}:${roomFromPlatformId(ctx.platformId)}`);
    },
  };
}

// Install the policy on the channel layer's guard (single provider — the
// guard warns if another policy was already installed). Runs on barrel
// import, like every channel module's self-registration.
setBotInboundPolicy(createA2aRoomPolicy());
