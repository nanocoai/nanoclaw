/**
 * Microsoft Teams channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createTeamsAdapter } from '@chat-adapter/teams';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/*
 * Thread replies in Teams 1:1 (personal) chats.
 *
 * Teams' "threads in one-on-one agent chats" preview marks a DM thread reply
 * only through `channelData.replyChain.id` — the root message's id — which
 * differs from the id of the message the activity is about. `conversation.id`
 * stays the plain `a:…` DM id, so the adapter can't tell a thread reply from
 * a top-level message.
 *
 * Inbound, the activity's conversation id is rewritten to the form the
 * adapter already uses for channel threads, `<conversationId>;messageid=<root>`.
 * Its `channelIdFromThreadId` strips the suffix, so the DM keeps mapping to
 * the same messaging group while the thread id carries the root.
 *
 * Outbound, Teams rejects the `;messageid=` form on a personal conversation
 * ("Failed to decrypt conversation id"). New messages go to
 * `POST /v3/conversations/{chat.id}/replyChains/{root}` instead, where
 * `chat.id` is the `19:…@unq.gbl.spaces` id from the inbound activity's
 * `channelData.chat.id`. Typing, edits, deletes and reactions address the
 * plain `a:…` id, which Teams accepts for messages inside a thread.
 */

const THREAD_SUFFIX = /;messageid=(\d+)$/;
const CHAT_ID_STATE_PREFIX = 'nanoclaw:teams:dmChatId:';
const CHAT_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Teams activity JSON and adapter internals are untyped */
type Activity = Record<string, any>;

function isPersonalConversationId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('a:');
}

/**
 * The thread a personal-chat activity belongs to, or null for a
 * non-personal conversation or an activity without reply-chain data (a
 * client or tenant without the threads preview).
 *
 * A typed message always gets a thread: a reply inside one carries its
 * root, and a top-level message is its own root, so the agent's answer
 * opens a thread under it, as in a channel. Reactions, card clicks and
 * message actions are anchored on their target message and get a thread
 * only when that message is inside one.
 */
export function dmThreadRoot(activity: Activity): string | null {
  const conversation = activity?.conversation;
  if (conversation?.conversationType !== 'personal' || !isPersonalConversationId(conversation.id)) return null;
  if (THREAD_SUFFIX.test(conversation.id)) return null;
  const root = activity.channelData?.replyChain?.id;
  if (typeof root !== 'string' || !/^\d+$/.test(root) || root === '0') return null;
  if (activity.type === 'message') return root;
  const anchor = activity.value?.messagePayload?.id ?? activity.replyToId;
  if (typeof anchor !== 'string' || !anchor || anchor === root) return null;
  return root;
}

/** Splits `a:…;messageid=<root>` into its base DM id and root; null for anything else. */
export function splitDmThreadConversationId(id: unknown): { base: string; root: string } | null {
  if (!isPersonalConversationId(id)) return null;
  const match = THREAD_SUFFIX.exec(id);
  if (!match) return null;
  return { base: id.slice(0, match.index), root: match[1] };
}

interface ChatIdStore {
  remember(baseConversationId: string, chatId: string): void;
  lookup(baseConversationId: string): Promise<string | null>;
}

