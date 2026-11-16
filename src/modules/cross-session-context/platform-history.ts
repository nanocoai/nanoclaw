/**
 * Platform history — the step after the backfill.
 *
 * An agent tagged in a thread has not seen the thread's lines that were not
 * addressed to it: a wiring that wakes on tags drops them, and a brand-new
 * session has seen nothing. When the install opts in (NANOCLAW_PLATFORM_HISTORY)
 * and the chat's adapter can read history, those lines are read back from the
 * platform and written as ONE context-only row before the trigger (a prompt
 * takes a bounded number of rows, so a block of many lines must be one row).
 *
 * Only lines the session has not seen: newer than this thread's newest row,
 * not the trigger, not a line the backfill already seeded (matched by the
 * platform's message id), and not a line whose sender the chat's access rules
 * would refuse. Bounded by PLATFORM_HISTORY_BUDGET_MS. Never throws.
 */
import type { HistoryLine } from '../../channels/adapter.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { PLATFORM_HISTORY } from '../../config.js';
import { getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import { wouldAdmitSender } from '../permissions/access.js';
import {
  ECHO_BACKLOG_CAP,
  ECHO_CHANNEL_TYPE,
  PLATFORM_HISTORY_BUDGET_MS,
  THREAD_HISTORY_LIMIT,
  THREAD_HISTORY_SURFACE,
} from './config.js';
import { BACKFILL_LIMIT } from './backfill.js';
import { truncateEchoText } from './fan.js';

/** Rows past this thread's newest real row: the pending echo backlog plus the backfill's seed. */
const OWN_ROWS_SCAN = ECHO_BACKLOG_CAP + BACKFILL_LIMIT + 1;

export interface PlatformHistoryOptions {
  /** The session was created for the very message about to be written. */
  created: boolean;
  /** The message about to be written: left out of the block, and its id keys the block. */
  trigger: { id: string; timestamp: string };
}

/** Whether every message of a thread already reaches the wiring's session. */
function takesEveryMessage(wiring: MessagingGroupAgent): boolean {
  return (
    wiring.ignored_message_policy === 'accumulate' ||
    wiring.engage_mode === 'mention-sticky' ||
    (wiring.engage_mode === 'pattern' && (wiring.engage_pattern ?? '.') === '.')
  );
}

/**
 * One platform read per thread at a time. A read that outlives its deadline
 * is left to finish, so the names it looked up stay cached for the next tag,
 * and a tag arriving meanwhile waits on it instead of starting another. A read
 * that never settles stops blocking new ones after READ_HOLD_MS.
 */
const READ_HOLD_MS = 30_000;
const readsInFlight = new Map<string, Promise<HistoryLine[]>>();

function readOnce(key: string, read: () => Promise<HistoryLine[]>): Promise<HistoryLine[]> {
  let pending = readsInFlight.get(key);
  if (!pending) {
    const started = read();
    pending = started;
    readsInFlight.set(key, started);
    const done = () => {
      if (readsInFlight.get(key) === started) readsInFlight.delete(key);
    };
    started.then(done, done);
    setTimeout(done, READ_HOLD_MS).unref();
  }
  return pending;
}

/** Resolves undefined when `work` has not settled within `ms`; a late rejection is dropped. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the session already holds: its newest real row's time, and the platform ids of seeded rows. */
async function readOwnRows(agentGroupId: string, sessionId: string): Promise<{ floor: number; seen: Set<string> }> {
  const rows = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.getInboundHistory(OWN_ROWS_SCAN),
  );
  let floor = Number.NEGATIVE_INFINITY;
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    let content: { echo?: unknown; platformMessageId?: unknown };
    try {
      content = JSON.parse(row.content) as typeof content;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a row that is not JSON is neither a floor nor a seeded line
    } catch {
      continue;
    }
    if (typeof content.platformMessageId === 'string') seen.add(content.platformMessageId);
    if (floor === Number.NEGATIVE_INFINITY && !content.echo && (row.kind === 'chat' || row.kind === 'chat-sdk')) {
      floor = Date.parse(row.timestamp);
    }
  }
  return { floor, seen };
}

