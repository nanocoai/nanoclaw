# NanoClaw API Details

Implementation-level details for the architecture. See [architecture.md](architecture.md) for the high-level design.

## Channel Adapter Interface

### NanoClaw Channel Interface

```typescript
interface ChannelSetup {
  // Conversation configs from central DB — passed at setup, not queried by adapter
  conversations: ConversationConfig[];

  // Host callbacks
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void;
  // Admin-transport adapters (e.g. CLI) route to an arbitrary channel via this instead of onInbound
  onInboundEvent(event: InboundEvent): void;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
}

interface ConversationConfig {
  platformId: string;
  agentGroupId: string;
  triggerPattern?: string;       // regex string (for native channels)
  requiresTrigger: boolean;
  sessionMode: 'shared' | 'per-thread';
}

interface ChannelAdapter {
  name: string;
  channelType: string;

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound delivery
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  updateConversations?(conversations: ConversationConfig[]): void;
}

// Inbound message from adapter to host
interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;       // JSON blob — NanoClaw chat format or Chat SDK SerializedMessage
  timestamp: string;
}

// Outbound message from host to adapter
interface OutboundMessage {
  kind: 'chat' | 'chat-sdk';
  content: unknown;       // JSON blob — matches the kind
}
```

### Channel Defaults

Each adapter can declare static wiring-time defaults. There are exactly two levels: the adapter declaration, and the per-wiring/per-messaging-group values chosen at creation. There is no DB config table for defaults — install-wide changes mean editing the adapter copy (skill-installed, user-owned).

```typescript
// src/channels/adapter.ts
interface ChannelContextDefaults {
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern?: string;   // required iff engageMode='pattern'; may contain the
                            // literal token {name} — creation helpers substitute the
                            // regex-escaped agent_group name
  threads: boolean;         // whether thread ids are honored in this context by default;
                            // must be false when the adapter's supportsThreads is false
  unknownSenderPolicy: 'strict' | 'request_approval' | 'public';
}

interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  mentions: 'platform' | 'dm-only' | 'never';
  // 'platform' — platform-confirmed mentions in groups, DMs flagged too
  // 'dm-only'  — only DMs flagged (no group mention metadata)
  // 'never'    — isMention never set: no auto-create card, mention wirings never engage
}

// ChannelAdapter and ChannelRegistration both carry an optional `defaults` field.
// The registration-level copy lets offline creation paths (setup/register.ts,
// scripts/init-first-agent.ts) resolve declarations without instantiating the
// adapter. ChatSdkBridgeConfig.defaults is copied verbatim onto the bridged
// adapter, like supportsThreads.
```

**Resolution chain** (`getChannelDefaults(key, channelType?)` in `src/channels/channel-registry.ts`, key = `mg.instance ?? mg.channel_type`, same discipline as `getChannelAdapter`):

