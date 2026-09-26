/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 *
 * Additional bot identities in the same workspace: set
 * SLACK_INSTANCES=<name>[,<name>…] plus a per-instance token set
 * (SLACK_BOT_TOKEN_<NAME> / SLACK_APP_TOKEN_<NAME> /
 * SLACK_SIGNING_SECRET_<NAME>; name uppercased, dashes → underscores). Each
 * name registers under the `slack-<name>` instance key through the same
 * createSlackBridge factory as the default app — no mirrored construction.
 * channelType stays 'slack' either way, so user ids, formatting, container
 * config, and the wiring-defaults declaration are shared across instances.
 */
import { cardToBlockKit, createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';
import { Actions, Card, CardText, LinkButton } from 'chat';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelContextDefaults, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { extractSlackRawText } from './slack-raw-text.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * dm.threads:false is a deliberate policy choice, not a capability limit:
 * Slack users can open sub-threads inside a DM, but by default the agent
 * replies top-level and all DM sub-threads collapse into the one DM session.
 * This declaration owns that judgment (it used to be hardcoded router
 * behavior); operators who want in-thread DM replies override per wiring
 * with `--threads true`.
 *
 * Agent-DM anchors (the settled Slack DM shape) — creation-time stamps, so
 * they apply to wirings/rows created from this declaration onward and never
 * flip existing installs:
 * - dm.sessionMode 'per-thread': Slack's agent-mode DM surface materializes
 *   a thread per conversation, so a new DM wiring roots a session per thread.
 *   resolveWiringDefaults derives the threads=1 stamp from this at creation
 *   (per-thread sessions structurally require honored thread ids — no
 *   separate field to declare). The live inherit value dm.threads stays
 *   false, so wirings created earlier (threads column NULL) keep collapsing
 *   DM sub-threads into the one DM session.
 * - dm.unknownSenderPolicy 'decline_notify': an unknown DM sender gets a
 *   polite decline and the owner a one-line FYI — no approval card; access
 *   grants stay explicit (`ncl members add`). A deliberate, reviewed default
 *   change for Slack DM rows auto-created after this lands.
 */
export const SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: false,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'decline_notify',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    // D29: group conversations are per-thread too — Slack channels
    // materialize a thread per top-level message, and ambient context
    // (same-mg fan + channel-timeline backfill) is the continuity layer.
    // Creation-time stamp like dm.sessionMode; existing wirings never flip.
    // Canvas-comment shadow channels deliberately stay shared (wired
    // explicitly in room-canvas, the documented D29 exception).
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'platform',
};

/**
 * Classify a Slack conversation for consumers that render it to a human
 * (e.g. approval cards): a 1:1 DM, a group DM (MPDM), or a channel. Channels
 * resolve their name; MPDMs resolve their human participants through the
 * calling bot's own authenticated client. Returns null when the Slack API
 * can't classify the conversation (network failure, missing scope) so the
 * caller falls through to its generic rendering.
 */
export async function resolveSlackConversation(
  slackAdapter: SlackAdapter,
  platformId: string,
): Promise<{
  type: 'direct' | 'group_dm' | 'channel';
  name: string | null;
  participantNames?: string[];
  participantIds?: string[];
} | null> {
  const channelId = platformId.replace(/^slack:/, '').split(':')[0];
  if (channelId.startsWith('D')) return { type: 'direct', name: null };

  try {
    const info = await slackAdapter.fetchThread(`slack:${channelId}`);
    const channel = (info.metadata as { channel?: { is_mpim?: boolean } }).channel;
    if (!channel?.is_mpim) return { type: 'channel', name: info.channelName ?? null };

    try {
      const { members = [] } = await slackAdapter.webClient.conversations.members({
        channel: channelId,
        limit: 100,
      });
      const users = await Promise.all(members.map((id) => slackAdapter.getUser(id)));
      // participantIds (raw Slack "U…" ids) MUST stay parallel to
      // participantNames — same length, same order. A consumer pairing the
      // two arrays positionally (e.g. to exclude one participant by id)
      // breaks silently if a member is filtered from only ONE array (bot,
      // failed profile lookup). Both arrays are therefore projected from a
      // single filtered list: bots and members whose profile lookup failed
      // drop from BOTH.
      const humans = members
        .map((id, i) => ({ id, user: users[i] }))
        .filter((entry): entry is { id: string; user: NonNullable<(typeof users)[number]> } =>
          Boolean(entry.user && !entry.user.isBot),
        );
      return {
        type: 'group_dm',
        name: null,
        participantNames: humans.map(({ user }) => user.userName || user.fullName),
        participantIds: humans.map(({ id }) => id),
      };
    } catch {
      return { type: 'group_dm', name: null };
    }
  } catch {
    return null;
  }
}