function createChatIdStore(getState: () => any): ChatIdStore {
  const cache = new Map<string, string>();
  return {
    remember(base, chatId) {
      if (cache.get(base) === chatId) return;
      cache.set(base, chatId);
      const state = getState();
      state?.set?.(CHAT_ID_STATE_PREFIX + base, chatId, CHAT_ID_TTL_MS)?.catch?.(() => {});
    },
    async lookup(base) {
      const hit = cache.get(base);
      if (hit) return hit;
      try {
        const stored = await getState()?.get?.(CHAT_ID_STATE_PREFIX + base);
        if (typeof stored === 'string' && stored) {
          cache.set(base, stored);
          return stored;
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable state store only costs threading, never the message
      } catch {
        /* fall through to a top-level post */
      }
      return null;
    },
  };
}

/**
 * Installs DM thread support on a `@chat-adapter/teams` adapter instance.
 * Everything outside personal chats passes through untouched.
 */
export function installTeamsDmThreads(teamsAdapter: any): void {
  const chatIds = createChatIdStore(() => teamsAdapter.chat?.getState?.());

  // Inbound: remember each DM's chat id, and give DM messages a thread id.
  const origHandleWebhook = teamsAdapter.handleWebhook.bind(teamsAdapter);
  teamsAdapter.handleWebhook = async (request: Request, options: unknown) => {
    let activity: Activity | null = null;
    try {
      activity = (await request.clone().json()) as Activity;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a body we can't parse goes to the adapter unchanged, which owns rejecting it
    } catch {
      return origHandleWebhook(request, options);
    }
    const conversationId = activity?.conversation?.id;
    const chatId = activity?.channelData?.chat?.id;
    if (
      activity?.conversation?.conversationType === 'personal' &&
      isPersonalConversationId(conversationId) &&
      typeof chatId === 'string' &&
      chatId
    ) {
      chatIds.remember(conversationId.replace(THREAD_SUFFIX, ''), chatId);
    }
    const root = activity ? dmThreadRoot(activity) : null;
    if (!root || !activity) return origHandleWebhook(request, options);
    activity.conversation.id = `${conversationId};messageid=${root}`;
    const rewritten = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(activity),
    });
    return origHandleWebhook(rewritten, options);
  };

  // Outbound sends (posts and typing) all funnel through the app's activity sender.
  const sender = teamsAdapter.app?.activitySender;
  if (!sender?.send) {
    log.warn('Teams DM threads: adapter has no activity sender; DM thread replies will post top-level');
  } else {
    const origSend = sender.send.bind(sender);
    sender.send = async (params: any, ref: any, options: any) => {
      const split = splitDmThreadConversationId(ref?.conversation?.id);
      if (!split) return origSend(params, ref, options);
      const baseRef = { ...ref, conversation: { ...ref.conversation, id: split.base } };
      if (params?.type === 'message' && !params.id && !options?.replyChainId) {
        const chatId = await chatIds.lookup(split.base);
        if (chatId) {
          return origSend(
            params,
            { ...ref, conversation: { ...ref.conversation, id: chatId } },
            { ...options, replyChainId: split.root },
          );
        }
        log.warn('Teams DM threads: chat id unknown for this DM; posting top-level', { root: split.root });
      }
      return origSend(params, baseRef, options);
    };
  }

  // Edits, deletes and reactions address the plain DM conversation.
  const toBaseThreadId = (threadId: string): string => {
    try {
      const { conversationId } = teamsAdapter.decodeThreadId(threadId);
      return splitDmThreadConversationId(conversationId) ? teamsAdapter.channelIdFromThreadId(threadId) : threadId;
      // eslint-disable-next-line no-catch-all/no-catch-all -- an undecodable id goes to the adapter unchanged, which owns rejecting it
    } catch {
      return threadId;
    }
  };
  for (const method of ['editMessage', 'deleteMessage', 'addReaction', 'removeReaction'] as const) {
    const orig = teamsAdapter[method];
    if (typeof orig !== 'function') continue;
    teamsAdapter[method] = (threadId: string, ...rest: unknown[]) =>
      orig.call(teamsAdapter, toBaseThreadId(threadId), ...rest);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Dedicated bot app on a threaded platform. 'mention' (not sticky) is the
 * conservative group default; operators upgrade per wiring. DMs keep thread
 * ids so a reply in a 1:1 thread lands in that thread (installTeamsDmThreads);
 * a DM still runs as one shared session.
 */
const TEAMS_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('teams', {
  factory: () => {
    const env = readEnvFile(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_APP_TENANT_ID', 'TEAMS_APP_TYPE']);
    if (!env.TEAMS_APP_ID) return null;
    const teamsAdapter = createTeamsAdapter({
      appId: env.TEAMS_APP_ID,
      appPassword: env.TEAMS_APP_PASSWORD,
      appType: (env.TEAMS_APP_TYPE as 'SingleTenant' | 'MultiTenant') || undefined,
      appTenantId: env.TEAMS_APP_TENANT_ID || undefined,
    });
    installTeamsDmThreads(teamsAdapter);
    return createChatSdkBridge({
      adapter: teamsAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: TEAMS_DEFAULTS,
    });
  },
  defaults: TEAMS_DEFAULTS,
});
