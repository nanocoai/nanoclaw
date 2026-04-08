import fs from 'fs';
import path from 'path';

import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Download a Discord CDN attachment to a local path.
 * Returns true on success, false if skipped (too large) or failed.
 */
async function downloadAttachment(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'Attachment download failed');
      return false;
    }
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_ATTACHMENT_SIZE) {
      logger.warn({ url, size: contentLength }, 'Attachment too large, skipping download');
      return false;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_ATTACHMENT_SIZE) {
      logger.warn({ url, size: buffer.byteLength }, 'Attachment too large after download, discarding');
      return false;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch (err) {
    logger.warn({ url, err }, 'Attachment download error');
    return false;
  }
}

/**
 * Sanitize a filename to prevent path traversal.
 */
function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._\-가-힣]/g, '_').slice(0, 200) || 'file';
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> =
    new Map();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Handle attachments — download from Discord CDN into group folder
      if (message.attachments.size > 0) {
        const attachmentsDir = path.join(GROUPS_DIR, group.folder, 'attachments');
        const attachmentDescriptions: string[] = [];

        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          const rawName = att.name || 'file';
          const safeFilename = `${message.id}_${sanitizeFilename(rawName)}`;
          const destPath = path.join(attachmentsDir, safeFilename);
          const containerPath = `/workspace/group/attachments/${safeFilename}`;

          const downloaded = att.url
            ? await downloadAttachment(att.url, destPath)
            : false;

          if (downloaded) {
            if (contentType.startsWith('image/')) {
              attachmentDescriptions.push(`[Image: ${rawName} — saved to ${containerPath}]`);
            } else {
              attachmentDescriptions.push(`[File: ${rawName} — saved to ${containerPath}]`);
            }
            logger.info({ file: safeFilename, group: group.folder }, 'Attachment saved');
          } else {
            // Fallback to placeholder if download failed
            if (contentType.startsWith('image/')) {
              attachmentDescriptions.push(`[Image: ${rawName}]`);
            } else if (contentType.startsWith('video/')) {
              attachmentDescriptions.push(`[Video: ${rawName}]`);
            } else if (contentType.startsWith('audio/')) {
              attachmentDescriptions.push(`[Audio: ${rawName}]`);
            } else {
              attachmentDescriptions.push(`[File: ${rawName}]`);
            }
          }
        }

        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      const loginTimeout = setTimeout(() => {
        reject(new Error('Discord login timed out after 30s'));
      }, 30_000);

      this.client!.once(Events.ClientReady, (readyClient) => {
        clearTimeout(loginTimeout);
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken).catch((err) => {
        clearTimeout(loginTimeout);
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed.
      // Split on newline boundaries to avoid breaking multi-byte characters or markdown.
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        let remaining = text;
        while (remaining.length > 0) {
          if (remaining.length <= MAX_LENGTH) {
            await textChannel.send(remaining);
            break;
          }
          // Find the last newline within the limit
          let splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
          if (splitAt <= 0) {
            // No newline found — find the last space
            splitAt = remaining.lastIndexOf(' ', MAX_LENGTH);
          }
          if (splitAt <= 0) {
            // No good break point — hard split at limit
            splitAt = MAX_LENGTH;
          }
          await textChannel.send(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).replace(/^\n/, '');
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals before destroying the client
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const sendTyping = async () => {
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    await sendTyping();
    this.typingIntervals.set(jid, setInterval(sendTyping, 8000));
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
