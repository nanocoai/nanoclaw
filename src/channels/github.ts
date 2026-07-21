/**
 * GitHub channel adapter (v2) — uses Chat SDK bridge.
 * PR comment threads as conversations.
 * Self-registers on import.
 */
import { createGitHubAdapter } from '@chat-adapter/github';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot identity. group threads:true — every issue/PR comment thread
 * is its own conversation and session (the long-standing GitHub behavior,
 * now declared instead of forced by supportsThreads alone).
 */
const GITHUB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('github', {
  factory: () => {
    const env = readEnvFile(['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_BOT_USERNAME']);
    if (!env.GITHUB_TOKEN) return null;
    const githubAdapter = createGitHubAdapter({
      token: env.GITHUB_TOKEN,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      userName: env.GITHUB_BOT_USERNAME,
    });
    return createChatSdkBridge({
      adapter: githubAdapter,
      concurrency: 'queue',
      supportsThreads: true,
      defaults: GITHUB_DEFAULTS,
    });
  },
  defaults: GITHUB_DEFAULTS,
});
