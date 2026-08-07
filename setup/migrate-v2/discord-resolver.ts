/**
 * Discord channel → platform_id resolver for the v1 → v2 migration.
 *
 * v1 stored Discord groups as `dc:<channelId>` — only the channel id, with
 * no signal for guild vs. DM. v2's `@chat-adapter/discord` encodes
 * `platform_id` as either `discord:<guildId>:<channelId>` (guild channel)
 * or `discord:@me:<channelId>` (DM / group DM) — see `guild_id || "@me"`
 * in the runtime adapter. We can't reconstruct that from v1 data alone, so
 * we use the v1 bot token (carried forward by 1a-env) to query Discord:
 *   1. Enumerate every guild the bot is in and every channel in those
 *      guilds → channelId → guildId map.
 *   2. For any v1 channel id NOT in that map, classify via `GET
 *      /channels/<id>` — DM (type=1) and GROUP_DM (type=3) get
 *      `discord:@me:<id>`. Anything else returns null and the caller
 *      skips with a warning.
 *
 * Network calls are best-effort: on auth failure or network error, the
 * resolver returns null for every channel and the caller falls back to
 * skipping with a clear warning.
 */

const DISCORD_API = 'https://discord.com/api/v10';

// Discord channel types we care about. See:
// https://discord.com/developers/docs/resources/channel#channel-object-channel-types
const CHANNEL_TYPE_DM = 1;
const CHANNEL_TYPE_GROUP_DM = 3;

interface Guild {
  id: string;
  name: string;
}

interface Channel {
  id: string;
  name?: string;
}

interface ChannelInfo {
  id: string;
  type: number;
}

export interface DiscordResolver {
  /**
   * Returns the v2 `platform_id` for a v1 channel id, or null if the bot
   * can't see it. Format is `discord:<guildId>:<channelId>` for guild
   * channels and `discord:@me:<channelId>` for DMs / group DMs.
   */
  resolve(channelId: string): string | null;
  /** Diagnostic info — guild count, channel count, DM count, optional disable reason. */
  stats(): { guilds: number; channels: number; dms: number; reason?: string };
}

/** A no-op resolver that returns null for every lookup with a stored reason. */
function emptyResolver(reason: string): DiscordResolver {
  return {
    resolve: () => null,
    stats: () => ({ guilds: 0, channels: 0, dms: 0, reason }),
  };
}

type FetchFn = typeof fetch;

async function getJson<T>(url: string, token: string, fetchImpl: FetchFn): Promise<T> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'NanoClaw-Migration (https://github.com/nanocoai/nanoclaw, 2.x)',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Build a Discord resolver by enumerating every guild the bot is in and
 * every channel in those guilds, then classifying any `unresolvedChannelIds`
 * that didn't show up in a guild via `GET /channels/<id>` (so DMs and
 * group DMs can be encoded as `discord:@me:<id>`).
 *
 * Returns an empty resolver on any error during guild enumeration.
 *
 * Costs: 1 + N + K HTTP calls — N = guild count (enumerated channels per
 * guild), K = unresolved-channel classification calls. Discord's global
 * rate limit is 50 req/s; even installs with hundreds of guilds finish in
 * under a second of network time.
 */
export async function buildDiscordResolver(
  token: string,
  unresolvedChannelIds: string[] = [],
  fetchImpl: FetchFn = fetch,
): Promise<DiscordResolver> {
  if (!token) return emptyResolver('no DISCORD_BOT_TOKEN in .env');

  // Page through guilds. Default page size is 200; loop until short page.
  const guilds: Guild[] = [];
  let after: string | null = null;
  try {
    while (true) {
      const url = new URL(`${DISCORD_API}/users/@me/guilds`);
      url.searchParams.set('limit', '200');
      if (after) url.searchParams.set('after', after);
      const page = await getJson<Guild[]>(url.toString(), token, fetchImpl);
      guilds.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
  } catch (err) {
    return emptyResolver(`failed to list guilds: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Per-guild channel enumeration.
  const channelToGuild = new Map<string, string>();
  for (const guild of guilds) {
    try {
      const channels = await getJson<Channel[]>(
        `${DISCORD_API}/guilds/${guild.id}/channels`,
        token,
        fetchImpl,
      );
      for (const ch of channels) {
        channelToGuild.set(ch.id, guild.id);
      }
    } catch (err) {
      // Skip this guild but keep going — partial results are still useful.
      // The caller logs which channels couldn't be resolved.
      console.error(
        `WARN:discord-resolver: failed to enumerate guild ${guild.id} (${guild.name}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Classify any v1 channel ids that didn't surface in a guild — they're
  // most likely DMs (type=1) or group DMs (type=3). Anything else (404,
  // 403, type=0 in a guild the bot left) stays unresolved so the caller's
  // existing skip-with-warning path fires.
  const dmChannels = new Set<string>();
  const seen = new Set<string>();
  for (const channelId of unresolvedChannelIds) {
    if (channelToGuild.has(channelId)) continue;
    if (seen.has(channelId)) continue;
    seen.add(channelId);
    try {
      const ch = await getJson<ChannelInfo>(
        `${DISCORD_API}/channels/${channelId}`,
        token,
        fetchImpl,
      );
      if (ch.type === CHANNEL_TYPE_DM || ch.type === CHANNEL_TYPE_GROUP_DM) {
        dmChannels.add(channelId);
      }
    } catch {
      // Channel not visible to the bot — leave it unresolved.
    }
  }

  return {
    resolve(channelId: string): string | null {
      const guildId = channelToGuild.get(channelId);
      if (guildId) return `discord:${guildId}:${channelId}`;
      if (dmChannels.has(channelId)) return `discord:@me:${channelId}`;
      return null;
    },
    stats: () => ({
      guilds: guilds.length,
      channels: channelToGuild.size,
      dms: dmChannels.size,
    }),
  };
}
