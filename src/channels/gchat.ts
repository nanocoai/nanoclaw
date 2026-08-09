/**
 * Google Chat channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createGoogleChatAdapter } from '@chat-adapter/gchat';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. 'mention' (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
const GCHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('gchat', {
  factory: () => {
    const env = readEnvFile(['GCHAT_CREDENTIALS']);
    if (!env.GCHAT_CREDENTIALS) return null;
    const gchatAdapter = createGoogleChatAdapter({
      credentials: JSON.parse(env.GCHAT_CREDENTIALS),
    });
    return createChatSdkBridge({
      adapter: gchatAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: GCHAT_DEFAULTS,
    });
  },
  defaults: GCHAT_DEFAULTS,
});
