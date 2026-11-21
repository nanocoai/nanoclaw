/**
 * Second Slack adapter — the PR Factory Supervisor bot.
 *
 * Runs alongside the primary Slack worker bot (slack.ts) so the same
 * workspace has two distinct bot identities. The named `instance` drives the
 * registry key, the webhook route (/webhook/slack-supervisor), the Chat SDK
 * state namespace, and `messaging_groups.instance` — the router
 * disambiguates per-instance, channelType stays 'slack'.
 *
 * Self-registers on import. Inert if SLACK_SUPERVISOR_BOT_TOKEN is unset.
 *
 * Env (read from .env):
 *   SLACK_SUPERVISOR_BOT_TOKEN      — supervisor app's bot token
 *   SLACK_SUPERVISOR_SIGNING_SECRET — supervisor app's signing secret
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { slackBotUserIds, registerSlackBotUserId, withSiblingEchoGuard } from './slack-bot-ids.js';

/** Single owner of the supervisor instance name — imported by the
 *  pr-factory module's bootstrap; keep the export stable. */
export const SUPERVISOR_INSTANCE = 'slack-supervisor';

registerChannelAdapter(SUPERVISOR_INSTANCE, {
  factory: () => {
    const env = readEnvFile(['SLACK_SUPERVISOR_BOT_TOKEN', 'SLACK_SUPERVISOR_SIGNING_SECRET']);
    if (!env.SLACK_SUPERVISOR_BOT_TOKEN) return null;
    const adapter = createSlackAdapter({
      botToken: env.SLACK_SUPERVISOR_BOT_TOKEN,
      signingSecret: env.SLACK_SUPERVISOR_SIGNING_SECRET,
    });
    void registerSlackBotUserId(env.SLACK_SUPERVISOR_BOT_TOKEN, 'supervisor');
    const bridge = createChatSdkBridge({
      adapter,
      instance: SUPERVISOR_INSTANCE,
      concurrency: 'concurrent',
      supportsThreads: true,
    });
    return withSiblingEchoGuard(bridge, slackBotUserIds);
  },
});
