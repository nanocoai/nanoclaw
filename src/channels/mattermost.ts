/** Mattermost channel adapter — Chat SDK bridge registration. */
import { MattermostAdapter } from './mattermost-adapter/index.js';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

export const MATTERMOST_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

export interface MattermostAdapterConfig {
  baseUrl: string;
  botToken: string;
  callbackUrl?: string;
  callbackSecret?: string;
}

/** Exported for live integration tests; construction has no network side effects. */
export function buildMattermostAdapter(config: MattermostAdapterConfig): MattermostAdapter {
  return new MattermostAdapter({
    url: config.baseUrl,
    token: config.botToken,
    ...(config.callbackUrl ? { callbackUrl: config.callbackUrl } : {}),
    ...(config.callbackSecret ? { callbackSecret: config.callbackSecret } : {}),
  });
}

registerChannelAdapter('mattermost', {
  factory: () => {
    const env = readEnvFile([
      'MATTERMOST_BASE_URL',
      'MATTERMOST_BOT_TOKEN',
      'MATTERMOST_CALLBACK_URL',
      'MATTERMOST_CALLBACK_SECRET',
    ]);
    if (!env.MATTERMOST_BASE_URL || !env.MATTERMOST_BOT_TOKEN) return null;

    const adapter = buildMattermostAdapter({
      baseUrl: env.MATTERMOST_BASE_URL,
      botToken: env.MATTERMOST_BOT_TOKEN,
      callbackUrl: env.MATTERMOST_CALLBACK_URL,
      callbackSecret: env.MATTERMOST_CALLBACK_SECRET,
    });

    const bridge = createChatSdkBridge({
      adapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: MATTERMOST_DEFAULTS,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        return (await adapter.fetchThread(platformId)).channelName ?? null;
      } catch (err) {
        if (err instanceof Error) return null;
        throw err;
      }
    };
    return bridge;
  },
  defaults: MATTERMOST_DEFAULTS,
});
