import { DATA_DIR } from '../config.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { PlayboxServer } from './playbox/server.js';
import type { PlayboxInbound } from './playbox/protocol.js';

export const PLAYBOX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};

export function playboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'development' && env.NANOCLAW_PLAYBOX === 'true';
}

interface PlayboxAdapterOptions {
  port?: number;
  attachmentRoot?: string;
}

export function createPlayboxAdapter(options: PlayboxAdapterOptions = {}): ChannelAdapter & {
  server: PlayboxServer;
  accept(input: PlayboxInbound): Promise<void>;
} {
  let setup: ChannelSetup | undefined;
  let connected = false;
  const server = new PlayboxServer({
    port: options.port,
    attachmentRoot: options.attachmentRoot,
    onInbound: async (message) => {
      if (!setup) throw new Error('Playbox adapter is not set up');
      await setup.onInbound('playbox:household', null, {
        id: message.id,
        kind: 'chat',
        timestamp: message.timestamp,
        isGroup: true,
        content: {
          text: message.text,
          sender: message.senderId,
          senderName: message.senderName,
          replyToId: message.replyToId,
          attachments: message.attachments,
          fromMe: false,
          isBotMessage: false,
          isGroup: true,
          chatJid: 'playbox:household',
        },
      });
    },
  });

  return {
    name: 'playbox',
    channelType: 'playbox',
    supportsThreads: false,
    defaults: PLAYBOX_DEFAULTS,
    server,
    async setup(config) {
      setup = config;
      await server.start();
      connected = true;
      config.onMetadata('playbox:household', 'Household Expenses', true);
    },
    async teardown() {
      connected = false;
      setup = undefined;
      await server.stop();
    },
    isConnected: () => connected,
    async accept(input) {
      await server.accept(input);
    },
    async deliver(platformId, _threadId, message: OutboundMessage) {
      if (platformId !== 'playbox:household') throw new Error('Unknown playbox destination');
      const content = message.content as { text?: unknown };
      const text =
        typeof content === 'string'
          ? content
          : typeof content?.text === 'string'
            ? content.text
            : JSON.stringify(content);
      const id = `playbox-out-${crypto.randomUUID()}`;
      server.emit({
        type: 'outbound',
        id,
        text,
        files: (message.files ?? []).map((file) => ({ name: file.filename, dataBase64: file.data.toString('base64') })),
      });
      return id;
    },
    async setTyping(platformId) {
      if (platformId === 'playbox:household') server.emit({ type: 'typing', active: true });
    },
  };
}

registerChannelAdapter('playbox', {
  defaults: PLAYBOX_DEFAULTS,
  factory: () => (playboxEnabled() ? createPlayboxAdapter({ attachmentRoot: `${DATA_DIR}/attachments` }) : null),
});
