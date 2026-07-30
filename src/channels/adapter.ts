/**
 * v2 Channel Adapter interface.
 *
 * Channel adapters bridge NanoClaw with messaging platforms (Discord, Slack, etc.).
 * Two patterns: native adapters (implement directly) or Chat SDK bridge (wrap a Chat SDK adapter).
 */

/** Passed to the adapter at setup time. */
export interface ChannelSetup {
  /** Called when an inbound message arrives from the platform. */
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;

  /**
   * Called by admin-transport adapters (CLI) that want to route a message to
   * an arbitrary channel/platform and optionally redirect replies elsewhere.
   * Regular chat adapters should use `onInbound`; `onInboundEvent` skips the
   * adapter-channel-type injection so the caller can target any wired mg.
   */
  onInboundEvent(event: InboundEvent): void | Promise<void>;

  /** Called when the adapter discovers metadata about a conversation. */
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;

  /** Called when a user clicks a button/action in a card (e.g., ask_user_question response). */
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

/** Delivery address used for reply-to overrides and (normally) the inbound's own origin. */
export interface DeliveryAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * Full inbound event handed to the router.
 *
 * `channelType` + `platformId` + `threadId` identify which messaging group /
 * session receives the message. `replyTo`, when set, overrides where the
 * agent's reply is delivered — used by the CLI admin transport when the
 * operator wants a message routed to one channel but replies echoed back to
 * their terminal. Agents cannot set `replyTo`; it is a router-layer concept
 * set only by external adapters carrying operator intent.
 */
export interface InboundEvent {
  channelType: string;
  /** Receiving adapter instance; stamped host-side (src/index.ts onInbound).
   *  Absent (e.g. CLI onInboundEvent) means the default instance (= channelType). */
  instance?: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk';
    content: string; // JSON blob
    timestamp: string;
    /**
     * Platform-confirmed bot-mention signal forwarded from the adapter.
     * See InboundMessage.isMention for the full explanation.
     */
    isMention?: boolean;
    /** True when the source is a group/channel thread, false for DMs. */
    isGroup?: boolean;
  };
  replyTo?: DeliveryAddress;
}

/** Inbound message from adapter to host. */
export interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown; // JS object — host will JSON.stringify before writing to session DB
  timestamp: string;
  /**
   * Platform-confirmed signal that this message is a mention of the bot.
   *
   * Set by adapters that know the platform's own mention semantics — e.g.
   * the Chat SDK bridge sets it true from `onNewMention` / `onDirectMessage`
   * and forwards `message.isMention` from `onSubscribedMessage`. Use this
   * in the router instead of agent-name regex matching, which breaks on
   * platforms where the mention text is the bot's platform username (e.g.
   * Telegram's `@nanoclaw_v2_refactr_1_bot`) rather than the agent_group
   * display name (e.g. `@Andy`).
   *
   * Adapters that don't set it (native / legacy) leave it undefined — the
   * router treats undefined as "not a mention" (`isMention === true` check,
   * src/router.ts). There is no text-match fallback.
   */
  isMention?: boolean;
  /** True when the source is a group/channel thread, false for DMs. */
  isGroup?: boolean;
}

/** A file attachment to deliver alongside a message. */
export interface OutboundFile {
  filename: string;
  data: Buffer;
}

/** Outbound message from host to adapter. */
export interface OutboundMessage {
  kind: string;
  content: unknown; // parsed JSON from messages_out
  files?: OutboundFile[]; // file attachments from the session outbox
}

/** Discovered conversation info (from syncConversations). */
export interface ConversationInfo {
  platformId: string;
  name: string;
  isGroup: boolean;
}

/** Wiring/mg defaults for one conversation context (DM vs group/channel). */
export interface ChannelContextDefaults {
  /** Default engage_mode for wirings created in this context. */
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  /**
   * Default engage_pattern when engageMode === 'pattern'. May contain the
   * literal token `{name}`: creation helpers replace it with the regex-escaped
   * agent_group name (for platforms with no group-mention metadata, e.g.
   * iMessage/DeltaChat groups, WhatsApp shared-number mode). Required iff
   * engageMode === 'pattern'.
   */
  engagePattern?: string;
  /**
   * Whether thread ids are honored in this context by default.
   *  true  — inbound thread ids flow into messages_in and (in groups) force
   *          per-thread session identity; replies, typing, and cards land
   *          in-thread.
   *  false — thread ids are nulled per-wiring at router fanout; sessions
   *          collapse; replies land top-level.
   * MUST be false when `supportsThreads` is false (capability bound; the
   * router treats supportsThreads=false as a hard pre-strip regardless).
   * Per-wiring override: messaging_group_agents.threads (NULL = inherit).
   */
  threads: boolean;
  /**
   * unknown_sender_policy stamped on messaging_groups rows auto-created by
   * the router or created by wizard/CLI paths in this context.
   */
  unknownSenderPolicy: 'strict' | 'request_approval' | 'public';
}

