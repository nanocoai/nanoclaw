import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { processImageBuffer, isSupportedImageMime } from '../image.js';
import { logger } from '../logger.js';
import {
  MAX_VIDEO_BYTES,
  inboxFilename,
  isSupportedVideoMime,
  materializeAttachment,
} from '../media.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  ImageAttachment,
  VideoAttachment,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Human-friendly byte size for the inbox marker block. Two-decimal precision
// keeps small files distinguishable (8.2 KB vs 8.5 KB) without overstating
// precision on large ones.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<
    | { kind: 'text'; jid: string; text: string }
    | {
        kind: 'image';
        jid: string;
        imagePaths: string[];
        caption?: string;
      }
    | {
        kind: 'video';
        jid: string;
        videoPaths: string[];
        caption?: string;
      }
  > = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private botToken: string;

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text && !(msg as { files?: unknown[] }).files?.length) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage && content) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Process file attachments. Slack delivers files[] on the message event;
      // each supported file (image or video) is downloaded via url_private_download
      // (requires the bot token as bearer auth), materialized to the per-group
      // inbox/ directory (so Veo scripts can read it by path), and listed in a
      // trailing marker block appended to the message content so the agent can
      // find the paths in its prompt context.
      const files =
        (
          msg as {
            files?: Array<{
              id?: string;
              mimetype?: string;
              url_private_download?: string;
              name?: string;
            }>;
          }
        ).files ?? [];
      const images: ImageAttachment[] = [];
      const videos: VideoAttachment[] = [];
      const markerEntries: Array<{
        path: string;
        mime: string;
        sizeBytes: number;
      }> = [];
      let oversizeSkipCount = 0;
      const groupFolder = groups[jid].folder;
      const msgTimestamp = new Date(parseFloat(msg.ts) * 1000);

      for (const file of files) {
        const mime = file.mimetype;
        if (
          !mime ||
          (!isSupportedImageMime(mime) && !isSupportedVideoMime(mime))
        ) {
          // Surface at warn level so silent file drops are visible in
          // info-level logs. The agent sees zero attachments when this fires;
          // without the log, that looks indistinguishable from "user
          // attached nothing", which is impossible to debug after the fact.
          logger.warn(
            { fileId: file.id, fileName: file.name, mime },
            mime
              ? 'Slack attachment skipped: unsupported MIME type'
              : 'Slack attachment skipped: no MIME type reported',
          );
          continue;
        }
        if (!file.url_private_download || !file.id) continue;

        const isVideo = isSupportedVideoMime(mime);

        // Synthesize the inbox filename from sanitized inputs (timestamp +
        // Slack file ID + MIME-derived extension). inboxFilename throws on a
        // file ID that doesn't match Slack's uppercase-alphanumeric shape,
        // which closes the path-injection vector before any fetch happens.
        let relName: string;
        try {
          relName = inboxFilename({
            timestamp: msgTimestamp,
            fileId: file.id,
            mime,
          });
        } catch (err) {
          logger.warn(
            { fileId: file.id, mime, err },
            'Slack attachment skipped: invalid file ID',
          );
          continue;
        }

        try {
          const res = await fetch(file.url_private_download, {
            headers: { Authorization: `Bearer ${this.botToken}` },
          });
          if (!res.ok) {
            logger.warn(
              { fileId: file.id, status: res.status },
              'Slack attachment fetch failed',
            );
            continue;
          }

          // Pre-buffer Content-Length check for videos so we don't pay the
          // download cost when Slack already tells us the file is over cap.
          if (isVideo) {
            const cl = res.headers.get('content-length');
            if (cl && Number(cl) > MAX_VIDEO_BYTES) {
              logger.warn(
                { fileId: file.id, contentLength: cl, max: MAX_VIDEO_BYTES },
                'Slack video skipped: exceeds size cap (Content-Length)',
              );
              oversizeSkipCount++;
              continue;
            }
          }

          const buf = Buffer.from(await res.arrayBuffer());

          if (isVideo) {
            // Belt-and-suspenders for when Content-Length is missing or lying.
            if (buf.byteLength > MAX_VIDEO_BYTES) {
              logger.warn(
                {
                  fileId: file.id,
                  bytes: buf.byteLength,
                  max: MAX_VIDEO_BYTES,
                },
                'Slack video skipped: exceeds size cap (buffer)',
              );
              oversizeSkipCount++;
              continue;
            }

            const relPath = await materializeAttachment({
              bytes: buf,
              relName,
              groupFolder,
              groupsRoot: GROUPS_DIR,
            });
            videos.push({
              mediaType: mime as VideoAttachment['mediaType'],
              path: relPath,
              sizeBytes: buf.byteLength,
            });
            markerEntries.push({
              path: relPath,
              mime,
              sizeBytes: buf.byteLength,
            });
          } else {
            // Image branch: keep the existing base64 pipeline for the SDK
            // content block AND materialize the resized JPEG to disk so Veo
            // scripts can use it as a -i reference.
            const att = await processImageBuffer(buf, mime);
            if (!att) continue;
            try {
              const jpegBytes = Buffer.from(att.data, 'base64');
              const relPath = await materializeAttachment({
                bytes: jpegBytes,
                relName,
                groupFolder,
                groupsRoot: GROUPS_DIR,
              });
              images.push({ ...att, path: relPath });
              markerEntries.push({
                path: relPath,
                mime: att.mediaType,
                sizeBytes: jpegBytes.byteLength,
              });
            } catch (err) {
              // Disk write failed but the inline base64 still works for the
              // model — push the image without a path rather than dropping it.
              logger.warn(
                { fileId: file.id, err },
                'Slack image materialization failed, delivering inline only',
              );
              images.push(att);
            }
          }
        } catch (err) {
          logger.warn(
            { fileId: file.id, err },
            'Slack attachment processing error',
          );
        }
      }

      // Build the trailing marker block (if any media materialized or any
      // oversize skip happened) so the agent can see the inbox paths in the
      // prompt and call generate_video.py -i / extract_frame.py --input.
      const markerLines: string[] = [];
      if (markerEntries.length) {
        markerLines.push('[Attached files in inbox/:]');
        for (const entry of markerEntries) {
          markerLines.push(
            `- ${entry.path} (${entry.mime}, ${formatBytes(entry.sizeBytes)})`,
          );
        }
      }
      if (oversizeSkipCount) {
        markerLines.push(
          `[${oversizeSkipCount} attachment${
            oversizeSkipCount === 1 ? '' : 's'
          } skipped: too large (limit 100 MB)]`,
        );
      }

      let finalContent = content ?? '';
      if (markerLines.length) {
        const marker = markerLines.join('\n');
        finalContent = finalContent ? `${finalContent}\n\n${marker}` : marker;
      }

      // Drop silently when there is genuinely nothing for the agent to see:
      // no text, no successfully materialized media, and no oversize notice.
      if (
        !msg.text &&
        images.length === 0 &&
        videos.length === 0 &&
        oversizeSkipCount === 0
      ) {
        return;
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content: finalContent,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        images: images.length ? images : undefined,
        videos: videos.length ? videos : undefined,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'text', jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'text', jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async sendImage(
    jid: string,
    imagePaths: string[],
    caption?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
      logger.info(
        { jid, count: imagePaths.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, image queued',
      );
      return;
    }
    try {
      await this.app.client.files.uploadV2({
        channel_id: channelId,
        initial_comment: caption,
        file_uploads: imagePaths.map((p) => ({
          file: fs.createReadStream(p),
          filename: path.basename(p),
        })),
      });
      logger.info({ jid, count: imagePaths.length }, 'Slack image(s) sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack image, queued',
      );
    }
  }

  async sendVideo(
    jid: string,
    videoPaths: string[],
    caption?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'video', jid, videoPaths, caption });
      logger.info(
        { jid, count: videoPaths.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, video queued',
      );
      return;
    }
    // files.uploadV2 auto-detects video mime types from filename; the same
    // call shape works for both images and videos.
    try {
      await this.app.client.files.uploadV2({
        channel_id: channelId,
        initial_comment: caption,
        file_uploads: videoPaths.map((p) => ({
          file: fs.createReadStream(p),
          filename: path.basename(p),
        })),
      });
      logger.info({ jid, count: videoPaths.length }, 'Slack video(s) sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'video', jid, videoPaths, caption });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack video, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        if (item.kind === 'text') {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: item.text,
          });
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued Slack text sent',
          );
        } else if (item.kind === 'image') {
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            initial_comment: item.caption,
            file_uploads: item.imagePaths.map((p) => ({
              file: fs.createReadStream(p),
              filename: path.basename(p),
            })),
          });
          logger.info(
            { jid: item.jid, count: item.imagePaths.length },
            'Queued Slack image(s) sent',
          );
        } else if (item.kind === 'video') {
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            initial_comment: item.caption,
            file_uploads: item.videoPaths.map((p) => ({
              file: fs.createReadStream(p),
              filename: path.basename(p),
            })),
          });
          logger.info(
            { jid: item.jid, count: item.videoPaths.length },
            'Queued Slack video(s) sent',
          );
        } else {
          // Exhaustiveness check — adding a new kind to outgoingQueue will trip
          // this at compile time before it can silently misroute at runtime.
          const _exhaustive: never = item;
          void _exhaustive;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
