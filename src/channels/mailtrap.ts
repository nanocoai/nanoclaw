/**
 * Mailtrap (email) channel adapter — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { MailtrapAdapter } from '@mailtrap/chat-sdk-adapter';
import type { AdapterPostableMessage, ChatInstance, StateAdapter } from 'chat';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelDefaults, ChannelRegistration } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Email: every conversation is effectively a DM addressed to the bot's
 * address — the group branch is inert but required by the type. 'dm-only'
 * because email has no mention metadata.
 */
const MAILTRAP_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'dm-only',
};

/** Same lifetime as the adapter's own thread state. */
const LATEST_THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Correspondents kept in memory; older ones fall back to the state copy. */
const MAX_REMEMBERED = 1000;

const latestThreadKey = (address: string) => `nanoclaw:mailtrap:latest-thread:${address}`;

/**
 * Email is non-threaded here, so the bridge sends to the platform id
 * `mailtrap:<address>`. The adapter only takes its own `mailtrap:<address>:<hash>`
 * thread ids, so a send goes to that person's latest email thread (keeping its
 * subject and In-Reply-To), or opens a new one when there is none.
 */
class MailtrapChannelAdapter extends MailtrapAdapter {
  private threadState?: StateAdapter;
  /** Latest thread per lower-cased address, set as mail arrives; state keeps a copy for restarts. */
  private readonly latestThreads = new Map<string, { threadId: string; seenAt: number }>();

  override initialize(chat: ChatInstance): Promise<void> {
    this.threadState = chat.getState();
    // Inbound thread ids reach the Chat SDK only through processMessage:
    // note each as its sender's latest thread on the way through.
    const processMessage: ChatInstance['processMessage'] = (adapter, threadId, message, options) => {
      this.rememberThread(threadId);
      return chat.processMessage(adapter, threadId, message, options);
    };
    return super.initialize(
      new Proxy(chat, {
        get: (target, prop) => {
          if (prop === 'processMessage') return processMessage;
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  }

  override async postMessage(threadId: string, message: AdapterPostableMessage) {
    return super.postMessage(await this.threadFor(threadId), message);
  }

  private async threadFor(id: string): Promise<string> {
    const [prefix, address, ...rest] = id.split(':');
    if (prefix !== 'mailtrap' || !address || rest.length > 0) return id;
    const key = address.toLowerCase();
    const cached = this.latestThreads.get(key);
    const latest =
      cached && Date.now() - cached.seenAt < LATEST_THREAD_TTL_MS
        ? cached.threadId
        : await this.threadState?.get<string>(latestThreadKey(key));
    if (latest) return latest;
    const opened = await this.openDM(address);
    this.rememberThread(opened);
    return opened;
  }

  private rememberThread(threadId: string): void {
    const [, address] = threadId.split(':');
    if (!address) return;
    const key = address.toLowerCase();
    this.latestThreads.delete(key);
    this.latestThreads.set(key, { threadId, seenAt: Date.now() });
    if (this.latestThreads.size > MAX_REMEMBERED) {
      this.latestThreads.delete(this.latestThreads.keys().next().value!);
    }
    void this.saveLatestThread(key, threadId);
  }

  /** State writes run in call order (one SQLite connection), so the copy ends on the newest thread. */
  private async saveLatestThread(key: string, threadId: string): Promise<void> {
    try {
      await this.threadState?.set(latestThreadKey(key), threadId, LATEST_THREAD_TTL_MS);
      // eslint-disable-next-line no-catch-all/no-catch-all -- best effort: only a send after a restart loses the thread
    } catch (err) {
      log.warn('Mailtrap: could not record the latest email thread', { threadId, err });
    }
  }
}

export const mailtrapRegistration: ChannelRegistration = {
  factory: () => {
    const env = readEnvFile([
      'MAILTRAP_API_TOKEN',
      'MAILTRAP_FROM_ADDRESS',
      'MAILTRAP_FROM_NAME',
      'MAILTRAP_WEBHOOK_SECRET',
    ]);
    if (!env.MAILTRAP_API_TOKEN || !env.MAILTRAP_FROM_ADDRESS) return null;
    const mailtrapAdapter = new MailtrapChannelAdapter({
      apiKey: env.MAILTRAP_API_TOKEN,
      fromAddress: env.MAILTRAP_FROM_ADDRESS,
      fromName: env.MAILTRAP_FROM_NAME,
      webhookSecret: env.MAILTRAP_WEBHOOK_SECRET,
    });
    return createChatSdkBridge({
      adapter: mailtrapAdapter,
      concurrency: 'queue',
      supportsThreads: false,
      defaults: MAILTRAP_DEFAULTS,
    });
  },
  defaults: MAILTRAP_DEFAULTS,
};

registerChannelAdapter('mailtrap', mailtrapRegistration);
