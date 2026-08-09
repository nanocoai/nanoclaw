/**
 * DeltaChat channel adapter.
 *
 * Bridges NanoClaw with DeltaChat via the @deltachat/stdio-rpc-server JSON-RPC
 * process. Each DeltaChat chat becomes a separate NanoClaw messaging group
 * (platformId = chatId string, e.g. "12"). No thread model — supportsThreads: false.
 *
 * Required env vars (.env): DC_EMAIL, DC_PASSWORD,
 *                           DC_IMAP_HOST, DC_IMAP_PORT,
 *                           DC_SMTP_HOST, DC_SMTP_PORT
 * Optional env vars (.env): DC_IMAP_SECURITY (default: "1" = SSL/TLS),
 *                           DC_SMTP_SECURITY (default: "2" = STARTTLS)
 *                           Security values: 1=SSL/TLS, 2=STARTTLS, 3=plain
 * Optional env vars (service unit): DC_ACCOUNT_DIR (default: "dc-account"),
 *                                   DC_DISPLAY_NAME, DC_AVATAR_PATH
 */
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';

import { getDb, hasTable } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

import { DeltaChatOverJsonRpc } from '@deltachat/stdio-rpc-server';

const REQUIRED_ENV = [
  'DC_EMAIL',
  'DC_PASSWORD',
  'DC_IMAP_HOST',
  'DC_IMAP_PORT',
  'DC_SMTP_HOST',
  'DC_SMTP_PORT',
] as const;

const OPTIONAL_ENV = ['DC_IMAP_SECURITY', 'DC_SMTP_SECURITY'] as const;

type DcEnv = { [K in (typeof REQUIRED_ENV)[number]]: string } & { [K in (typeof OPTIONAL_ENV)[number]]?: string };

function isDcAdmin(userId: string): boolean {
  try {
    const db = getDb();
    if (!hasTable(db, 'user_roles')) return true;
    return (
      db
        .prepare(
          `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND agent_group_id IS NULL
       LIMIT 1`,
        )
        .get(userId) != null
    );
  } catch {
    return false;
  }
}