function userIdOf(line: HistoryLine, channelType: string): string {
  return line.senderId.includes(':') ? line.senderId : `${channelType}:${line.senderId}`;
}

export async function backfillPlatformHistory(
  agentGroup: AgentGroup,
  session: Session,
  mg: MessagingGroup,
  options: PlatformHistoryOptions,
): Promise<void> {
  if (!PLATFORM_HISTORY) return;
  try {
    const threadId = session.thread_id;
    if (threadId === null || isTaskThread(threadId)) return;
    const instance = mg.instance ?? mg.channel_type;
    const adapter = getChannelAdapterExact(instance);
    const readHistory = adapter?.readHistory?.bind(adapter);
    if (!readHistory) return;
    const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroup.id);
    if (!wiring || (!options.created && takesEveryMessage(wiring))) return;

    const [lines, own] = await Promise.all([
      within(
        readOnce(`${instance}\n${threadId}`, () =>
          readHistory(mg.platform_id, threadId, { limit: THREAD_HISTORY_LIMIT + 1 }),
        ),
        PLATFORM_HISTORY_BUDGET_MS,
      ),
      readOwnRows(agentGroup.id, session.id),
    ]);
    if (!lines) {
      log.warn('Platform history read timed out (continuing without it)', { sessionId: session.id });
      return;
    }

    const triggerAt = Date.parse(options.trigger.timestamp);
    const admitted = new Map<string, Promise<boolean>>();
    const admits = (line: HistoryLine): Promise<boolean> => {
      if (line.isSelf) return Promise.resolve(true);
      const userId = userIdOf(line, mg.channel_type);
      let decision = admitted.get(userId);
      if (!decision) {
        decision = wouldAdmitSender(userId, mg, wiring);
        admitted.set(userId, decision);
      }
      return decision;
    };
    const unseen = lines.filter((line) => {
      const at = Date.parse(line.timestamp);
      return (
        line.id !== options.trigger.id &&
        line.text.length > 0 &&
        at > own.floor &&
        at <= triggerAt &&
        !own.seen.has(line.id)
      );
    });
    const verdicts = await Promise.all(unseen.map(admits));
    const kept = unseen.filter((_, i) => verdicts[i]).slice(-THREAD_HISTORY_LIMIT);
    if (kept.length === 0) return;

    const last = kept.length - 1;
    const content = JSON.stringify({
      text: `Earlier talk in this thread (${kept.length} lines)`,
      lines: kept.map((line, i) => ({
        sender: line.senderName,
        senderId: line.senderId,
        time: line.timestamp,
        // The first line usually says what the thread is about and the newest
        // is what the trigger answers: both whole, the rest capped.
        text: i === 0 || i === last ? line.text.slice(0, 4000) : truncateEchoText(line.text),
        ...(line.isSelf ? { self: true } : {}),
      })),
      echo: { surface: THREAD_HISTORY_SURFACE, label: 'this thread' },
    });
    await withMailboxSession(agentGroup.id, session.id, (mailbox) =>
      mailbox.insertMessage({
        // One block per trigger: a redelivered trigger collides here and adds nothing.
        id: `${session.id}:thread-history:${options.trigger.id}`,
        kind: 'chat',
        timestamp: options.trigger.timestamp,
        platformId: null,
        channelType: ECHO_CHANNEL_TYPE,
        threadId: null,
        content,
        processAfter: null,
        recurrence: null,
        trigger: false,
        sourceSessionId: null,
        onWake: false,
      }),
    );
    log.debug('Wrote platform thread history', { sessionId: session.id, lines: kept.length });
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the trigger is written either way
  } catch (err) {
    log.warn('Platform history failed (continuing without it)', { sessionId: session.id, err });
  }
}
