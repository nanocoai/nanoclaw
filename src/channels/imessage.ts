/**
 * iMessage channel adapter (v2) — uses Chat SDK bridge.
 * Supports local mode (macOS Full Disk Access) and remote mode (Photon API).
 * Self-registers on import.
 */
import { createiMessageAdapter } from 'chat-adapter-imessage';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * The operator's personal Apple ID is a shared identity — strangers DMing it
 * reach the human, not the bot, so auto-create stays 'strict'. iMessage
 * exposes no group-mention metadata ('dm-only'); group wirings default to a
 * name-pattern trigger instead ({name} = agent group name).
 */
const IMESSAGE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '\\b{name}\\b', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

registerChannelAdapter('imessage', {
  factory: () => {
    const env = readEnvFile(['IMESSAGE_ENABLED', 'IMESSAGE_LOCAL', 'IMESSAGE_SERVER_URL', 'IMESSAGE_API_KEY']);
    const isLocal = env.IMESSAGE_LOCAL !== 'false';
    if (isLocal && !env.IMESSAGE_ENABLED) return null;
    if (!isLocal && !env.IMESSAGE_SERVER_URL) return null;
    const rawAdapter = createiMessageAdapter({
      local: isLocal,
      serverUrl: env.IMESSAGE_SERVER_URL,
      apiKey: env.IMESSAGE_API_KEY,
    });
    // Polyfill channelIdFromThreadId (community adapter doesn't implement it)
    const imessageAdapter = Object.assign(rawAdapter, {
      channelIdFromThreadId: (threadId: string) => threadId,
    });
    return createChatSdkBridge({
      adapter: imessageAdapter,
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: IMESSAGE_DEFAULTS,
    });
  },
  defaults: IMESSAGE_DEFAULTS,
});
