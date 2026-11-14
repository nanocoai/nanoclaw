/**
 * Slack channel adapter for the PR Tester bot.
 *
 * Runs alongside the primary Slack bot (slack.ts) with a distinct bot
 * identity. The named `instance` drives the registry key, the webhook route
 * (/webhook/slack-tester), the Chat SDK state namespace, and
 * `messaging_groups.instance` — the router disambiguates per-instance,
 * channelType stays 'slack'.
 *
 * Self-registers on import. Inert if SLACK_TESTER_BOT_TOKEN is unset.
 *
 * Env (read from .env):
 *   SLACK_TESTER_BOT_TOKEN      — tester app's bot token
 *   SLACK_TESTER_SIGNING_SECRET — tester app's signing secret
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { slackBotUserIds, registerSlackBotUserId, withSiblingEchoGuard } from './slack-bot-ids.js';

/** Single owner of the tester instance name — imported by the pr-factory
 *  module; keep the export stable. */
export const TESTER_INSTANCE = 'slack-tester';

registerChannelAdapter(TESTER_INSTANCE, {
  factory: () => {
    const env = readEnvFile(['SLACK_TESTER_BOT_TOKEN', 'SLACK_TESTER_SIGNING_SECRET']);
    if (!env.SLACK_TESTER_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_TESTER_BOT_TOKEN,
      signingSecret: env.SLACK_TESTER_SIGNING_SECRET,
    });
    void registerSlackBotUserId(env.SLACK_TESTER_BOT_TOKEN, 'tester');
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      instance: TESTER_INSTANCE,
      concurrency: 'concurrent',
      supportsThreads: true,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return withSiblingEchoGuard(bridge, slackBotUserIds);
  },
});
