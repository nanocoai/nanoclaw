/**
 * Result doors for lean task runs.
 *
 * A lean turn has no tools, so it delivers by writing tag blocks into its
 * final text:
 *
 *   <message to="NAME">text</message>          → a chat message to NAME
 *   <card to="NAME" title="Title">text</card>  → a display card to NAME
 *
 * The optional render command runs first: the final text goes to its stdin
 * and its stdout is parsed instead, so a small model can answer with plain
 * data and a script produces the blocks.
 */
import { execFile } from 'node:child_process';

import { writeMessageOut } from '../../db/messages-out.js';
import { resolveDestinationThread } from '../../db/session-routing.js';
import { findByName, getAllDestinations } from '../../destinations.js';
import type { RoutingContext } from '../../formatter.js';
import { dispatchResultText } from '../../poll-loop.js';

const RENDER_TIMEOUT_MS = 30_000;
const RENDER_MAX_BUFFER = 1024 * 1024;

const INTERNAL_SPAN_RE = /<internal>[\s\S]*?<\/internal>/g;
const DOOR_RE = /<(message|card)\s+([^>]*?)>([\s\S]*?)<\/\1>/g;
const ATTR_RE = /(to|title)\s*=\s*"([^"]*)"/g;

function log(msg: string): void {
  console.error(`[lean-tasks] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The system prompt a lean turn runs with, in place of the full instructions. */
export function buildLeanInstructions(opts: {
  assistantName?: string;
  taskId: string | null;
  render: boolean;
}): string {
  const lines = [
    opts.assistantName
      ? `You are ${opts.assistantName}, running a scheduled task.`
      : 'You are running a scheduled task.',
    '',
  ];
  if (opts.render) {
    lines.push('Reply with exactly the output the task asks for, with nothing before or after it.');
    return lines.join('\n');
  }
  const names = getAllDestinations().map((d) => d.name);
  if (names.length > 0) {
    lines.push(
      'To send a message, write it as a block: <message to="NAME">text</message>',
      'To post a card: <card to="NAME" title="Short title">text</card>',
      `Valid NAME values: ${names.join(', ')}.`,
      'Send only when the task says to.',
      '',
    );
  }
  lines.push(
    `Text outside these blocks is not sent; it is kept as the run log${opts.taskId ? ` (tasks/${opts.taskId}.md)` : ''}. ` +
      'End with one short line saying what you did.',
  );
  return lines.join('\n');
}

/**
 * Pipe `text` through `command`. Returns its trimmed stdout, or null when the
 * command fails or prints nothing (the caller keeps the model text then).
 */
export function runRender(command: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      ['-c', command],
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: RENDER_MAX_BUFFER, env: process.env },
      (error, stdout, stderr) => {
        if (stderr) log(`render stderr: ${stderr.slice(0, 500)}`);
        if (error) {
          log(
            (error as { killed?: boolean }).killed
              ? `render timed out after ${RENDER_TIMEOUT_MS}ms`
              : `render failed: ${error.message}`,
          );
          return resolve(null);
        }
        const out = stdout.trim();
        if (!out) log('render printed nothing');
        resolve(out || null);
      },
    );
    child.stdin?.on('error', () => {
      /* the command exited without reading stdin; its result decides */
    });
    child.stdin?.end(text);
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) attrs[match[1]] = match[2];
  return attrs;
}

async function deliverCard(to: string, title: string, body: string, routing: RoutingContext): Promise<boolean> {
  const dest = findByName(to);
  if (!dest || dest.type !== 'channel' || !dest.platformId || !dest.channelType) {
    log(`<card to="${to}"> names no channel destination — not delivered`);
    return false;
  }
  if (!title || !body) {
    log(`<card to="${to}"> needs a title and a body — not delivered`);
    return false;
  }
  const thread = resolveDestinationThread(dest.channelType, dest.platformId, routing);
  await writeMessageOut({
    id: generateId(),
    in_reply_to: thread?.inReplyTo ?? null,
    kind: 'chat-sdk',
    platform_id: dest.platformId,
    channel_type: dest.channelType,
    thread_id: thread?.threadId ?? null,
    content: JSON.stringify({ type: 'card', card: { title, description: body }, fallbackText: `${title}\n\n${body}` }),
  });
  return true;
}

/**
 * Deliver every door block in a lean turn's final text and return the text
 * with each block replaced by a one-line record of what happened to it — the
 * run log keeps the record, and no block reaches the loop's own result door.
 */
export async function applyResultDoors(text: string, routing: RoutingContext, render?: string): Promise<string> {
  const source = ((render ? await runRender(render, text) : null) ?? text).replace(INTERNAL_SPAN_RE, '');
  // Core delivery for chat messages; the routing is marked non-task so the
  // result door sends instead of keeping task-run blocks inert.
  const deliveryRouting: RoutingContext = { ...routing, taskRun: false };

  let out = '';
  let last = 0;
  for (const match of source.matchAll(DOOR_RE)) {
    out += source.slice(last, match.index);
    last = match.index + match[0].length;
    const [, kind, rawAttrs, rawBody] = match;
    const { to = '', title = '' } = parseAttrs(rawAttrs);
    const body = rawBody.trim();
    if (kind === 'message') {
      const block = `<message to="${to}">${body}</message>`;
      const { sent } = await dispatchResultText(block, deliveryRouting);
      out += `[${sent > 0 ? 'sent' : 'not delivered'} → ${to}] ${body}`;
    } else {
      const sent = await deliverCard(to, title.trim(), body, routing);
      out += `[card ${sent ? 'sent' : 'not delivered'} → ${to}] ${title}`;
    }
  }
  return out + source.slice(last);
}
