/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { cardToDiscordPayload, createDiscordAdapter } from '@chat-adapter/discord';
import { parseMarkdown, walkAst } from 'chat';

import * as askQuestion from './ask-question.js';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/**
 * Discord renders card text as Markdown: `[text](url)` shows any text for a
 * link, `<@id>` shows another user's name and `||text||` hides text. A word
 * joiner breaks each outside code (including every pipe in a spoiler run), and
 * a clicker's name or a request value can't pose as other text.
 */
export function escapeDiscordCardText(text: string): string {
  // Code is already literal on Discord. Keep commands inside matched code
  // spans/fences byte-for-byte, and escape only the surrounding prose. Its
  // backticks and [ get a backslash: Discord pairs a backtick, or ends a link,
  // past code and across the blocks of one embed, which are escaped one by one.
  const escape = (prose: string) =>
    prose
      .replace(/\]\(/g, ']\u2060(')
      .replace(/</g, '<\u2060')
      .replace(/\|{2,}/g, (pipes) => pipes.split('').join('\u2060') + '\u2060')
      .replace(/(\\*)([`[])/g, (match, slashes: string, mark: string) =>
        slashes.length % 2 ? match : `${slashes}\\${mark}`,
      );
  let result = '';
  let offset = 0;
  let code: Array<{ start: number; end: number }> = [];
  // Discord ends ``` code at the next ```, even mid-line, inside a longer
  // fence or past a blank fence's close, shows indented, tilde and unclosed
  // fences as prose, and ends a quote at the line. So only a one-line span
  // with no backtick, or a ``` fence holding a non-blank line and no ```, stays raw.
  const plain = /^(?:(`{1,2})[^`\n]+\1|```[^`\n]*\n\n*(?:[^`\n]|`(?!``))(?:[^`]|`(?!``))*\n```[ \t]*)$/;
  walkAst(parseMarkdown(text), (node) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined && plain.test(text.slice(start, end))) code.push({ start, end });
    }
    return node;
  });
  // Any other unescaped backtick can shift Discord's pairing: keep nothing raw.
  const outside = [...code.map((c, i) => text.slice(i ? code[i - 1].end : 0, c.start)), text.slice(code.at(-1)?.end)];
  if (outside.some((part) => /(?:^|[^\\])(?:\\\\)*`/.test(part))) code = [];
  for (const { start, end } of code) {
    result += escape(text.slice(offset, start)) + text.slice(start, end);
    offset = end;
  }
  return result + escape(text.slice(offset));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). Unwrap the snapshot into the payload, then drop `message_snapshots`
 * so adapters >= 4.38 (which flatten snapshots themselves) don't add it twice.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
  delete data.message_snapshots;
}

export function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    const edit = discordAdapter.editMessage.bind(discordAdapter);
    discordAdapter.editMessage = async (...args) => {
      const message = args[2];
      const { CardTooLongError } = askQuestion as { CardTooLongError?: new (reason: string) => Error };
      if (CardTooLongError && typeof message === 'object' && 'card' in message) {
        const payload = cardToDiscordPayload(message.card);
        if (payload.embeds.some((embed) => (embed.description?.length ?? 0) > 4096)) {
          throw new CardTooLongError('the resolved card exceeds the Discord embed description limit');
        }
      }
      return edit(...args);
    };
    unwrapForwards(discordAdapter);
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      defaults: DISCORD_DEFAULTS,
      // Discord rejects messages over 2000 chars; without this the bridge
      // would let long agent replies fail instead of splitting them.
      maxTextLength: 2000,
      // A card is one embed, whose description Discord caps at 4,096. The
      // limit counts the title and escaped text, and the embed adds only a
      // blank line between blocks, so a longer card is refused, never cut.
      // Spread, so an older core without these options still type-checks (and ignores them).
      ...{ escapeCardText: escapeDiscordCardText, maxCardTextLength: 4000 },
    });
  },
  defaults: DISCORD_DEFAULTS,
});
