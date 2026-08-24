import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime, formatLocalStamp } from './timezone.js';

/**
 * channel_type marking cross-session context copies (accumulate fan-out from
 * the agent group's other sessions). Echo rows are ambient context only: they
 * never provide reply routing, never count as commands, and render as
 * <cross-session-context> blocks.
 */
export const SESSION_ECHO_CHANNEL = 'session-echo';

export function isSessionEcho(msg: MessageInRow): boolean {
  return msg.channel_type === SESSION_ECHO_CHANNEL;
}

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  // Cross-session echo rows are ambient copies of another conversation —
  // a copied "/clear" etc. must never execute here.
  if (isSessionEcho(msg) || !text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  if (isSessionEcho(msg)) return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  return text.toLowerCase().startsWith('/clear');
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg).category;
  return cat === 'admin' || cat === 'passthrough';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  /** Batch is a task run. One-door delivery: only an explicitly addressed tool
   *  delivers from a task session; final-text `<message to>` blocks are inert
   *  and the final text auto-appends to the series run log. */
  taskRun: boolean;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first non-echo message's routing fields — a cross-session echo
 * row must never decide where the reply goes (its routing is NULL by
 * contract, but even a malformed row with routing set is skipped). Falls
 * back to the plain first row if the batch is somehow all echo (shouldn't
 * happen — echo rows never trigger).
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages.find((m) => !isSessionEcho(m)) ?? messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
    // Echo rows riding along with a task must not disable one-door delivery:
    // taskRun as long as at least one task row and no non-task/non-echo row.
    taskRun:
      messages.some((m) => m.kind === 'task') &&
      messages.every((m) => m.kind === 'task' || isSessionEcho(m)),
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  // Each `<message id="..." from="...">...</message>` block is self-contained;
  // concatenating them reads to the agent as a sequence of distinct messages.
  // Earlier revisions wrapped multi-message batches in an outer `<messages>`
  // envelope, but the Claude Agent SDK responded to that shape with a
  // synthetic stub (`model: "<synthetic>"`, `content: "No response
  // requested."`) instead of calling the API — see #2555 for the full trace.
  // The fix is simply to drop the wrapper; the single-message path (which
  // already worked) is now just the N=1 case of the same code.
  return messages.map(formatSingleChat).join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  if (isSessionEcho(msg)) return formatEchoMessage(msg);
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const linksSuffix = formatLinks(content.links, text);
  const attachmentsSuffix = formatAttachments(content.attachments);
  const appContextSuffix = formatAppContext(content.app_context);

  const fromAttr = originAttr(msg);

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${linksSuffix}${attachmentsSuffix}${appContextSuffix}</message>`;
}

/**
 * Render a cross-session context copy. No id/reply_to attributes — echo rows
 * are ambient context, not addressable messages. `from` is the human label of
 * the source conversation (e.g. "#Pixel room", "DM with Gavriel") written by
 * the host at fan-out time; content.text is already truncated host-side.
 */
function formatEchoMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const label = content.echo?.label || 'another conversation';
  const sender = content.sender || 'Unknown';
  const time = formatLocalStamp(new Date(msg.timestamp), TIMEZONE);
  // Timeline rows are the conversation's own preceding history — FIRST-CLASS
  // context this thread continues from (the agent's own posts render as
  // sender="you"), unlike cross-session-context ambient echoes from other
  // live surfaces which must never be acted on in-place. dm-timeline = a DM's
  // timeline; channel-timeline = a group conversation's (per-thread groups).
  if (content.echo?.surface === 'dm-timeline' || content.echo?.surface === 'channel-timeline') {
    const who = (content as { self?: boolean }).self ? 'you' : sender;
    const tag = content.echo.surface === 'channel-timeline' ? 'channel-history' : 'dm-history';
    return `<${tag} sender="${escapeXml(who)}" time="${escapeXml(time)}">${escapeXml(content.text || '')}</${tag}>`;
  }
  return `<cross-session-context from="${escapeXml(label)}" sender="${escapeXml(sender)}" time="${escapeXml(time)}">${escapeXml(content.text || '')}</cross-session-context>`;
}

/**
 * Build a ` from="destination_name"` attribute string from a message's routing
 * fields. Shared by all formatters so the agent always knows where a message
 * originated — critical for explicit addressing.
 */
function originAttr(msg: MessageInRow): string {
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.process_after ?? msg.timestamp, TIMEZONE);
  const currentTime = new Date().toLocaleString('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const parts: string[] = [];
  if (content.scriptOutput) {
    parts.push('Script output:', JSON.stringify(content.scriptOutput, null, 2), '');
  }
  parts.push('Instructions:', stripLegacyTaskContract(content.prompt || ''));
  return `<task${from} time="${escapeXml(time)}" current_time="${escapeXml(currentTime)}">${parts.join('\n')}</task>`;
}

const LEGACY_TASK_CONTRACT_MARKERS = [
  '\n\n[A task serves the user two separate ways —',
  '\n\n[Task delivery contract:',
];

/**
 * PR #2981 persisted its generated delivery contract inside each task prompt.
 * New sessions receive the contract from their runtime system prompt instead.
 * Strip only a known generated suffix, at read time, so existing task rows stay
 * compatible without a session-DB migration or contradictory model guidance.
 */
export function stripLegacyTaskContract(prompt: string): string {
  if (!prompt.trimEnd().endsWith(']')) return prompt;

  let contractStart = -1;
  for (const marker of LEGACY_TASK_CONTRACT_MARKERS) {
    contractStart = Math.max(contractStart, prompt.lastIndexOf(marker));
  }
  return contractStart >= 0 ? prompt.slice(0, contractStart).trimEnd() : prompt;
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  const from = originAttr(msg);
  return `<webhook${from} source="${escapeXml(source)}" event="${escapeXml(event)}">${JSON.stringify(content.payload || content, null, 2)}</webhook>`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  return `<system_response${from} action="${escapeXml(content.action || 'unknown')}" status="${escapeXml(content.status || 'unknown')}">${JSON.stringify(content.result || null)}</system_response>`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

/**
 * Render agent-mode app context — the entities the user was viewing when
 * they sent this message (content.app_context = { entities: [{ type, id },
 * …] }, attached by the chat-sdk bridge). One compact line inside the
 * message block; malformed/empty context renders nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAppContext(appContext: any): string {
  if (!appContext || !Array.isArray(appContext.entities)) return '';
  const items = appContext.entities
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((e: any) => typeof e?.type === 'string' && e.type && typeof e?.id === 'string' && e.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e: any) => `${e.type} ${e.id}`);
  if (items.length === 0) return '';
  return `\n(viewing: ${escapeXml(items.join(', '))})`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatLinks(links: any[] | undefined, text: string): string {
  if (!Array.isArray(links) || links.length === 0) return '';
  const urls = [
    ...new Set(
      links.flatMap((link) =>
        typeof link?.url === 'string' && link.url && !text.includes(link.url) ? [link.url] : [],
      ),
    ),
  ];
  return urls.length === 0 ? '' : `\n${urls.map((url) => `[link: ${escapeXml(url)}]`).join('\n')}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
