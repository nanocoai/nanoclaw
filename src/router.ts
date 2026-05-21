import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export async function routeOutboundImage(
  channels: Channel[],
  jid: string,
  imagePaths: string[],
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (channel.sendImage) {
    await channel.sendImage(jid, imagePaths, caption);
    return;
  }
  // Graceful fallback: surface the agent's caption (or a placeholder) as text.
  await channel.sendMessage(jid, caption ?? '[image]');
}

export async function routeOutboundVideo(
  channels: Channel[],
  jid: string,
  videoPaths: string[],
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (channel.sendVideo) {
    await channel.sendVideo(jid, videoPaths, caption);
    return;
  }
  // Graceful fallback: surface the agent's caption (or a placeholder) as text.
  await channel.sendMessage(jid, caption ?? '[video]');
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

// User-facing apology messages for the three silent-failure modes the
// orchestrator can detect when running an agent turn.
//
// - 'pre'    : the agent errored before streaming any output to the user.
//              They saw "Got it, working on it..." and then silence.
// - 'mid'    : the agent streamed something useful, then errored. They saw
//              partial output and the rest never landed.
// - 'silent' : the agent reported success but never emitted any text. They
//              saw "Got it, working on it..." and then a graceful return
//              with no follow-up — indistinguishable from a hang.
//
// The orchestrator dispatches via this lookup so the failure pathway
// stays out of the per-channel handlers and is unit-testable in isolation.
export type FailureKind = 'pre' | 'mid' | 'silent';

const FAILURE_COPY: Record<FailureKind, string> = {
  pre: '⚠️ Something broke on my end before I could finish. Try again?',
  mid: '⚠️ Got cut off mid-reply. Want me to retry?',
  silent:
    "⚠️ I'm here, but nothing useful came back from that run. Mind rephrasing or trying again?",
};

export function failureNoticeText(kind: FailureKind): string {
  return FAILURE_COPY[kind];
}

export async function routeFailureNotice(
  channels: Channel[],
  jid: string,
  kind: FailureKind,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  // Swallow when the channel is unreachable — the failure notice is a
  // best-effort overlay on top of an already-failed turn. Logging is the
  // caller's responsibility so the error path stays narrow here.
  if (!channel) return;
  await channel.sendMessage(jid, failureNoticeText(kind));
}