/** Slack Block Kit limits that apply to a collapsible card. */
const CONTAINER_TITLE_MAX = 150;
const CONTAINER_CHILD_BLOCKS_MAX = 10;
const MESSAGE_BLOCKS_MAX = 50;
// Section text caps at 3000 characters; the margin leaves room for the
// emoji and bold conversion cardToBlockKit applies.
const SECTION_TEXT_MAX = 2900;

type SlackBlock = Record<string, unknown>;

/**
 * The display-card override the Chat SDK bridge accepts as `postCard`. Typed
 * here so this adapter compiles against a bridge that predates the option;
 * such a bridge simply never calls it.
 */
type PostCard = (
  threadId: string,
  cardSpec: Record<string, unknown>,
  fallbackText: string,
) => Promise<string | undefined>;

/** The slice of SlackAdapter the collapsible-card post needs. */
export type SlackCardPoster = Pick<SlackAdapter, 'decodeThreadId' | 'webClient'>;

interface CollapsibleChild {
  collapsible: true;
  title?: unknown;
  text: string;
}

function isCollapsibleChild(child: unknown): child is CollapsibleChild {
  if (!child || typeof child !== 'object') return false;
  const { collapsible, text } = child as Record<string, unknown>;
  return collapsible === true && typeof text === 'string' && text.trim() !== '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Split text into chunks of at most `max` characters, breaking at the last
 * newline inside each window when there is one. Past `maxChunks` the rest is
 * dropped and the final chunk ends in an ellipsis.
 */
function splitText(text: string, max: number, maxChunks: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max && chunks.length < maxChunks - 1) {
    const newline = rest.lastIndexOf('\n', max);
    const cut = newline > 0 ? newline : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(newline > 0 ? cut + 1 : cut);
  }
  chunks.push(truncate(rest, max));
  return chunks.filter((chunk) => chunk.trim() !== '');
}

function textBlocks(texts: string[]): SlackBlock[] {
  if (texts.length === 0) return [];
  return cardToBlockKit(Card({ children: texts.map((t) => CardText(t)) })) as SlackBlock[];
}

function collapsibleContainer(child: CollapsibleChild): SlackBlock {
  const title = typeof child.title === 'string' && child.title.trim() ? child.title.trim() : 'Details';
  return {
    type: 'container',
    title: { type: 'plain_text', text: truncate(title, CONTAINER_TITLE_MAX) },
    is_collapsible: true,
    default_collapsed: true,
    child_blocks: textBlocks(splitText(child.text, SECTION_TEXT_MAX, CONTAINER_CHILD_BLOCKS_MAX)),
  };
}

function linkButtonBlocks(actions: unknown): SlackBlock[] {
  if (!Array.isArray(actions)) return [];
  const buttons = actions
    .filter(
      (a): a is Record<string, unknown> =>
        !!a &&
        typeof a === 'object' &&
        typeof a.url === 'string' &&
        !!a.url &&
        typeof a.label === 'string' &&
        !!a.label,
    )
    .map((a) =>
      LinkButton({
        label: a.label as string,
        url: a.url as string,
        style: a.style === 'primary' || a.style === 'danger' || a.style === 'default' ? a.style : undefined,
      }),
    );
  if (buttons.length === 0) return [];
  return cardToBlockKit(Card({ children: [Actions(buttons)] })) as SlackBlock[];
}