1. Live adapter's `defaults`, instance-exact (lets an instance carry env-computed declarations, e.g. WhatsApp shared-number mode)
2. Live adapter of that channelType
3. Registration entry under the key
4. Registration entry under the channelType (from the live adapter's channelType, else the caller-supplied hint)
5. `fallbackChannelDefaults(supportsThreads)` — behavior-faithful to the pre-declaration router: dm `{ pattern '.', threads: supportsThreads, request_approval }`, group `{ mention-sticky, threads: supportsThreads, request_approval }`, mentions `'platform'`. `supportsThreads` is `false` when no adapter is live.

Never returns undefined. `hasDeclaredChannelDefaults()` reports whether tiers 1–4 hit; manual creation surfaces (`ncl`) gate declaration-derived defaults on it so stale (undeclared) adapters keep the legacy static schema defaults — a trunk update alone changes no behavior.

**Creation helpers** (`src/channels/channel-defaults.ts`): every wiring-creation path calls `resolveWiringDefaults(channelKey, isGroup, agentGroupName)` — it picks `decl.group` vs `decl.dm` by `isGroup = event.message.isGroup ?? (mg.is_group === 1)` (never `threadId !== null`), substitutes `{name}`, and downgrades `mention-sticky` → `mention` when the context's resolved threads value is false. `resolveUnknownSenderPolicy` does the same for auto-created messaging_groups rows.

**Runtime thread policy**: engage mode and sender policy are creation-time snapshots; threading is the one setting consulted live. `messaging_group_agents.threads` (migration 019) is the per-wiring override: `NULL` = inherit the adapter declaration for the wiring's context, `1`/`0` = explicit. `resolveThreadPolicy(wiring.threads, decl, isGroup, supportsThreads)` hard-ANDs the result with the adapter's raw capability — a wiring can opt out of threads on a threaded platform, never opt in on a non-threaded one. When the policy is off, event-derived thread ids are nulled at router fanout (sessions collapse, replies land top-level); `event.replyTo` is operator intent from the CLI transport and is never nulled.

### Chat SDK Bridge

Wraps a Chat SDK adapter + Chat instance to conform to the NanoClaw ChannelAdapter interface. Trunk ships the bridge and the channel registry only — platform-specific Chat SDK adapters (Discord, Slack, Telegram, etc.) and native adapters (WhatsApp/Baileys) are installed by the `/add-<channel>` skills from the `channels` branch.

```typescript
function createChatSdkBridge(
  adapter: Adapter,
  chatConfig: { concurrency?: ConcurrencyStrategy }
): ChannelAdapter {
  let chat: Chat;
  let hostCallbacks: ChannelSetup;

  return {
    name: adapter.name,
    channelType: adapter.name,

    async setup(config) {
      hostCallbacks = config;

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        state: new SqliteStateAdapter(),
        concurrency: chatConfig.concurrency ?? 'concurrent',
      });

      // Subscribe registered conversations
      for (const conv of config.conversations) {
        if (conv.agentGroupId) {
          await chat.state.subscribe(conv.platformId);
        }
      }

      // Subscribed threads → forward all messages
      chat.onSubscribedMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        config.onInbound(channelId, thread.id, {
          id: message.id,
          kind: 'chat-sdk',
          content: message.toJSON(),
          timestamp: message.metadata.dateSent.toISOString(),
        });
      });

      // @mention in unsubscribed thread → discovery
      chat.onNewMention(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        config.onInbound(channelId, thread.id, {
          id: message.id,
          kind: 'chat-sdk',
          content: message.toJSON(),
          timestamp: message.metadata.dateSent.toISOString(),
        });
        // Subscribe so future messages in this thread are received
        await thread.subscribe();
      });

      // DMs → always forward
      chat.onDirectMessage(async (thread, message) => {
        config.onInbound(thread.id, null, {
          id: message.id,
          kind: 'chat-sdk',
          content: message.toJSON(),
          timestamp: message.metadata.dateSent.toISOString(),
        });
        await thread.subscribe();
      });

      await chat.initialize();
    },

    async deliver(platformId, threadId, message) {
      const tid = threadId ?? platformId;
      if (message.kind === 'chat-sdk') {
        const content = message.content as Record<string, unknown>;
        if (content.operation === 'edit') {
          await adapter.editMessage(tid, content.messageId as string, 
            { markdown: content.text as string });
        } else if (content.operation === 'reaction') {
          await adapter.addReaction(tid, content.messageId as string, 
            content.emoji as string);
        } else {
          await adapter.postMessage(tid, content as AdapterPostableMessage);
        }
      } else {
        const content = message.content as { text: string };
        await adapter.postMessage(tid, { markdown: content.text });
      }
    },

    async setTyping(platformId, threadId) {
      await adapter.startTyping(threadId ?? platformId);
    },

    async teardown() {
      await chat.shutdown();
    },

    isConnected() { return true; },

    updateConversations(conversations) {
      // Subscribe new conversations, could unsubscribe removed ones
      for (const conv of conversations) {
        if (conv.agentGroupId) {
          chat.state.subscribe(conv.platformId);
        }
      }
    },
  };
}
```

### Native NanoClaw Channel (no Chat SDK)

Native channels implement the ChannelAdapter interface directly. The WhatsApp/Baileys adapter is the canonical example — it ships via the `/add-whatsapp` skill, not in trunk:

```typescript
function createWhatsAppChannel(): ChannelAdapter {
  let socket: WASocket;
  let config: ChannelSetup;

  return {
    name: 'whatsapp',
    channelType: 'whatsapp',

    async setup(setup) {
      config = setup;
      socket = await connectBaileys();

      socket.on('messages.upsert', (event) => {
        for (const msg of event.messages) {
          const jid = msg.key.remoteJid;
          const conv = config.conversations.find(c => c.platformId === jid);

          // Trigger check (native — adapter does this, not host)
          if (conv?.requiresTrigger && conv.triggerPattern) {
            if (!new RegExp(conv.triggerPattern).test(msg.message?.conversation || '')) {
              return; // Doesn't match trigger
            }
          }

          config.onInbound(jid, null, {
            id: msg.key.id,
            kind: 'chat',
            content: {
              sender: msg.pushName || msg.key.participant,
              senderId: msg.key.participant || msg.key.remoteJid,
              text: msg.message?.conversation || '',
              attachments: [],
              isFromMe: msg.key.fromMe,
            },
            timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
          });
        }
      });
    },

    async deliver(platformId, threadId, message) {
      const content = message.content as { text: string };
      await socket.sendMessage(platformId, { text: content.text });
    },

    async setTyping(platformId) {
      await socket.sendPresenceUpdate('composing', platformId);
    },

    async teardown() {
      await socket.logout();
    },

    isConnected() { return !!socket; },
  };
}
```

## Session DB Schema Details

### messages_in content examples

**`chat`** — simple NanoClaw format:
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Check this PR",
  "attachments": [{ "type": "image", "url": "https://signed-url..." }],
  "isFromMe": false
}
```

**`chat-sdk`** — full Chat SDK `SerializedMessage`:
```json
{
  "_type": "chat:Message",
  "id": "msg-1",
  "threadId": "slack:C123:1234.5678",
  "text": "Check this PR",
  "formatted": { "type": "root", "children": [...] },
  "author": { "userId": "U123", "userName": "john", "fullName": "John", "isBot": false, "isMe": false },
  "metadata": { "dateSent": "2024-01-01T00:00:00Z", "edited": false },
  "attachments": [{ "type": "image", "url": "https://...", "name": "screenshot.png" }],
  "isMention": true,
  "links": []
}
```

**Question response** (from user clicking an interactive card):
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Yes",
  "questionId": "q-123",
  "selectedOption": "Yes",
  "isFromMe": false
}
```

