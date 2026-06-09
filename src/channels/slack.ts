/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Auto-detects socket mode when SLACK_APP_TOKEN is set; otherwise falls back
 * to webhook mode using SLACK_SIGNING_SECRET.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = env.SLACK_APP_TOKEN
      ? createSlackAdapter({
          mode: 'socket',
          botToken: env.SLACK_BOT_TOKEN,
          appToken: env.SLACK_APP_TOKEN,
        })
      : createSlackAdapter({
          botToken: env.SLACK_BOT_TOKEN,
          signingSecret: env.SLACK_SIGNING_SECRET,
        });
    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
