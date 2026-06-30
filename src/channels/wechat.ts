/**
 * WeChat channel adapter — uses Tencent's official iLink Bot API.
 *
 * Unlike puppet-based libraries (wechaty/PadLocal) this uses the first-party
 * Tencent API. No ban risk. Free. Works with any personal WeChat account.
 *
 * Flow:
 *   1. Factory gated on WECHAT_ENABLED=true in .env.
 *   2. On setup, load saved auth if present; otherwise run QR login.
 *      The QR URL is written to data/wechat/qr.txt and logged.
 *   3. Long-poll for messages via WeChatClient, cursor persisted between
 *      restarts so no messages are dropped.
 *   4. Outbound via sendText — context_token auto-cached by the client.
 *
 * Self-registers on import.
 */
import fs from 'fs';
import path from 'path';

import { WeChatClient, MessageType, type WeixinMessage } from 'wechat-ilink-client';

import { readEnvFile } from '../env.js';
import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const DATA_SUBDIR = path.join(DATA_DIR, 'wechat');
const AUTH_FILE = path.join(DATA_SUBDIR, 'auth.json');
const SYNC_BUF_FILE = path.join(DATA_SUBDIR, 'sync-buf.txt');
const QR_FILE = path.join(DATA_SUBDIR, 'qr.txt');

interface SavedAuth {
  botToken: string;
  accountId: string;
  baseUrl?: string;
  /** The WeChat user_id of whoever scanned the QR — i.e. the operator. */
  operatorUserId?: string;
}

function loadAuth(): SavedAuth | null {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as SavedAuth;
  } catch {
    return null;
  }
}

function saveAuth(auth: SavedAuth): void {
  fs.mkdirSync(DATA_SUBDIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

function loadSyncBuf(): string | undefined {
  try {
    return fs.readFileSync(SYNC_BUF_FILE, 'utf8');
  } catch {
    return undefined;
  }
}

function saveSyncBuf(buf: string): void {
  fs.mkdirSync(DATA_SUBDIR, { recursive: true });
  fs.writeFileSync(SYNC_BUF_FILE, buf);
}

function writeQr(url: string): void {
  fs.mkdirSync(DATA_SUBDIR, { recursive: true });
  fs.writeFileSync(QR_FILE, url);
}

function messageText(msg: OutboundMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  const c = msg.content as Record<string, unknown>;
  return (c.text as string) || (c.markdown as string) || JSON.stringify(msg.content);
}

registerChannelAdapter('wechat', {
  factory: () => {
    const env = readEnvFile(['WECHAT_ENABLED']);
    if (env.WECHAT_ENABLED !== 'true') return null;

    let client: WeChatClient | null = null;
    let setupConfig: ChannelSetup;
    let connected = false;
    let accountId: string | undefined;

    async function ensureLoggedIn(): Promise<WeChatClient> {
      const saved = loadAuth();
      if (saved) {
        const c = new WeChatClient({
          token: saved.botToken,
          baseUrl: saved.baseUrl,
          accountId: saved.accountId,
        });
        accountId = saved.accountId;
        log.info('WeChat: resumed from saved auth', { accountId });
        return c;
      }

      const c = new WeChatClient();
      const result = await c.login({
        onQRCode: (url) => {
          writeQr(url);
          log.info('WeChat QR ready — open this URL in a browser and scan with the WeChat app', { url });
        },
      });
      if (!result.connected || !result.botToken || !result.accountId) {
        throw new Error(`WeChat login failed: ${result.message}`);
      }
      saveAuth({
        botToken: result.botToken,
        accountId: result.accountId,
        baseUrl: result.baseUrl,
        operatorUserId: result.userId,
      });
      accountId = result.accountId;
      log.info('WeChat: login complete', { accountId, operatorUserId: result.userId });
      return c;
    }

    function onMessage(msg: WeixinMessage): void {
      if (msg.message_type !== MessageType.USER) return;

      const isGroup = !!msg.group_id;
      const platformIdRaw = isGroup ? msg.group_id! : msg.from_user_id!;
      const platformId = `wechat:${platformIdRaw}`;
      const senderId = `wechat:${msg.from_user_id ?? 'unknown'}`;
      const text = WeChatClient.extractText(msg);

      log.info('WeChat inbound', {
        platformId,
        senderId,
        isGroup,
        hint: 'if not wired yet, run: pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts',
      });

      setupConfig.onMetadata(platformId, undefined, isGroup);

      const inbound: InboundMessage = {
        id: String(msg.message_id ?? msg.seq ?? Date.now()),
        kind: 'chat',
        content: {
          text,
          senderId,
          sender: msg.from_user_id,
          senderName: msg.from_user_id,
          isGroup,
        },
        timestamp: new Date(msg.create_time_ms ?? Date.now()).toISOString(),
      };

      setupConfig.onInbound(platformId, null, inbound);
    }

    const adapter: ChannelAdapter = {
      name: 'wechat',
      channelType: 'wechat',
      supportsThreads: false,

      async setup(config: ChannelSetup) {
        setupConfig = config;

        client = await ensureLoggedIn();

        client.on('message', (msg) => {
          try {
            onMessage(msg);
          } catch (err) {
            log.warn('WeChat: onMessage error', { err });
          }
        });
        client.on('error', (err) => log.warn('WeChat: poll error', { err }));
        client.on('sessionExpired', () => {
          log.error('WeChat: session expired — delete data/wechat/auth.json and restart to re-scan');
          connected = false;
        });

        client
          .start({
            loadSyncBuf,
            saveSyncBuf,
          })
          .catch((err) => log.error('WeChat: monitor loop crashed', { err }));

        connected = true;
        log.info('WeChat adapter ready', { accountId });
      },

      async teardown() {
        connected = false;
        client?.stop();
        client = null;
      },

      isConnected() {
        return connected;
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        if (!client) return undefined;
        const to = platformId.replace(/^wechat:/, '');
        const text = messageText(message);
        if (!text) return undefined;
        try {
          const msgId = await client.sendText(to, text);
          return msgId;
        } catch (err) {
          log.error('WeChat deliver failed', { platformId, err });
          return undefined;
        }
      },
    };

    return adapter;
  },
});
