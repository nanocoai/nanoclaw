import fs from 'fs';
import path from 'path';
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN, DATA_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  activeDelegations?: () => Record<string, unknown>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private activeThreadTs = new Map<string, string>();

  // Multi-workspace support: per-workspace bot tokens and bot user IDs
  private primaryBotToken: string;
  private workspaceTokens = new Map<string, string>(); // team_id → xoxb token
  private workspaceBotUserIds = new Map<string, string>(); // team_id → bot user ID
  private channelToTeam = new Map<string, string>(); // channel_id → team_id

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const allEnvVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = allEnvVars.SLACK_BOT_TOKEN;
    const appToken = allEnvVars.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.primaryBotToken = botToken;

    // Load per-workspace bot tokens (SLACK_BOT_TOKEN_{team_id} in .env)
    this.loadWorkspaceTokens();

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private loadWorkspaceTokens(): void {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return;
      const content = fs.readFileSync(envPath, 'utf-8');
      const pattern = /^SLACK_BOT_TOKEN_(T[A-Z0-9]+)=(.+)$/gm;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const teamId = match[1];
        const token = match[2].trim();
        if (token) {
          this.workspaceTokens.set(teamId, token);
          logger.info({ teamId }, 'Loaded workspace bot token');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load workspace tokens');
    }
  }

  /**
   * Get the correct bot token for a channel. Falls back to primary token.
   */
  private getTokenForChannel(channelId: string): string {
    const teamId = this.channelToTeam.get(channelId);
    if (teamId) {
      const wsToken = this.workspaceTokens.get(teamId);
      if (wsToken) return wsToken;
    }
    return this.primaryBotToken;
  }

  /**
   * Check if a message is from any of our bot user IDs (across workspaces).
   */
  private isBotUser(userId: string): boolean {
    if (userId === this.botUserId) return true;
    for (const botId of this.workspaceBotUserIds.values()) {
      if (userId === botId) return true;
    }
    return false;
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event, body }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      // Accept: no subtype (regular message), bot_message (own output tracking),
      // and file_share (messages with image/file uploads)
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Track workspace for multi-workspace token routing
      // team_id is in the event envelope (body), not the event payload
      const teamId = (body as any).team_id as string | undefined;
      if (teamId && msg.channel) {
        this.channelToTeam.set(msg.channel, teamId);
        logger.debug({ channel: msg.channel, teamId }, 'Mapped channel to workspace');
      }

      // Track thread context for in-thread replies — persist to disk so it survives restarts
      const threadTs = (msg as any).thread_ts as string | undefined;
      if (threadTs) {
        this.activeThreadTs.set(jid, threadTs);
        try {
          const threadFile = path.join(DATA_DIR, 'thread-ts.json');
          let threads: Record<string, string> = {};
          if (fs.existsSync(threadFile)) {
            threads = JSON.parse(fs.readFileSync(threadFile, 'utf-8'));
          }
          threads[jid] = threadTs;
          fs.writeFileSync(threadFile, JSON.stringify(threads));
        } catch {}
      }

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered or delegated groups
      const groups = this.opts.registeredGroups();
      const delegations = this.opts.activeDelegations?.() ?? {};
      if (!groups[jid] && !delegations[jid]) return;

      const isBotMessage = !!msg.bot_id || (msg.user ? this.isBotUser(msg.user) : false);

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
      // Check all bot user IDs (primary + per-workspace) for mention detection.
      let content = msg.text;
      if (!isBotMessage) {
        const allBotIds = [this.botUserId, ...this.workspaceBotUserIds.values()].filter(Boolean);
        const mentioned = allBotIds.some(id => content.includes(`<@${id}>`));
        if (mentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // If this is a threaded reply, fetch the parent message so the agent
      // sees the original alert/error that started the thread.
      let enrichedContent = content;
      if (threadTs && threadTs !== msg.ts && !isBotMessage) {
        try {
          const parentResult = await this.app.client.conversations.history({
            channel: msg.channel,
            latest: threadTs,
            limit: 1,
            inclusive: true,
          });
          const parentMsg = parentResult.messages?.[0];
          let parentText = parentMsg?.text || '';
          // AlertManager messages have empty text with content in attachments
          if (!parentText && (parentMsg as any)?.attachments) {
            const attachments = (parentMsg as any).attachments as any[];
            const parts: string[] = [];
            for (const a of attachments) {
              if (a.fallback) parts.push(a.fallback);
              else if (a.text) parts.push(a.text);
            }
            parentText = parts.join(' ');
          }
          if (parentText) {
            enrichedContent = content + '\n\n[Thread context - original alert message to investigate]:\n' + parentText;
          }
        } catch (err) {
          logger.debug({ err }, 'Failed to fetch thread parent message');
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content: enrichedContent,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
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

    // Resolve bot user IDs for additional workspaces (best-effort, non-blocking)
    for (const [teamId, wsToken] of this.workspaceTokens) {
      try {
        const wsAuth = await this.app.client.auth.test({ token: wsToken });
        const wsBotId = wsAuth.user_id as string;
        this.workspaceBotUserIds.set(teamId, wsBotId);
        logger.info({ teamId, botUserId: wsBotId }, 'Workspace bot user ID resolved');
      } catch (err) {
        logger.warn({ teamId, err }, 'Failed to resolve workspace bot user ID');
      }
    }

    this.connected = true;

    // Restore persisted thread_ts from disk
    try {
      const threadFile = path.join(DATA_DIR, 'thread-ts.json');
      if (fs.existsSync(threadFile)) {
        const threads = JSON.parse(fs.readFileSync(threadFile, 'utf-8'));
        for (const [jid, ts] of Object.entries(threads)) {
          this.activeThreadTs.set(jid, ts as string);
        }
        logger.info({ count: this.activeThreadTs.size }, 'Restored thread context from disk');
      }
    } catch {}

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup (non-blocking — can take minutes on large workspaces)
    this.syncChannelMetadata().catch(err =>
      logger.error({ err }, 'Channel metadata sync error'),
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      const threadTs = this.activeThreadTs.get(jid);
      // Use per-workspace token if available (for multi-workspace support)
      const token = this.getTokenForChannel(channelId);
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          token,
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            token,
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
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
        const threadTs = this.activeThreadTs.get(item.jid);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
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
