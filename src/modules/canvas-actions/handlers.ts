/**
 * Delivery-action handlers for agent canvas access: `canvas_edit`
 * (fire-and-forget section-scoped edits) and `canvas_read` (blocking
 * read-back the container tool polls for).
 *
 * Both act AS the session's own Slack bot identity: session →
 * messaging group → adapter instance → the instance's bot token from
 * .env (the SLACK_BOT_TOKEN / SLACK_BOT_TOKEN_<SUFFIX> key convention
 * from src/channels/slack-lib.ts). No privileged effect: the
 * agent can only touch canvases its own bot can already see.
 *
 * Outcome plumbing differs by action — this is load-bearing:
 *
 * - `canvas_read` outcomes are `kind:'system'` rows carrying `requestId`;
 *   the container tool polls inbound.db for exactly that row and consumes
 *   it. They never trigger a wake (the requester is already polling) and
 *   the poll loop deliberately filters system rows out of agent prompts.
 * - `canvas_edit` outcomes are `kind:'chat'` system notes (sender
 *   'system', channelType 'agent') — the membership-note shape. NOT
 *   `kind:'system'`: nothing polls for them, and the poll loop would
 *   filter them out of every batch, so the agent would never learn an
 *   edit failed (and an unconsumed triggering system row keeps the session
 *   permanently "due" for the host sweep — wake churn). As chat rows they
 *   render like any message: successes are non-triggering (ambient, next
 *   wake); failures trigger so the agent wakes to correct course —
 *   it already told the user the edit was submitted.
 */
import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { readEnvValue } from '../../env-file.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  editCanvas,
  fetchCanvasHtml,
  fetchCanvasText,
  htmlToReadableText,
  lookupCanvasSection,
  resolveHeadingRegion,
  type CanvasChange,
  type HeadingRegion,
} from './canvas-api.js';

const CANVAS_EDIT_OPS = ['append', 'replace_section', 'insert_after_section'] as const;
type CanvasEditOp = (typeof CANVAS_EDIT_OPS)[number];

/**
 * The session's own Slack bot token: session → mg → instance → .env.
 * Error strings are agent-facing — they name the key, never the value.
 */
export async function resolveSessionBotToken(session: Session): Promise<{ token: string } | { error: string }> {
  if (!session.messaging_group_id) {
    return { error: 'session has no messaging group — cannot resolve a Slack bot identity' };
  }
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    return { error: `messaging group ${session.messaging_group_id} not found` };
  }
  if (mg.channel_type !== 'slack') {
    return { error: `canvas actions need a Slack session (this session's channel is ${mg.channel_type})` };
  }
  const instanceKey = mg.instance ?? 'slack';
  const tokenKey = botTokenKeyForInstance(instanceKey);
  const token = readEnvValue(process.cwd(), tokenKey);
  if (!token) {
    return { error: `missing ${tokenKey} in .env for instance '${instanceKey}'` };
  }
  return { token };
}

/** First ATX heading in a markdown fragment (raw text, trimmed), or null. */
function firstMarkdownHeading(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const m = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Heading texts present in a canvas read-back (the htmlToReadableText shape:
 * headings are `#`-prefixed lines), normalized for comparison (lowercased,
 * trimmed).
 */
function readBackHeadings(text: string): Set<string> {
  const headings = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) headings.add(m[1].trim().toLowerCase());
  }
  return headings;
}

/** canvas_read outcome — a system row the container tool polls for by requestId. */
async function writeCanvasResponse(
  session: Session,
  args: {
    requestId: string;
    action: 'canvas_read';
    status: 'ok' | 'error';
    result: Record<string, unknown>;
  },
): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `canvas-resp-${args.requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({
      type: 'canvas_response',
      requestId: args.requestId,
      action: args.action,
      status: args.status,
      result: args.result,
    }),
    processAfter: null,
    recurrence: null,
    trigger: false,
  });
}

/**
 * canvas_edit outcome — a renderable chat note (membership-note shape).
 * Triggering failures wake the agent with the reason; non-triggering successes
 * ride along as ambient context on the next wake.
 */
async function writeCanvasEditNote(
  session: Session,
  args: { requestId: string; text: string; trigger: boolean },
): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `canvas-resp-${args.requestId}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: args.text, sender: 'system', senderId: 'system' }),
    processAfter: null,
    recurrence: null,
    trigger: args.trigger,
  });
}