/** True when a send_card spec carries at least one collapsible section. */
export function hasCollapsibleChild(cardSpec: Record<string, unknown>): boolean {
  return Array.isArray(cardSpec.children) && cardSpec.children.some(isCollapsibleChild);
}

/**
 * Block Kit for a send_card spec, in spec order: the title as a header, the
 * description and plain children as sections, each collapsible section as a
 * `container` block that starts collapsed, then link actions as buttons.
 * Non-collapsible parts go through cardToBlockKit, so they render exactly as
 * the default card does. Returns null when the result exceeds Slack's
 * per-message block limit.
 */
export function buildCollapsibleCardBlocks(cardSpec: Record<string, unknown>): SlackBlock[] | null {
  const title = typeof cardSpec.title === 'string' ? cardSpec.title : '';
  const blocks: SlackBlock[] = title ? (cardToBlockKit(Card({ title })) as SlackBlock[]) : [];
  let pending: string[] =
    typeof cardSpec.description === 'string' && cardSpec.description ? [cardSpec.description] : [];

  for (const child of Array.isArray(cardSpec.children) ? cardSpec.children : []) {
    if (isCollapsibleChild(child)) {
      blocks.push(...textBlocks(pending), collapsibleContainer(child));
      pending = [];
    } else if (typeof child === 'string' && child) {
      pending.push(child);
    } else if (child && typeof child === 'object' && typeof (child as Record<string, unknown>).text === 'string') {
      const text = (child as Record<string, string>).text;
      if (text) pending.push(text);
    }
  }
  blocks.push(...textBlocks(pending), ...linkButtonBlocks(cardSpec.actions));
  return blocks.length > MESSAGE_BLOCKS_MAX ? null : blocks;
}

/**
 * Post a send_card spec that carries collapsible sections as native Block
 * Kit. Returns the message ts, or undefined — for a card without collapsible
 * sections, one over Slack's limits, or any Slack API failure — so the
 * bridge posts its default card instead.
 */
