/**
 * Linear channel adapter (v2) — uses Chat SDK bridge.
 * Issue comment threads as conversations.
 * Self-registers on import.
 *
 * Linear OAuth apps can't be @-mentioned, so this adapter relies on the
 * bridge's default onNewMessage catch-all to forward every comment.
 */
import { createLinearAdapter } from '@chat-adapter/linear';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Linear OAuth apps can't be @-mentioned (see module doc), so mention modes
 * can never fire — creation surfaces must refuse them ('never'). Group
 * wirings default to pattern '.' (every comment engages) with per-issue
 * threads. Auto-create can't fire without isMention, so unknownSenderPolicy
 * is declared for uniformity only.
 */
const LINEAR_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'never',
};

registerChannelAdapter('linear', {
  factory: () => {
    const env = readEnvFile([
      'LINEAR_API_KEY',
      'LINEAR_CLIENT_ID',
      'LINEAR_CLIENT_SECRET',
      'LINEAR_WEBHOOK_SECRET',
      'LINEAR_BOT_USERNAME',
      'LINEAR_TEAM_KEY',
    ]);
    if (!env.LINEAR_API_KEY && !env.LINEAR_CLIENT_ID) return null;

    const auth = env.LINEAR_CLIENT_ID
      ? { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET }
      : { apiKey: env.LINEAR_API_KEY };

    const linearAdapter = createLinearAdapter({
      ...auth,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET,
      userName: env.LINEAR_BOT_USERNAME,
    });

    // Override channelIdFromThreadId to return a team-based channel ID.
    // The upstream adapter returns per-issue UUIDs which creates a new
    // messaging group for every issue. We want one group per team.
    const teamKey = env.LINEAR_TEAM_KEY || 'default';
    linearAdapter.channelIdFromThreadId = () => `linear:${teamKey}`;

    return createChatSdkBridge({
      adapter: linearAdapter,
      concurrency: 'queue',
      supportsThreads: true,
      defaults: LINEAR_DEFAULTS,
    });
  },
  defaults: LINEAR_DEFAULTS,
});
