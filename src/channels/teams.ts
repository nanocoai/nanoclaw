/**
 * Microsoft Teams channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createTeamsAdapter } from '@chat-adapter/teams';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. 'mention' (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
const TEAMS_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/**
 * The bot's own display name, from an inbound Bot Framework activity: the
 * activity's `recipient` is the bot, named as the tenant shows it. The Teams
 * adapter cannot look its own profile up, so the bridge reads it from here.
 */
export function teamsBotDisplayName(raw: Record<string, unknown>): string | undefined {
  const recipient = raw.recipient as { name?: unknown } | undefined;
  return typeof recipient?.name === 'string' && recipient.name.trim() !== '' ? recipient.name : undefined;
}

registerChannelAdapter('teams', {
  factory: () => {
    const env = readEnvFile(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_APP_TENANT_ID', 'TEAMS_APP_TYPE']);
    if (!env.TEAMS_APP_ID) return null;
    const teamsAdapter = createTeamsAdapter({
      appId: env.TEAMS_APP_ID,
      appPassword: env.TEAMS_APP_PASSWORD,
      appType: (env.TEAMS_APP_TYPE as 'SingleTenant' | 'MultiTenant') || undefined,
      appTenantId: env.TEAMS_APP_TENANT_ID || undefined,
    });
    return createChatSdkBridge({
      adapter: teamsAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: TEAMS_DEFAULTS,
      extractBotDisplayName: teamsBotDisplayName,
    });
  },
  defaults: TEAMS_DEFAULTS,
});
