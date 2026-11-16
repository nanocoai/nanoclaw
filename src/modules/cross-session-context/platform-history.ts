/**
 * Platform history — the step after the backfill.
 *
 * An agent tagged in a thread has not seen the thread's lines that were not
 * addressed to it: a wiring that wakes on tags drops them, and a brand-new
 * session has seen nothing. When the install names the chat's channel type in
 * NANOCLAW_PLATFORM_HISTORY and its adapter can read history, those lines are
 * read back from the platform and written as ONE context-only row before the
 * trigger (a prompt takes a bounded number of rows, so a block of many lines
 * must be one row).
 *
 * Only lines the session has not seen, matched exactly by the platform's
 * message id: not a message it holds, not a line an earlier block showed, not
 * one the backfill seeded, not its own delivered reply, not the trigger. A
 * line whose sender the chat's access rules would refuse is left out, and the
 * block says how many were. Bounded by PLATFORM_HISTORY_BUDGET_MS: a read that
 * runs longer writes its block when it lands, to ride with the next message.
 * Never throws.
 */
import type { HistoryLine } from '../../channels/adapter.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { PLATFORM_HISTORY_CHANNELS } from '../../config.js';
import { getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import { wouldAdmitSender } from '../permissions/access.js';
import {
  ECHO_CHANNEL_TYPE,
  PLATFORM_HISTORY_BUDGET_MS,
  THREAD_HISTORY_LIMIT,
  THREAD_HISTORY_SURFACE,
} from './config.js';
import { truncateEchoText } from './fan.js';

/**
 * Newest session rows searched for what the session already has. The newest
 * 100 lines of a thread are at most 100 held rows; the rest of the window is
 * room for copies, notes and tool replies between them. Too small a window
 * repeats a line, never loses one.
 */
const OWN_ROWS_SCAN = 500;

/** How long a read that outlived its budget keeps new reads of its thread waiting. */
const READ_HOLD_MS = 30_000;

export interface PlatformHistoryOptions {
  /** The session was created for the very message about to be written. */
  created: boolean;
  /** The message about to be written: left out of the block, and its id keys the block. */
  trigger: { id: string; timestamp: string };
}

/**
 * Threads whose last read outlived its budget and is still running. A tag
 * there skips the read, so a slow platform never stacks up reads; the running
 * read still writes its block when it lands.
 */
const overdueReads = new Map<string, Promise<unknown>>();

function holdWhileRunning(key: string, work: Promise<unknown>): void {
  overdueReads.set(key, work);
  const release = () => {
    if (overdueReads.get(key) === work) overdueReads.delete(key);
  };
  work.then(release, release);
  setTimeout(release, READ_HOLD_MS).unref();
}

/** Whether every message of a thread already reaches the wiring's session. */
function takesEveryMessage(wiring: MessagingGroupAgent): boolean {
  return (
    wiring.ignored_message_policy === 'accumulate' ||
    wiring.engage_mode === 'mention-sticky' ||
    (wiring.engage_mode === 'pattern' && (wiring.engage_pattern ?? '.') === '.')
  );
}

/** Resolves undefined when `work` has not settled within `ms`. */
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

interface BlockContent {
  echo?: { surface?: string };
  triggerId?: unknown;
  lines?: Array<{ id?: unknown }>;
  withheldIds?: unknown[];
  platformMessageId?: unknown;
  id?: unknown;
}

/**
 * Platform ids the session already has, and whether this trigger already has
 * its block. Held messages carry the platform id as `id` (the chat library's
 * serialized message); seeded rows and delivered replies carry it as
 * `platformMessageId`.
 */
async function readSeen(agentGroupId: string, sessionId: string, triggerId: string) {
  const rows = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => ({
    inbound: mailbox.getInboundHistory(OWN_ROWS_SCAN),
    outbound: mailbox.getOutboundHistory(OWN_ROWS_SCAN),
  }));
  const seen = new Set<string>();
  let hasBlock = false;
  for (const row of rows?.outbound ?? []) {
    if (row.platformMessageId) seen.add(row.platformMessageId);
  }
  for (const row of rows?.inbound ?? []) {
    let content: BlockContent;
    try {
      content = JSON.parse(row.content) as BlockContent;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a row that is not JSON holds no platform id
    } catch {
      continue;
    }
    if (content.echo?.surface === THREAD_HISTORY_SURFACE) {
      if (content.triggerId === triggerId) hasBlock = true;
      for (const line of content.lines ?? []) if (typeof line.id === 'string') seen.add(line.id);
      for (const id of content.withheldIds ?? []) if (typeof id === 'string') seen.add(id);
    } else if (typeof content.platformMessageId === 'string') {
      seen.add(content.platformMessageId);
    } else if (!content.echo && typeof content.id === 'string') {
      seen.add(content.id);
    }
  }
  return { seen, hasBlock };
}

interface Look {
  /** Unseen lines from admitted senders, oldest first. */
  kept: HistoryLine[];
  /** Unseen lines whose sender the chat's access rules refuse. */
  withheld: HistoryLine[];
}

const NOTHING: Look = { kept: [], withheld: [] };