export async function postSlackCollapsibleCard(
  slackAdapter: SlackCardPoster,
  threadId: string,
  cardSpec: Record<string, unknown>,
  fallbackText: string,
): Promise<string | undefined> {
  if (!hasCollapsibleChild(cardSpec)) return undefined;
  const blocks = buildCollapsibleCardBlocks(cardSpec);
  if (!blocks) return undefined;
  try {
    const { channel, threadTs } = slackAdapter.decodeThreadId(threadId);
    // Slack's typed block union predates the container block; the body is
    // plain Block Kit JSON, so it is handed over as the call's own argument type.
    const args = {
      channel,
      thread_ts: threadTs || undefined,
      text: fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    } as unknown as Parameters<SlackCardPoster['webClient']['chat']['postMessage']>[0];
    const result = await slackAdapter.webClient.chat.postMessage(args);
    return result.ts;
  } catch (err) {
    log.warn('Slack collapsible card failed, posting the default card', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Construction knobs for one Slack bot identity. */
export interface SlackBridgeOptions {
  /**
   * Uppercased/underscored instance suffix appended to each token env key
   * after an underscore — 'ALPHA' reads SLACK_BOT_TOKEN_ALPHA /
   * SLACK_SIGNING_SECRET_ALPHA / SLACK_APP_TOKEN_ALPHA. Omit (or pass '')
   * for the default app's unsuffixed keys.
   */
  envKeySuffix?: string;
  /**
   * Registry/bridge instance key (e.g. 'slack-alpha'). Omit for the default
   * instance, keyed by channelType. channelType stays 'slack' either way —
   * instance is a host-side routing key only, so user ids, formatting,
   * container config, and the wiring-defaults declaration are shared with
   * the default Slack app.
   */
  instanceKey?: string;
}

/**
 * Build one Slack bot identity's bridge from its token set. The default app
 * is the zero-suffix call (used by the registration below); named instances
 * pass a suffix + instance key and get the exact same construction — Socket
 * Mode opt-in, channel-name resolution, SLACK_DEFAULTS declaration. Returns
 * null when the bot token is missing so the registry surfaces its normal
 * "credentials missing, skipping" warning.
 */
export function createSlackBridge(options: SlackBridgeOptions = {}): ChannelAdapter | null {
  const suffix = options.envKeySuffix ? `_${options.envKeySuffix}` : '';
  const keys = {
    botToken: `SLACK_BOT_TOKEN${suffix}`,
    signingSecret: `SLACK_SIGNING_SECRET${suffix}`,
    appToken: `SLACK_APP_TOKEN${suffix}`,
  };
  const env = readEnvFile([keys.botToken, keys.signingSecret, keys.appToken]);
  const botToken = env[keys.botToken];
  if (!botToken) return null;
  // An xapp-… token enables Socket Mode: events arrive over an outbound
  // WebSocket, so no public HTTPS endpoint is required. When set, the
  // signing secret is optional (Slack signs socket frames separately).
  const appToken = env[keys.appToken];
  const slackAdapter = createSlackAdapter({
    botToken,
    signingSecret: env[keys.signingSecret],
    appToken,
    mode: appToken ? 'socket' : 'webhook',
  });
  const bridgeConfig: Parameters<typeof createChatSdkBridge>[0] & { postCard?: PostCard } = {
    adapter: slackAdapter,
    extractRawText: extractSlackRawText,
    instance: options.instanceKey, // undefined ⇒ default instance (keyed by channelType)
    concurrency: 'concurrent',
    supportsThreads: true,
    defaults: SLACK_DEFAULTS,
    postCard: (threadId, cardSpec, fallbackText) =>
      postSlackCollapsibleCard(slackAdapter, threadId, cardSpec, fallbackText),
  };
  const bridge = createChatSdkBridge(bridgeConfig);
  bridge.resolveChannelName = async (platformId: string) => {
    try {
      const info = await slackAdapter.fetchThread(platformId);
      return (info as { channelName?: string }).channelName ?? null;
    } catch {
      return null;
    }
  };
  // Conversation classification closes over THIS identity's adapter, so
  // every instance (default or named) resolves through its own token.
  // ChannelAdapter does not declare resolveConversation yet — the extension
  // rides on the returned object until the core seam lands.
  return Object.assign(bridge, {
    resolveConversation: (platformId: string) => resolveSlackConversation(slackAdapter, platformId),
  });
}

/** Env-key suffix for a named instance: uppercased, dashes → underscores. */
export function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * Build one named instance's bridge from its per-instance token set, through
 * the shared factory. Returns null when the bot token is missing so the
 * registry surfaces its normal "credentials missing, skipping" warning.
 *
 * Exported so a test can drive the real factory against a token set.
 */
export function slackInstanceBridgeFactory(name: string): ChannelAdapter | null {
  return createSlackBridge({
    envKeySuffix: instanceEnvKeySuffix(name),
    instanceKey: `slack-${name}`,
  });
}

registerChannelAdapter('slack', {
  factory: () => createSlackBridge(),
  defaults: SLACK_DEFAULTS,
});

// Named instances — registration is unconditional for every listed name so a
// missing token set surfaces as the registry's "credentials missing, skipping"
// warning at boot rather than a silently absent bot. Every registration carries
// the same SLACK_DEFAULTS declaration as the default app, so offline creation
// paths (setup, ncl) resolve declared wiring defaults for named instances too.
for (const raw of (readEnvFile(['SLACK_INSTANCES']).SLACK_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  registerChannelAdapter(`slack-${name}`, {
    factory: () => slackInstanceBridgeFactory(name),
    defaults: SLACK_DEFAULTS,
  });
}
