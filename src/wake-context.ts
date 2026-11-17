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
 * costs only its own blocks, and is not started again for a session while its
 * call is running), one row per block per message, the stored shape, the
 * write, and the session's message order while a message waits. Blocks that
 * miss the budget are written when they land; they ride with the next message.
 * With nothing registered this does nothing.
 */
import { log } from './log.js';
import { ECHO_CHANNEL_TYPE } from './modules/cross-session-context/index.js';
import { withMailboxSession } from './session-manager.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from './types.js';

export interface WakeContextInput {
  agentGroup: AgentGroup;
  session: Session;
  /** The chat the message arrived on. */
  mg: MessagingGroup;
  /** The wiring that engaged the message. */
  wiring: MessagingGroupAgent;
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
  /** Names the block among its provider's (lowercase letters, digits, dashes); keys the block's row. */
  key: string;
  /** Element name the agent sees: lowercase letters and dashes. */
  tag: string;
  /** What the block holds, told to the agent with it. */
  about: string;
  lines: ContextLine[];
  /** Kept on the row for the provider to read back at a later wake; never rendered. Must be JSON. */
  state?: unknown;
}

export type WakeContextProvider = (input: WakeContextInput) => Promise<ContextBlock[]>;

/** The longest wake context may hold up the message that woke the agent. */
export const WAKE_CONTEXT_BUDGET_MS = 1500;

export const CONTEXT_BLOCK_TAG = /^[a-z][a-z-]{0,39}$/;

/** Provider names and block keys: they join into row ids, so no separator can appear in them. */
const ID_PART = /^[a-z][a-z0-9-]{0,39}$/;

const providers: Array<{ name: string; provider: WakeContextProvider }> = [];
const running = new Set<string>();
const lastWrite = new Map<string, Promise<void>>();

/** Register a provider under a name unique among providers (lowercase letters, digits, dashes). */
export function registerWakeContext(name: string, provider: WakeContextProvider): void {
  if (!ID_PART.test(name)) throw new Error(`Wake context provider name must match ${ID_PART}: ${name}`);
  if (providers.some((entry) => entry.name === name))
    throw new Error(`Wake context provider registered twice: ${name}`);
  providers.push({ name, provider });
}

/**
 * Take a message's place in its session's write order as it arrives, so a
 * message waiting for wake context is not overtaken by a later one. Await
 * `previous` before the write and call `release` once it settles, whether it
 * succeeded or not. Orders nothing while no provider is registered.
 */
export function takeWriteTurn(sessionId: string): { previous?: Promise<void>; release: () => void } {
  if (providers.length === 0) return { release: () => {} };
  const previous = lastWrite.get(sessionId);
  let release = () => {};
  const mine = new Promise<void>((resolve) => (release = resolve));
  lastWrite.set(sessionId, mine);
  void mine.then(() => {
    if (lastWrite.get(sessionId) === mine) lastWrite.delete(sessionId);
  });
  return { previous, release };
}

/** The block as stored: the contract's fields and nothing else, without any line that is not one. Null if it is not a block. */
function storedBlock(block: ContextBlock): ContextBlock | null {
  if (
    typeof block?.key !== 'string' ||
    !ID_PART.test(block.key) ||
    typeof block.tag !== 'string' ||
    !CONTEXT_BLOCK_TAG.test(block.tag) ||
    typeof block.about !== 'string' ||
    !Array.isArray(block.lines)
  ) {
    return null;
  }
  const lines = block.lines
    .filter(
      (line) => typeof line?.sender === 'string' && typeof line.time === 'string' && typeof line.text === 'string',
    )
    .map(({ id, sender, time, text, self }): ContextLine => ({ id, sender, time, text, self }));
  return { key: block.key, tag: block.tag, about: block.about, lines, state: block.state };
}

interface NamedBlock {
  provider: string;
  block: ContextBlock;
}

async function writeBlocks(input: WakeContextInput, blocks: NamedBlock[]): Promise<void> {
  const rows = blocks.flatMap(({ provider, block }) => {
    const stored = storedBlock(block);
    if (!stored) log.warn('Wake context block dropped: not a valid block', { sessionId: input.session.id, provider });
    return stored && (stored.lines.length > 0 || stored.state !== undefined) ? [{ provider, block: stored }] : [];
  });
  if (rows.length === 0) return;
  await withMailboxSession(input.agentGroup.id, input.session.id, async (mailbox) => {
    for (const { provider, block } of rows) {
      try {
        await mailbox.insertMessage({
          // One row per block per message: a redelivered message collides here.
          id: `${input.session.id}:wake-context:${provider}:${block.key}:${input.trigger.id}`,
          kind: 'chat',
          timestamp: input.trigger.timestamp,
          platformId: null,
          channelType: ECHO_CHANNEL_TYPE,
          threadId: null,
          content: JSON.stringify({ text: block.about, block }),
          processAfter: null,
          recurrence: null,
          trigger: false,
          sourceSessionId: null,
          onWake: false,
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- one block failing must not cost the others
      } catch (err) {
        log.warn('Wake context block not written', {
          sessionId: input.session.id,
          provider,
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
    const calls = providers.map(({ name, provider }) => {
      const key = `${name}\n${input.session.id}`;
      if (running.has(key)) return null;
      const blocks = Promise.resolve()
        .then(() => provider(input))
        .catch((err: unknown) => {
          log.warn('Wake context provider failed (continuing without it)', {
            sessionId: input.session.id,
            provider: name,
            err,
          });
          return [] as ContextBlock[];
        });
      running.add(key);
      void blocks.then(() => running.delete(key));
      return { name, blocks };
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    });
    const onTime = await Promise.all(
      calls.map((call) => (call ? Promise.race([call.blocks, deadline]) : Promise.resolve([] as ContextBlock[]))),
    );
    clearTimeout(timer);
    const named = (name: string, blocks: ContextBlock[]): NamedBlock[] =>
      blocks.map((block) => ({ provider: name, block }));
    await writeBlocks(
      input,
      calls.flatMap((call, i) => (call && onTime[i] ? named(call.name, onTime[i]) : [])),
    );

    calls.forEach((call, i) => {
      if (!call || onTime[i] !== undefined) return;
      log.warn('Wake context is slow; its blocks will follow the message', {
        sessionId: input.session.id,
        provider: call.name,
      });
      call.blocks
        .then((blocks) => writeBlocks(input, named(call.name, blocks)))
        .catch((err: unknown) => log.warn('Wake context failed (continuing without it)', { err }));
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the message is written either way
  } catch (err) {
    log.warn('Wake context failed (continuing without it)', { sessionId: input.session.id, err });
  }
}