### messages_out content examples

**Normal chat message:**
```json
{ "text": "LGTM, merging now" }
```

**Chat SDK markdown:**
```json
{ "markdown": "## Review Summary\n**Status**: Approved\n\nNo issues found." }
```

**Card:**
```json
{
  "card": {
    "type": "card",
    "title": "Deployment Approval",
    "children": [
      { "type": "text", "content": "Deploy 2.1.0 to production?" },
      { "type": "actions", "children": [
        { "type": "button", "id": "approve", "label": "Approve", "style": "primary" },
        { "type": "button", "id": "reject", "label": "Reject", "style": "danger" }
      ]}
    ]
  },
  "fallbackText": "Deployment Approval: Deploy 2.1.0 to production? [Approve] [Reject]"
}
```

**Ask user question:**
```json
{
  "type": "ask_question",
  "questionId": "q-123",
  "title": "Failing Test",
  "question": "How should we handle the failing test?",
  "options": [
    "Skip it",
    { "label": "Fix and retry", "selectedLabel": "✅ Fixing", "value": "fix" },
    { "label": "Abort deployment", "selectedLabel": "❌ Aborted", "value": "abort" }
  ]
}
```

**Edit message:**
```json
{ "operation": "edit", "messageId": "3", "text": "Updated: LGTM with minor comments on line 42" }
```

**Reaction:**
```json
{ "operation": "reaction", "messageId": "5", "emoji": "thumbs_up" }
```

**System action:**
```json
{ "action": "reset_session", "payload": { "session_id": "sess-123", "reason": "Skills updated" } }
```

## Host Delivery Logic

The host reads messages_out and dispatches based on `kind` and `operation`:

```typescript
async function deliverMessage(row: MessagesOutRow, adapter: ChannelAdapter) {
  const content = JSON.parse(row.content);

  // System actions — host handles internally
  if (row.kind === 'system') {
    await handleSystemAction(content);
    return;
  }

  // Agent-to-agent — write to target session DB
  if (isAgentDestination(row)) {
    await writeToAgentSession(row);
    return;
  }

  // Channel delivery — delegate to adapter
  await adapter.deliver(row.platform_id, row.thread_id, {
    kind: row.kind,
    content,
  });
}
```

The adapter's `deliver()` method handles operation dispatch internally (post vs edit vs reaction).
