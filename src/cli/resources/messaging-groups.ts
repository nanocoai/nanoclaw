import { randomUUID } from 'crypto';

import { resolveUnknownSenderPolicy } from '../../channels/channel-defaults.js';
import { hasDeclaredChannelDefaults } from '../../channels/channel-registry.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'messaging-group',
  plural: 'messaging-groups',
  table: 'messaging_groups',
  description:
    'Messaging group — one chat or channel on one platform (a Telegram DM, a Discord channel, a Slack thread root, an email address). Identity is the (channel_type, platform_id, instance) triple, which must be unique.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'channel_type',
      type: 'string',
      description:
        'Channel adapter type — matches the adapter registered by /add-<channel> (e.g. telegram, discord, slack, whatsapp).',
      required: true,
    },
    {
      name: 'platform_id',
      type: 'string',
      description:
        'Platform-specific chat ID. Format varies: Telegram chat ID, Discord channel snowflake, Slack channel ID, phone number, email address.',
      required: true,
    },
    {
      name: 'instance',
      type: 'string',
      description:
        'Adapter instance that owns this chat, when running N adapters of one channel type. Defaults to channel_type (the default instance) when omitted.',
      defaultFrom: 'channel_type',
      updatable: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Display name. Often auto-populated by the channel adapter.',
      updatable: true,
    },
    {
      name: 'is_group',
      type: 'number',
      description: 'Multi-user group chat (1) or direct message (0). Affects session scoping.',
      default: 0,
      updatable: true,
    },
    {
      name: 'unknown_sender_policy',
      type: 'string',
      description:
        'What happens when an unrecognized sender posts. "strict" drops silently. "request_approval" sends an approval card to an admin. "public" allows anyone. Default: declared by the channel adapter for this context (DM vs group); "strict" when the channel has no declaration.',
      enum: ['strict', 'request_approval', 'public'],
      default: 'strict',
      updatable: true,
    },
    {
      name: 'denied_at',
      type: 'string',
      description:
        'Set when the owner explicitly denies registering this channel. While set, the router drops all messages silently without re-escalating. Cleared by any explicit wiring mutation.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // Idempotent create: a skill re-running `ncl messaging-groups create` gets the existing row back.
  naturalKey: ['channel_type', 'platform_id', 'instance'],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  resolveDefaults: (values) => {
    if (values.unknown_sender_policy !== undefined) return;
    const channelType = String(values.channel_type);
    const channelKey = (values.instance as string | undefined) ?? channelType;
    // Static 'strict' stays the no-declaration fallback: a trunk update alone
    // must not change ncl's creation defaults for stale (undeclared) adapters.
    if (!hasDeclaredChannelDefaults(channelKey, channelType)) {
      log.warn(
        `messaging-group create: channel '${channelKey}' has no declared defaults (adapter not installed or stale) — using legacy static defaults`,
      );
      return;
    }
    // is_group carries its static default (0) only after this hook runs, so
    // treat "not provided" as the same DM context the static default means.
    const isGroup = Number(values.is_group ?? 0) === 1;
    values.unknown_sender_policy = resolveUnknownSenderPolicy(channelKey, isGroup, channelType);
  },
  customOperations: {
    send: {
      access: 'approval',
      description:
        'Inject a message into a messaging group as if a sender posted it, waking the wired agent — used to send a welcome on first wire. Use --channel-type, --platform-id, --text, optionally --instance, --sender-id, --sender.',
      handler: async (args) => {
        const channelType = args.channel_type as string;
        const platformId = args.platform_id as string;
        const text = args.text as string;
        if (!channelType || !platformId || !text) {
          throw new Error('--channel-type, --platform-id and --text are required');
        }
        const instance = (args.instance as string) ?? channelType;
        const mg = getMessagingGroupByPlatform(channelType, platformId, instance);
        if (!mg) {
          throw new Error(`no messaging group for ${channelType} ${platformId} — create + wire it first`);
        }
        // Build the same InboundEvent the CLI admin transport (src/channels/cli.ts)
        // emits for a routed message, and route it in-process. The sender id should
        // be a wired user (e.g. the owner just granted) so the access gate passes.
        await routeInbound({
          channelType,
          instance,
          platformId,
          threadId: platformId,
          message: {
            id: `send-${randomUUID()}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            content: JSON.stringify({
              text,
              sender: (args.sender as string) ?? 'cli',
              senderId: (args.sender_id as string) ?? 'cli:local',
            }),
          },
        });
        return { sent: { channel_type: channelType, platform_id: platformId } };
      },
    },
  },
});
