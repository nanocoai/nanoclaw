/**
 * WhatsApp Cloud API channel adapter (v2) — uses Chat SDK bridge.
 * Uses the official Meta WhatsApp Business Cloud API (not Baileys).
 * Self-registers on import.
 */
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults, ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { adoptStrandedWhatsAppCloudGroups } from './whatsapp-cloud-adoption.js';

/**
 * Dedicated business number on the official Cloud API — non-threaded, so
 * group engagement defaults to 'mention' (never sticky: one shared session
 * would stay engaged forever).
 */
const WHATSAPP_CLOUD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('whatsapp-cloud', {
  factory: () => {
    const env = readEnvFile([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_VERIFY_TOKEN',
    ]);
    if (!env.WHATSAPP_ACCESS_TOKEN) return null;
    const whatsappAdapter = createWhatsAppAdapter({
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: env.WHATSAPP_APP_SECRET,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    });
    // `@chat-adapter/whatsapp` hardcodes name = 'whatsapp', which the bridge
    // uses as channelType. Without a distinct instance the registry would key
    // this bridge under 'whatsapp' and collide with the native Baileys adapter
    // (src/channels/whatsapp.ts, also channelType 'whatsapp') — last-write-wins
    // silently kills one channel. The instance key keeps them apart while
    // channelType stays 'whatsapp' (the semantic platform key). See #2911.
    const bridge = createChatSdkBridge({
      adapter: whatsappAdapter,
      instance: 'whatsapp-cloud',
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: WHATSAPP_CLOUD_DEFAULTS,
    });
    // Adoption must run before the bridge registers webhooks, so the first
    // inbound already resolves the re-keyed rows instead of racing an
    // auto-created duplicate. The re-key targets the instance dimension
    // migration 016 added on installs; adoption checks for the instance column
    // first and no-ops on a pre-016 core.
    const bridgeSetup = bridge.setup.bind(bridge);
    return {
      ...bridge,
      async setup(hostConfig: ChannelSetup) {
        adoptStrandedWhatsAppCloudGroups();
        await bridgeSetup(hostConfig);
      },
    };
  },
  defaults: WHATSAPP_CLOUD_DEFAULTS,
});