/** The unseen lines before the trigger, split by whether the sender is admitted. */
async function unseenLines(
  lines: HistoryLine[],
  seen: Set<string>,
  trigger: PlatformHistoryOptions['trigger'],
  mg: MessagingGroup,
  wiring: MessagingGroupAgent,
): Promise<Look> {
  const triggerAt = Date.parse(trigger.timestamp);
  const unseen = lines.filter(
    (line) =>
      line.id !== trigger.id && line.text.length > 0 && Date.parse(line.timestamp) <= triggerAt && !seen.has(line.id),
  );
  const decisions = new Map<string, Promise<boolean>>();
  const admits = (line: HistoryLine): Promise<boolean> => {
    if (line.isSelf) return Promise.resolve(true);
    const userId = line.senderId.includes(':') ? line.senderId : `${mg.channel_type}:${line.senderId}`;
    let decision = decisions.get(userId);
    if (!decision) {
      decision = wouldAdmitSender(userId, mg, wiring);
      decisions.set(userId, decision);
    }
    return decision;
  };
  const verdicts = await Promise.all(unseen.map(admits));
  return {
    kept: unseen.filter((_, i) => verdicts[i]).slice(-THREAD_HISTORY_LIMIT),
    withheld: unseen.filter((_, i) => !verdicts[i]),
  };
}

function blockContent({ kept, withheld }: Look, triggerId: string): string {
  const last = kept.length - 1;
  return JSON.stringify({
    text: `Earlier talk in this thread (${kept.length} lines, ${withheld.length} left out)`,
    triggerId,
    withheld: withheld.length,
    withheldIds: withheld.map((line) => line.id),
    lines: kept.map((line, i) => ({
      id: line.id,
      sender: line.senderName,
      time: line.timestamp,
      // The oldest and newest lines shown are kept whole, the rest capped.
      text: i === 0 || i === last ? line.text.slice(0, 4000) : truncateEchoText(line.text),
      ...(line.isSelf ? { self: true } : {}),
    })),
    echo: { surface: THREAD_HISTORY_SURFACE, label: 'this thread' },
  });
}

async function writeBlock(
  agentGroupId: string,
  sessionId: string,
  trigger: PlatformHistoryOptions['trigger'],
  look: Look,
): Promise<void> {
  if (look.kept.length === 0 && look.withheld.length === 0) return;
  await withMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.insertMessage({
      id: `${sessionId}:thread-history:${trigger.id}`,
      kind: 'chat',
      timestamp: trigger.timestamp,
      platformId: null,
      channelType: ECHO_CHANNEL_TYPE,
      threadId: null,
      content: blockContent(look, trigger.id),
      processAfter: null,
      recurrence: null,
      trigger: false,
      sourceSessionId: null,
      onWake: false,
    }),
  );
  log.debug('Wrote platform thread history', { sessionId, lines: look.kept.length, withheld: look.withheld.length });
}

export async function backfillPlatformHistory(
  agentGroup: AgentGroup,
  session: Session,
  mg: MessagingGroup,
  options: PlatformHistoryOptions,
): Promise<void> {
  if (!PLATFORM_HISTORY_CHANNELS.has(mg.channel_type)) return;
  try {
    const threadId = session.thread_id;
    if (threadId === null || isTaskThread(threadId)) return;
    const instance = mg.instance ?? mg.channel_type;
    const adapter = getChannelAdapterExact(instance);
    const readHistory = adapter?.readHistory?.bind(adapter);
    if (!readHistory) return;
    const key = `${instance}\n${threadId}`;
    if (overdueReads.has(key)) return;

    const look = (async (): Promise<Look> => {
      const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroup.id);
      if (!wiring || (!options.created && takesEveryMessage(wiring))) return NOTHING;
      const lines = await readHistory(mg.platform_id, threadId, { limit: THREAD_HISTORY_LIMIT });
      // A full window without the trigger is not the thread's newest lines
      // (a platform that pages from the oldest): showing it would mislead.
      if (lines.length >= THREAD_HISTORY_LIMIT && !lines.some((line) => line.id === options.trigger.id)) {
        log.warn('Platform history skipped: the read did not reach the newest lines', { sessionId: session.id });
        return NOTHING;
      }
      // After the platform read, so whatever landed meanwhile counts as seen.
      const { seen, hasBlock } = await readSeen(agentGroup.id, session.id, options.trigger.id);
      return hasBlock ? NOTHING : unseenLines(lines, seen, options.trigger, mg, wiring);
    })();
    const found = await within(look, PLATFORM_HISTORY_BUDGET_MS);
    if (found === undefined) {
      log.warn('Platform history is slow; its block will follow the message', { sessionId: session.id });
      const late = look.then((result) => writeBlock(agentGroup.id, session.id, options.trigger, result));
      late.catch((err: unknown) => log.warn('Platform history failed (continuing without it)', { err }));
      holdWhileRunning(key, late);
      return;
    }
    await writeBlock(agentGroup.id, session.id, options.trigger, found);
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the trigger is written either way
  } catch (err) {
    log.warn('Platform history failed (continuing without it)', { sessionId: session.id, err });
  }
}
