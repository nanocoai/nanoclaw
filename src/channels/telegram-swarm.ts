/**
 * Telegram bot pool — "swarm" multiplexing for multi-persona agent teams.
 *
 * Reads a comma-separated list of bot tokens from TELEGRAM_BOT_POOL. The
 * primary `TELEGRAM_BOT_TOKEN` is reserved for inbound polling and is NOT
 * included in the pool. Each pool bot is send-only.
 *
 * On the agent side, `mcp__nanoclaw__send_message({ sender: "<name>", ... })`
 * embeds a `sender` field in the outbound content. The Telegram adapter's
 * `deliver` wrapper sees that field and picks a pool bot:
 *
 *   - Sticky-per-(platformId, sender): the same persona in the same chat
 *     always speaks through the same bot, so its identity stays stable.
 *   - Round-robin assignment on first use across all of the pool's bots.
 *   - On first assignment we rename the bot via setMyName(<sender>) so the
 *     bot's display name in Telegram matches the persona.
 *
 * Without `TELEGRAM_BOT_POOL` (or with an empty pool), `sender` is ignored
 * and the message is sent through the primary bot like any other message.
 */
import { log } from '../log.js';

interface PoolBot {
  token: string;
  username: string;
}

const pool: PoolBot[] = [];
let nextPoolIndex = 0;
const senderBotIndex = new Map<string, number>();

/** Parse the TELEGRAM_BOT_POOL env value into a list of tokens. */
function parsePool(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

async function getMe(token: string): Promise<{ id: number; username?: string } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { id: number; username?: string } };
    return json.ok && json.result ? json.result : null;
  } catch (err) {
    log.warn('Telegram pool: getMe failed', { err });
    return null;
  }
}

/**
 * Initialize the pool from a token list. Drops invalid tokens with a warn
 * log; returns the number of bots that came up healthy.
 */
export async function initPool(envValue: string | undefined): Promise<number> {
  const tokens = parsePool(envValue);
  for (const token of tokens) {
    const me = await getMe(token);
    if (!me) {
      log.warn('Telegram pool: skipping invalid token', { tokenPrefix: token.slice(0, 8) });
      continue;
    }
    pool.push({ token, username: me.username ?? `bot_${me.id}` });
  }
  if (pool.length > 0) {
    log.info('Telegram pool ready', { count: pool.length, usernames: pool.map((b) => b.username) });
  }
  return pool.length;
}

/** Pool size — zero means no pool was configured (or all tokens were bad). */
export function poolSize(): number {
  return pool.length;
}

/**
 * Pick a pool bot for the given (platformId, sender) pair. Sticky after
 * first use. Returns null if the pool is empty.
 */
function pickBot(platformId: string, sender: string): PoolBot | null {
  if (pool.length === 0) return null;
  const key = `${platformId}:${sender}`;
  let idx = senderBotIndex.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % pool.length;
    nextPoolIndex++;
    senderBotIndex.set(key, idx);
  }
  return pool[idx];
}

/**
 * Send a plain-text message via a pool bot picked for (platformId, sender).
 * Returns the Telegram message_id as a string on success, undefined on a
 * failure that should NOT block the agent's poll loop. Callers should fall
 * back to the primary bot when this returns undefined.
 *
 * On first assignment, the bot is renamed via setMyName(sender) so the
 * sender's persona shows up in Telegram. We then wait briefly for the
 * rename to propagate before sending.
 */
export async function sendViaPool(platformId: string, sender: string, text: string): Promise<string | undefined> {
  const bot = pickBot(platformId, sender);
  if (!bot) return undefined;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return undefined;

  // Rename only once per (platformId, sender). The sticky map is the
  // assignment record; track renames in a separate Set.
  const renameKey = `${platformId}:${sender}`;
  if (!renamed.has(renameKey)) {
    renamed.add(renameKey);
    try {
      const r = await fetch(`https://api.telegram.org/bot${bot.token}/setMyName`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: sender }),
      });
      if (!r.ok) {
        log.warn('Telegram pool: setMyName non-OK', { status: r.status, sender });
      }
      // Telegram needs a brief moment to propagate the new name.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      log.warn('Telegram pool: setMyName threw', { sender, err });
    }
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const json = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    if (!json.ok || !json.result) {
      log.warn('Telegram pool: sendMessage non-OK', { sender });
      return undefined;
    }
    return String(json.result.message_id);
  } catch (err) {
    log.warn('Telegram pool: sendMessage threw', { sender, err });
    return undefined;
  }
}

const renamed = new Set<string>();
