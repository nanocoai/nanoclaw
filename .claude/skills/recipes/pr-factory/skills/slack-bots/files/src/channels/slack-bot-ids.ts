/**
 * Shared sibling-bot suppression for multi-instance Slack installs
 * (owned by the pr-factory `slack-bots` component skill).
 *
 * Three Slack apps (worker, supervisor, tester) share one workspace. Each
 * adapter resolves its own bot user ID via auth.test at factory time and adds
 * it to the shared `slackBotUserIds` Set; each adapter's bridge is wrapped
 * with `withSiblingEchoGuard`, which silently drops inbound messages authored
 * by any registered sibling — preventing cross-bot echo loops in shared
 * channels.
 *
 * The guard wraps `bridge.setup` and intercepts the host's
 * `ChannelSetup.onInbound` callback, so one wrapper covers all four Chat SDK
 * dispatch paths (onSubscribedMessage, onNewMention, onDirectMessage,
 * onNewMessage) with zero core edits. The bridge stamps `content.senderId`
 * from the SDK author in messageToInbound (src/channels/chat-sdk-bridge.ts),
 * which is what the guard matches on.
 *
 * Accepted trade-off: the guard sits on the host side of the bridge's
 * messageToInbound, so a sibling message's attachments are downloaded before
 * the message is discarded. Negligible for Slack bot chatter (sibling bots
 * post text/cards); a native bridge-side `ignoreSenderIds` hook that drops
 * before attachment download is a candidate upstream carve-out, not part of
 * this skill.
 */
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';

export const slackBotUserIds = new Set<string>();

/**
 * Resolve a Slack bot's user ID from its token and add it to the shared set.
 * Safe to call multiple times — idempotent. Fire-and-forget at factory time:
 * the bridge holds the Set by identity and consults it per message, so an id
 * that lands after setup is still honored.
 */
export async function registerSlackBotUserId(token: string, label: string): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = (await res.json()) as { ok: boolean; user_id?: string };
    if (data.ok && data.user_id) {
      slackBotUserIds.add(data.user_id);
      log.info('Registered Slack bot user ID', { label, userId: data.user_id });
    }
  } catch (err) {
    log.warn('Failed to resolve Slack bot user ID', { label, err });
  }
}

/**
 * Wrap a bridge so inbound messages authored by a sibling bot (senderId in
 * `ids`) are dropped before they reach the host router. Mutates and returns
 * the same adapter object so factory-attached extras (resolveChannelName,
 * openDM) survive regardless of whether they're set before or after wrapping.
 */
export function withSiblingEchoGuard(bridge: ChannelAdapter, ids: ReadonlySet<string>): ChannelAdapter {
  const originalSetup = bridge.setup.bind(bridge);
  bridge.setup = async (hostConfig: ChannelSetup): Promise<void> => {
    const forward = hostConfig.onInbound.bind(hostConfig);
    await originalSetup({
      ...hostConfig,
      onInbound(platformId, threadId, message) {
        const senderId = (message.content as { senderId?: unknown } | null | undefined)?.senderId;
        if (typeof senderId === 'string' && ids.has(senderId)) {
          log.debug('Dropped sibling-bot inbound', { adapter: bridge.name, platformId, senderId });
          return;
        }
        return forward(platformId, threadId, message);
      },
    });
  };
  return bridge;
}
