/**
 * Wake context — the seam for adding context to a waking session.
 *
 * A module registers a provider. When an engaged message wakes a session, the
 * router calls every provider after the cross-session backfill and before the
 * message is written. A provider returns blocks of lines; each block becomes
 * one context-only row, which the container renders as `<tag about="...">`
 * with one line element per line, so the agent reads it with the message.
 *
 * Core owns what every provider needs: one time budget for all of them (a
 * person is waiting for the reply), isolation (a provider that throws or hangs
 * costs only its own blocks), one row per block per message, and the write. A
 * provider that misses the budget has its blocks written when it lands; they
 * ride with the next message. With nothing registered this does nothing.
 */
import { log } from './log.js';
import { ECHO_CHANNEL_TYPE } from './modules/cross-session-context/index.js';
import { withMailboxSession } from './session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from './types.js';

export interface WakeContextInput {
  agentGroup: AgentGroup;
  session: Session;
  /** The chat the message arrived on. */
  mg: MessagingGroup;
  /** The session was created for this message. */
  created: boolean;
  /** The message about to be written. */
  trigger: { id: string; timestamp: string };
}

export interface ContextLine {
  /** Platform message id, when known. */
  id?: string;
  sender: string;
  /** ISO timestamp. */
  time: string;
  text: string;
  /** Written by the agent itself; shown as "you". */
  self?: boolean;
}

export interface ContextBlock {
  /** Names the block among a provider's; with the message id it keys the block's row. */
  key: string;
  /** Element name the agent sees: lowercase letters and dashes. */
  tag: string;
  /** What the block holds, told to the agent with it. */
  about: string;
  lines: ContextLine[];
  /** Platform ids the provider chose not to show; kept on the row so a later wake can skip them. */
  withheldIds?: string[];
}

export type WakeContextProvider = (input: WakeContextInput) => Promise<ContextBlock[]>;

/** The longest wake context may hold up the message that woke the agent. */
export const WAKE_CONTEXT_BUDGET_MS = 1500;

/** How long a provider still running from an earlier wake keeps it out of this session's next wakes. */
const RUNNING_HOLD_MS = 30_000;

export const CONTEXT_BLOCK_TAG = /^[a-z][a-z-]{0,39}$/;

const providers: WakeContextProvider[] = [];
const running = new Map<string, Promise<unknown>>();

export function registerWakeContext(provider: WakeContextProvider): void {
  providers.push(provider);
}

function holdWhileRunning(key: string, work: Promise<unknown>): void {
  running.set(key, work);
  const release = () => {
    if (running.get(key) === work) running.delete(key);
  };
  work.then(release, release);
  setTimeout(release, RUNNING_HOLD_MS).unref();
}

async function writeBlocks(input: WakeContextInput, blocks: ContextBlock[]): Promise<void> {
  const rows = blocks.filter((block) => {
    if (!CONTEXT_BLOCK_TAG.test(block.tag)) {
      log.warn('Wake context block dropped: invalid tag', { sessionId: input.session.id, tag: block.tag });
      return false;
    }
    return block.lines.length > 0 || (block.withheldIds?.length ?? 0) > 0;
  });
  if (rows.length === 0) return;
  await withMailboxSession(input.agentGroup.id, input.session.id, async (mailbox) => {
    for (const block of rows) {
      try {
        await mailbox.insertMessage({
          // One row per block per message: a redelivered message collides here.
          id: `${input.session.id}:wake-context:${block.key}:${input.trigger.id}`,
          kind: 'chat',
          timestamp: input.trigger.timestamp,
          platformId: null,
          channelType: ECHO_CHANNEL_TYPE,
          threadId: null,
          content: JSON.stringify({ text: block.about, triggerId: input.trigger.id, block }),
          processAfter: null,
          recurrence: null,
          trigger: false,
          sourceSessionId: null,
          onWake: false,
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- one block failing must not cost the others
      } catch (err) {
        log.warn('Wake context block not written (it may already be there)', {
          sessionId: input.session.id,
          key: block.key,
          err,
        });
      }
    }
  });
}

/**
 * Run every registered provider for a waking session and write their blocks
 * before the message. Never throws; returns once the blocks that made the
 * budget are written.
 */
export async function gatherWakeContext(
  input: WakeContextInput,
  budgetMs: number = WAKE_CONTEXT_BUDGET_MS,
): Promise<void> {
  if (providers.length === 0) return;
  try {
    const calls = providers.map((provider, i) => {
      const key = `${i}\n${input.session.id}`;
      if (running.has(key)) return null;
      const blocks = Promise.resolve()
        .then(() => provider(input))
        .catch((err: unknown) => {
          log.warn('Wake context provider failed (continuing without it)', { sessionId: input.session.id, err });
          return [] as ContextBlock[];
        });
      return { key, blocks };
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    });
    const onTime = await Promise.all(
      calls.map((call) => (call ? Promise.race([call.blocks, deadline]) : Promise.resolve([] as ContextBlock[]))),
    );
    clearTimeout(timer);
    await writeBlocks(
      input,
      onTime.flatMap((blocks) => blocks ?? []),
    );

    calls.forEach((call, i) => {
      if (!call || onTime[i] !== undefined) return;
      log.warn('Wake context is slow; its blocks will follow the message', { sessionId: input.session.id });
      const late = call.blocks.then((blocks) => writeBlocks(input, blocks));
      late.catch((err: unknown) => log.warn('Wake context failed (continuing without it)', { err }));
      holdWhileRunning(call.key, late);
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the message is written either way
  } catch (err) {
    log.warn('Wake context failed (continuing without it)', { sessionId: input.session.id, err });
  }
}