/**
 * Static per-channel declaration of wiring-time defaults. Exactly two levels
 * exist: this declaration, and the per-wiring/per-mg values chosen at
 * creation. Install-wide changes = edit the adapter copy (skill-installed,
 * user-owned). Never persisted to the central DB.
 */
export interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  /**
   * Which mention signal the adapter emits (InboundMessage.isMention):
   *  'platform' — platform-confirmed mentions in groups; DMs flagged too.
   *  'dm-only'  — only DMs flagged (no group mention metadata).
   *  'never'    — isMention never set: auto-create/registration card never
   *               fires; 'mention'/'mention-sticky' wirings never engage.
   * Creation surfaces must reject/warn on mention modes that can never fire.
   */
  mentions: 'platform' | 'dm-only' | 'never';
}

/** The v2 channel adapter contract. */
export interface ChannelAdapter {
  name: string;
  channelType: string;

  /**
   * Adapter-instance name — distinguishes N adapters of one platform
   * (e.g. three Slack apps in one workspace). Defaults to channelType.
   * channelType stays the SEMANTIC platform key (user ids '<channelType>:<handle>',
   * formatting, container config); instance is a host-side routing key only.
   * Must be unique across active adapters and URL-safe (no '/', '?', ':').
   */
  instance?: string;

  /**
   * Whether this adapter models conversations as threads.
   *
   * true  — adapter's platform uses threads as the primary conversation unit
   *         (Discord, Slack, Linear, GitHub). One thread = one session; the
   *         agent replies into the originating thread.
   * false — adapter's platform treats the channel itself as the conversation
   *         (Telegram, WhatsApp, iMessage). Thread ids are stripped at the
   *         router; agent replies go to the channel.
   */
  supportsThreads: boolean;

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound delivery — returns the platform message ID if available
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;

  /**
   * Subscribe the bot to a thread so follow-up messages route via the
   * platform's "subscribed message" path (onSubscribedMessage in Chat SDK).
   * Called by the router when a mention-sticky wiring first engages in a
   * thread. Idempotent: calling twice on the same thread is a no-op.
   *
   * Platforms without a subscription concept can omit this; the router
   * treats absence as a no-op.
   */
  subscribe?(platformId: string, threadId: string): Promise<void>;

  /**
   * Open (or fetch) a DM with this user, returning the platform_id of the
   * resulting DM channel. Called by the host on demand to initiate cold
   * DMs — approvals, pairing handshakes, host-initiated notifications — to
   * users who may never have messaged the bot themselves.
   *
   * Omit this method on channels where the user handle IS already the DM
   * chat id (Telegram, WhatsApp, iMessage, email, Matrix). Callers will
   * fall through to using the handle directly.
   *
   * For channels that distinguish user id from DM channel id (Discord,
   * Slack, Teams, Webex, gChat): implement by delegating to Chat SDK's
   * chat.openDM, which hits the platform's idempotent open-DM endpoint.
   * Returning the same platform_id on repeated calls is expected.
   */
  openDM?(userHandle: string): Promise<string>;

  /**
   * Declared wiring-time defaults for this channel. Optional for backward
   * compatibility with stale adapter copies; absent → core fallback
   * (fallbackChannelDefaults(supportsThreads), see channel-registry.ts).
   * May be computed from adapter-internal env at module load (e.g. WhatsApp
   * shared-number mode), but is immutable for the process lifetime.
   */
  defaults?: ChannelDefaults;
}

/** Factory function that creates a channel adapter (returns null if credentials missing). */
export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;

/** Registration entry for a channel adapter. */
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  /**
   * Same declaration as ChannelAdapter.defaults, resolvable WITHOUT
   * instantiating the adapter — offline creation paths (setup/register.ts,
   * scripts/init-first-agent.ts, ncl against a host where the factory
   * returned null for missing creds) read it from the registry. Channel
   * modules pass the same const here and to the adapter/bridge.
   */
  defaults?: ChannelDefaults;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
