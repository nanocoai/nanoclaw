/**
 * Slack reaction helpers for PR thread status indicators.
 *
 * 🟢 open — added on thread creation
 * 🔴 closed — swapped in on close
 * 🟣 merged — swapped in on merge
 * 👀 awaiting approval — added when an approval card is posted, removed when acted on
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { getPrThreadBySession } from '../../db/pr-threads.js';
import type { Session } from '../../types.js';

export const EMOJI_OPEN = 'large_green_circle';
export const EMOJI_CLOSED = 'red_circle';
export const EMOJI_MERGED = 'large_purple_circle';
export const EMOJI_DRAFT = 'white_circle';
export const EMOJI_AWAITING = 'warning';

let cachedBotToken: string | null = null;
export function getBotToken(): string {
  if (!cachedBotToken) {
    const env = readEnvFile(['SLACK_BOT_TOKEN']);
    cachedBotToken = env.SLACK_BOT_TOKEN || '';
  }
  return cachedBotToken;
}

export async function addReaction(
  botToken: string,
  channelId: string,
  timestamp: string,
  emoji: string,
): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: channelId, timestamp, name: emoji }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok && body.error !== 'already_reacted') {
      log.warn('Slack reactions.add failed', { emoji, error: body.error });
    }
  } catch (err) {
    log.warn('Slack reactions.add error', { emoji, err });
  }
}

export async function removeReaction(
  botToken: string,
  channelId: string,
  timestamp: string,
  emoji: string,
): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/reactions.remove', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: channelId, timestamp, name: emoji }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok && body.error !== 'no_reaction') {
      log.warn('Slack reactions.remove failed', { emoji, error: body.error });
    }
  } catch (err) {
    log.warn('Slack reactions.remove error', { emoji, err });
  }
}

/** Add 👀 to a PR thread opener to signal it needs attention. */
export async function markAwaitingApproval(session: Session): Promise<void> {
  const pr = getPrThreadBySession(session.id);
  if (!pr) return;
  const bareChannel = pr.channel_id.replace(/^slack:/, '');
  await addReaction(getBotToken(), bareChannel, pr.thread_ts, EMOJI_AWAITING);
}

/** Remove 👀 from a PR thread opener after approval is handled. */
export async function clearAwaitingApproval(session: Session): Promise<void> {
  const pr = getPrThreadBySession(session.id);
  if (!pr) return;
  const bareChannel = pr.channel_id.replace(/^slack:/, '');
  await removeReaction(getBotToken(), bareChannel, pr.thread_ts, EMOJI_AWAITING);
}