export async function handleCanvasEdit(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId =
    typeof content.requestId === 'string' && content.requestId ? content.requestId : `canvas-${Date.now()}`;
  const canvasId = typeof content.canvas_id === 'string' ? content.canvas_id : '';
  const op = content.op as CanvasEditOp;
  const markdown = typeof content.markdown === 'string' ? content.markdown : '';
  const sectionText = typeof content.section_text === 'string' ? content.section_text : '';

  const editLabel = `${typeof op === 'string' && op ? op : 'canvas_edit'}${
    canvasId ? ` on canvas ${canvasId}` : ''
  }${sectionText ? `, section "${sectionText}"` : ''}`;
  const fail = async (message: string): Promise<void> => {
    log.warn('canvas_edit failed', { sessionId: session.id, requestId, error: message });
    await writeCanvasEditNote(session, {
      requestId,
      text: `Canvas edit FAILED (${editLabel}): ${message}`,
      trigger: true,
    });
  };
  const succeed = async (note?: string): Promise<void> => {
    await writeCanvasEditNote(session, {
      requestId,
      text: `Canvas edit applied (${editLabel}).${note ? ` ${note}` : ''}`,
      trigger: false,
    });
  };

  if (!canvasId || !markdown || !CANVAS_EDIT_OPS.includes(op)) {
    await fail(`canvas_edit needs canvas_id, markdown, and op (one of ${CANVAS_EDIT_OPS.join(', ')})`);
    return;
  }
  if (op !== 'append' && !sectionText) {
    // The safe-op invariant: a section-targeted op without lookup criteria
    // can never fall through to an unsectioned (whole-doc) replace.
    await fail(`${op} requires section_text (text the target section contains)`);
    return;
  }

  const auth = await resolveSessionBotToken(session);
  if ('error' in auth) {
    await fail(auth.error);
    return;
  }

  // One HTML read-back serves both the duplicate-heading guard and region
  // resolution. Best-effort: an unreadable canvas skips the guard and falls
  // back to single-block sections.lookup — never block an edit on a read
  // failure.
  let html: string | null = null;
  if (op !== 'append' || firstMarkdownHeading(markdown)) {
    try {
      html = await fetchCanvasHtml(auth.token, canvasId);
    } catch {
      /* unreadable canvas → no guard, lookup fallback */
    }
  }

  // Duplicate-heading guard (B4): an insert op (append / insert_after_section)
  // whose markdown opens with a heading the canvas already has is almost always
  // a misfired update — refuse and point at replace_section.
  if (op !== 'replace_section' && html) {
    const newHeading = firstMarkdownHeading(markdown);
    if (newHeading && readBackHeadings(htmlToReadableText(html)).has(newHeading.toLowerCase())) {
      await fail(
        `${op} refused: the canvas already has a "${newHeading}" section — inserting would create a duplicate heading. Use replace_section with section_text "${newHeading}" to update that section instead.`,
      );
      return;
    }
  }

  // Live-probed platform limit: canvases.edit markdown IGNORES `- [x]` —
  // every path (insert, section replace, item replace) lands unticked, so
  // tick state is UI-only and a checklist rewrite RESETS it. Landing the
  // edit and hiding that would be a silent lie; the note triggers so
  // the agent can adjust (item-level edits preserve ticks).
  const tickWarnings: string[] = [];
  if (/^\s*[-*]\s+\[[xX]\]\s/m.test(markdown)) {
    tickWarnings.push(
      'the [x] states in your markdown were NOT applied — the canvas API cannot set tick state; those items landed unticked',
    );
  }
  const finish = async (note?: string): Promise<void> => {
    if (tickWarnings.length === 0) {
      await succeed(note);
      return;
    }
    await writeCanvasEditNote(session, {
      requestId,
      text: `Canvas edit applied (${editLabel}), BUT ${tickWarnings.join('; also ')}.${note ? ` ${note}` : ''} To preserve or mark checklist state, edit items individually (see the canvas-work skill) and leave ticking to humans.`,
      trigger: true,
    });
  };

  try {
    if (op === 'append') {
      await editCanvas(auth.token, canvasId, { operation: 'insert_at_end', markdown });
      log.info('canvas_edit applied', { sessionId: session.id, requestId, canvasId, op });
      await finish();
      return;
    }

    // Section-scoped ops. Slack "sections" are individual BLOCKS — a heading
    // and its body are separate sections — so a heading-matched op must cover
    // the whole heading REGION or the old body is left behind (live-observed
    // as a duplicated section). When section_text names a heading, resolve
    // the region from the HTML export; otherwise (or when the read-back
    // failed) fall back to the original single-block lookup.
    const region: HeadingRegion | null = html ? resolveHeadingRegion(html, sectionText) : null;
    if (op === 'replace_section' && region && region.checkedItemCount > 0) {
      tickWarnings.push(
        `${region.checkedItemCount} ticked item(s) in the old section lost their tick state — rewrites reset checkboxes (tick state is UI-only)`,
      );
    }

    if (region && op === 'replace_section') {
      // Replace the heading block FIRST (the new content lands), then delete
      // the old body. canvases.edit takes one change per call, so a
      // mid-sequence failure leaves a partial duplicate plus an error nudge —
      // never content loss.
      await editCanvas(auth.token, canvasId, { operation: 'replace', sectionId: region.headingId, markdown });
      let deleted = 0;
      try {
        for (const id of region.bodyIds) {
          await editCanvas(auth.token, canvasId, { operation: 'delete', sectionId: id });
          deleted++;
        }
      } catch (err) {
        await fail(
          `replace_section partially applied: the new content is in place but ${region.bodyIds.length - deleted} old block(s) of the previous section remain below it — read the canvas and remove the leftovers. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      log.info('canvas_edit applied', {
        sessionId: session.id,
        requestId,
        canvasId,
        op,
        blocksReplaced: region.bodyIds.length + 1,
      });
      await finish(
        region.hasUnaddressableBlocks
          ? 'Note: some blocks in the old section could not be addressed and were left in place — re-read to verify.'
          : undefined,
      );
      return;
    }

    if (region && op === 'insert_after_section') {
      // Insert after the END of the region (its last block), not after the
      // heading — inserting right after the heading splits the section body.
      await editCanvas(auth.token, canvasId, { operation: 'insert_after', sectionId: region.lastId, markdown });
      log.info('canvas_edit applied', { sessionId: session.id, requestId, canvasId, op });
      await finish();
      return;
    }

    // section_text does not name a heading (or the read-back failed):
    // single-block behavior via sections.lookup, as before.
    const sectionId = await lookupCanvasSection(auth.token, canvasId, sectionText);
    if (!sectionId) {
      await fail(
        `no section matching "${sectionText}" found in canvas ${canvasId} — re-read the canvas and retry with text the section actually contains`,
      );
      return;
    }
    const change: CanvasChange = {
      operation: op === 'replace_section' ? 'replace' : 'insert_after',
      sectionId,
      markdown,
    };
    await editCanvas(auth.token, canvasId, change);
    log.info('canvas_edit applied', { sessionId: session.id, requestId, canvasId, op });
    await finish();
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}

export async function handleCanvasRead(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId =
    typeof content.requestId === 'string' && content.requestId ? content.requestId : `canvas-${Date.now()}`;
  // Reader responses never wake: the container tool is already polling for
  // this row (errors included — a wake would double-charge the outcome).
  const respond = (status: 'ok' | 'error', result: Record<string, unknown>): Promise<void> => {
    return writeCanvasResponse(session, { requestId, action: 'canvas_read', status, result });
  };

  const canvasId = typeof content.canvas_id === 'string' ? content.canvas_id : '';
  if (!canvasId) {
    await respond('error', { error: 'canvas_read needs canvas_id' });
    return;
  }

  const auth = await resolveSessionBotToken(session);
  if ('error' in auth) {
    await respond('error', { error: auth.error });
    return;
  }

  try {
    const text = await fetchCanvasText(auth.token, canvasId);
    log.info('canvas_read served', { sessionId: session.id, requestId, canvasId, chars: text.length });
    await respond('ok', { canvas_id: canvasId, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('canvas_read failed', { sessionId: session.id, requestId, error: message });
    await respond('error', { error: message });
  }
}
