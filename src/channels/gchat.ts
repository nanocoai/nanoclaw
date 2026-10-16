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
    const env = readEnvFile(['GCHAT_CREDENTIALS', 'GOOGLE_CHAT_BOT_USER_ID', 'GOOGLE_CHAT_PROJECT_NUMBER']);
    if (!env.GCHAT_CREDENTIALS) return null;
    const gchatAdapter = createGoogleChatAdapter({
      credentials: JSON.parse(env.GCHAT_CREDENTIALS),
      // Adapters >= 4.40 no longer learn their own id from mentions; without
      // it, @mentions in spaces never count as mentions. Spread, because 4.29
      // has no botUserId option (it learns the id itself).
      ...(env.GOOGLE_CHAT_BOT_USER_ID ? { botUserId: env.GOOGLE_CHAT_BOT_USER_ID } : {}),
      // The adapter refuses to start without a webhook verifier. Its own
      // GOOGLE_CHAT_PROJECT_NUMBER fallback reads process.env, which .env
      // never reaches, so pass it.
      googleChatProjectNumber: env.GOOGLE_CHAT_PROJECT_NUMBER,
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