function createAdapter(env: DcEnv): ChannelAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dc: any = null;
  let accountId = 0;
  let connectivity = 0;
  let lastImapIdleTs = Date.now();
  let consecutiveBadChecks = 0;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let networkTimer: ReturnType<typeof setInterval> | null = null;

  async function restartIo(reason: string): Promise<void> {
    log.warn('DeltaChat: restarting IO', { reason });
    try {
      await dc.rpc.stopIo(accountId);
      await dc.rpc.startIo(accountId);
      lastImapIdleTs = Date.now();
      consecutiveBadChecks = 0;
    } catch (err) {
      log.error('DeltaChat: IO restart failed', { err });
    }
  }

  const adapter: ChannelAdapter = {
    name: 'deltachat',
    channelType: 'deltachat',
    supportsThreads: false,
    defaults: DELTACHAT_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      const accountDir = process.env.DC_ACCOUNT_DIR ?? 'dc-account';
      dc = new DeltaChatOverJsonRpc(accountDir, {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dc.on('Error', (_: any, event: any) => log.error('DeltaChat RPC error', { msg: event.msg ?? event }));

      const accounts = await dc.rpc.getAllAccounts();
      accountId = accounts[0]?.id;
      if (!accountId) accountId = await dc.rpc.addAccount();

      const imapSecurity = env.DC_IMAP_SECURITY ?? '1';
      const smtpSecurity = env.DC_SMTP_SECURITY ?? '2';

      if (!(await dc.rpc.isConfigured(accountId))) {
        await dc.rpc.setConfig(accountId, 'addr', env.DC_EMAIL);
        await dc.rpc.setConfig(accountId, 'mail_pw', env.DC_PASSWORD);
        await dc.rpc.setConfig(accountId, 'mail_server', env.DC_IMAP_HOST);
        await dc.rpc.setConfig(accountId, 'mail_port', env.DC_IMAP_PORT);
        await dc.rpc.setConfig(accountId, 'send_server', env.DC_SMTP_HOST);
        await dc.rpc.setConfig(accountId, 'send_port', env.DC_SMTP_PORT);
        await dc.rpc.configure(accountId);
        log.info('DeltaChat: account configured', { email: env.DC_EMAIL });
      } else {
        log.info('DeltaChat: account ready', { email: env.DC_EMAIL });
      }

      await dc.rpc.setConfig(accountId, 'mail_security', imapSecurity);
      await dc.rpc.setConfig(accountId, 'send_security', smtpSecurity);
      await dc.rpc.setConfig(accountId, 'displayname', process.env.DC_DISPLAY_NAME ?? 'NanoClaw');
      const avatarPath = process.env.DC_AVATAR_PATH;
      if (avatarPath && existsSync(avatarPath)) {
        await dc.rpc.setConfig(accountId, 'selfavatar', avatarPath);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dc.on('IncomingMsg', async (contextId: number, event: any) => {
        if (contextId !== accountId) return;
        try {
          let msg = await dc.rpc.getMessage(accountId, event.msgId);
          if (msg.isInfo) return;

          // Wait for large-message download to complete
          if (msg.downloadState !== 'Done') {
            await dc.rpc.downloadFullMessage(accountId, event.msgId);
            for (let i = 0; i < 30; i++) {
              await new Promise((r) => setTimeout(r, 1000));
              msg = await dc.rpc.getMessage(accountId, event.msgId);
              if (msg.downloadState === 'Done') break;
            }
          }

          if (!msg.text && !msg.file) return;

          const contact = await dc.rpc.getContact(accountId, msg.fromId);
          const chat = await dc.rpc.getBasicChatInfo(accountId, event.chatId);

          if (/^\/set-avatar$/i.test((msg.text || '').trim()) && msg.file) {
            const userId = `deltachat:${contact.address}`;
            try {
              if (isDcAdmin(userId)) {
                const absPath = resolve(msg.file as string);
                await dc.rpc.setConfig(accountId, 'selfavatar', absPath);
                await dc.rpc.sendMsg(accountId, event.chatId, { text: 'Avatar updated.' });
              } else {
                await dc.rpc.sendMsg(accountId, event.chatId, { text: 'Permission denied.' });
              }
            } catch (avatarErr: unknown) {
              log.error('DeltaChat: failed to set avatar', {
                err: avatarErr instanceof Error ? avatarErr.message : JSON.stringify(avatarErr),
              });
              await dc.rpc.sendMsg(accountId, event.chatId, { text: 'Failed to set avatar.' }).catch(() => {});
            }
            return;
          }

          const content: Record<string, unknown> = {
            text: msg.text || '',
            sender: contact.displayName || contact.address,
            senderId: contact.address,
          };
          if (msg.file) {
            content.attachments = [
              {
                name: basename(msg.file as string),
                type: 'file',
                localPath: msg.file,
              },
            ];
          }

          const isGroup = chat?.isGroup ?? false;
          await config.onInbound(String(event.chatId), null, {
            id: String(event.msgId),
            kind: 'chat',
            content,
            timestamp: new Date().toISOString(),
            isGroup,
            isMention: !isGroup,
          });
        } catch (err: unknown) {
          log.error('DeltaChat: error handling incoming message', {
            err: err instanceof Error ? err.message : JSON.stringify(err),
          });
        }
      });

      dc.on('ImapInboxIdle', (contextId: number) => {
        if (contextId === accountId) lastImapIdleTs = Date.now();
      });

      dc.on('ConnectivityChanged', async (contextId: number) => {
        if (contextId !== accountId) return;
        try {
          connectivity = await dc.rpc.getConnectivity(accountId);
        } catch {
          /* ignore */
        }
      });

      await dc.rpc.startIo(accountId);
      try {
        connectivity = await dc.rpc.getConnectivity(accountId);
      } catch {
        /* ignore */
      }
      log.info('DeltaChat: IO started', { email: env.DC_EMAIL });

      // Log invite link on every startup so the operator can bootstrap the first contact.
      // In DeltaChat, contacts can't simply be added by email — the user must open this
      // https://i.delta.chat/ invite URL in their DeltaChat app (or scan invite-qr.svg) to initiate contact.
      try {
        // null chatId → Setup-Contact invite (not group-specific)
        const [inviteUrl, svg] = await dc.rpc.getChatSecurejoinQrCodeSvg(accountId, null);
        const accountDir = resolve(process.env.DC_ACCOUNT_DIR ?? 'dc-account');
        const svgPath = join(accountDir, 'invite-qr.svg');
        writeFileSync(svgPath, svg);
        log.info('DeltaChat: invite link — open URL in DeltaChat app or scan ' + svgPath, { url: inviteUrl });
      } catch (err: unknown) {
        log.warn('DeltaChat: could not generate invite link', {
          err: err instanceof Error ? err.message : JSON.stringify(err),
        });
      }

      // Connectivity watchdog: restart IO if IMAP goes quiet or connectivity drops
      watchdogTimer = setInterval(
        async () => {
          try {
            const conn = await dc.rpc.getConnectivity(accountId);
            connectivity = conn;
            if (conn < 3000) {
              consecutiveBadChecks++;
              if (consecutiveBadChecks >= 2) {
                await restartIo(`connectivity=${conn} for 2 consecutive checks`);
              }
            } else {
              consecutiveBadChecks = 0;
            }
            const idleAgeMin = (Date.now() - lastImapIdleTs) / 60000;
            if (idleAgeMin > 20) {
              await restartIo(`no IMAP IDLE in ${idleAgeMin.toFixed(0)}min`);
            }
          } catch (err: unknown) {
            log.warn('DeltaChat: watchdog error', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        },
        5 * 60 * 1000,
      );

      // Nudge the network stack every 10 minutes (recovers from prolonged idle)
      networkTimer = setInterval(
        async () => {
          try {
            await dc.rpc.maybeNetwork();
          } catch {
            /* ignore */
          }
        },
        10 * 60 * 1000,
      );
    },

    async teardown(): Promise<void> {
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (networkTimer) clearInterval(networkTimer);
      try {
        await dc?.rpc.stopIo(accountId);
      } catch {
        /* ignore */
      }
      try {
        dc?.close();
      } catch {
        /* ignore */
      }
    },

    isConnected(): boolean {
      // 4000 = fully connected (IMAP), 3000 = connecting; treat ≥3000 as live
      return connectivity >= 3000;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const chatId = parseInt(platformId, 10);
      if (isNaN(chatId)) {
        log.warn('DeltaChat: invalid platformId for delivery', { platformId });
        return undefined;
      }
      const content = message.content as Record<string, unknown>;
      const text = typeof content.text === 'string' ? content.text : '';

      if (message.files && message.files.length > 0) {
        const tempDir = mkdtempSync(join(tmpdir(), 'nanoclaw-dc-'));
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let firstId: any;
          for (let i = 0; i < message.files.length; i++) {
            const f = message.files[i];
            const tempPath = join(tempDir, f.filename);
            writeFileSync(tempPath, f.data);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const params: any = { file: tempPath };
            if (i === 0 && text) params.text = text;
            const sentId = await dc.rpc.sendMsg(accountId, chatId, params);
            if (i === 0) firstId = sentId;
          }
          return firstId != null ? String(firstId) : undefined;
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }

      if (!text) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sentId: any = await dc.rpc.sendMsg(accountId, chatId, { text });
      return sentId != null ? String(sentId) : undefined;
    },
  };

  return adapter;
}

/**
 * Dedicated email identity (DC_EMAIL), so request_approval is sound. Email
 * carries no mention metadata ('dm-only'; the adapter flags DMs only), so
 * group wirings default to a name-pattern trigger.
 */
const DELTACHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: {
    engageMode: 'pattern',
    engagePattern: '\\b{name}\\b',
    threads: false,
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'dm-only',
};

registerChannelAdapter('deltachat', {
  factory: () => {
    const env = readEnvFile([...REQUIRED_ENV, ...OPTIONAL_ENV]);
    if (!env.DC_EMAIL || !env.DC_PASSWORD) return null;
    return createAdapter(env as DcEnv);
  },
  defaults: DELTACHAT_DEFAULTS,
});
