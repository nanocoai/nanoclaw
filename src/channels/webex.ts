/**
 * Webex channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createWebexAdapter } from '@bitbasti/chat-adapter-webex';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. 'mention' (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
const WEBEX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('webex', {
  factory: () => {
    const env = readEnvFile(['WEBEX_BOT_TOKEN', 'WEBEX_WEBHOOK_SECRET']);
    if (!env.WEBEX_BOT_TOKEN) return null;
    const webexAdapter = createWebexAdapter({
      botToken: env.WEBEX_BOT_TOKEN,
      webhookSecret: env.WEBEX_WEBHOOK_SECRET,
    });
    return createChatSdkBridge({
      adapter: webexAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: WEBEX_DEFAULTS,
    });
  },
  defaults: WEBEX_DEFAULTS,
});
