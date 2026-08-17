/**
 * GitHub channel adapter (v2) — uses Chat SDK bridge.
 * PR comment threads as conversations.
 * Self-registers on import.
 */
import { createGitHubAdapter } from '@chat-adapter/github';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('github', {
  factory: () => {
    const env = readEnvFile(['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_BOT_USERNAME']);
    if (!env.GITHUB_TOKEN) return null;
    const githubAdapter = createGitHubAdapter({
      token: env.GITHUB_TOKEN,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      userName: env.GITHUB_BOT_USERNAME,
    });
    return createChatSdkBridge({ adapter: githubAdapter, concurrency: 'queue', supportsThreads: true });
  },
});
