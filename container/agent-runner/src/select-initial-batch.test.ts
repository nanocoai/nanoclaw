import { describe, expect, it } from 'bun:test';

import {
  mayEndQueryForDeferredFollowUps,
  selectInitialBatch,
  shouldDeferTaskFromChatTurn,
  supersedeCurrentChatPush,
  supersedeQueuedChatPushes,
} from './poll-loop.js';
import type { MessageInRow } from './db/messages-in.js';

// Pure batch-isolation covers two incidents:
//  - 2026-05-16 AI-Friends dream leak (chat folded into dream turn)
//  - 2026-05-25 Degenerate-Server silent-dream attribution (non-dream
//    task batched with the dream stole `assistant_text`)

function row(id: string, kind: MessageInRow['kind'], opts: { trigger?: 0 | 1; series_id?: string } = {}): MessageInRow {
  return {
    id,
    kind,
    trigger: opts.trigger ?? 1,
    series_id: opts.series_id ?? null,
    content: '',
  } as unknown as MessageInRow;
}

describe('selectInitialBatch', () => {
  it('runs a co-arriving operator note and user message in separate turns (first arrival first)', () => {
    const user = row('u1:ag-1', 'chat-sdk');
    const note = row('chief-nudge:appr-1', 'chat');
    const ambient = row('a1', 'chat-sdk', { trigger: 0 });
    const userFirst = selectInitialBatch([user, note, ambient]);
    expect(userFirst.batch.map((m) => m.id)).toEqual(['u1:ag-1', 'a1']);
    expect(userFirst.logs.join('\n')).toContain('deferring 1 row(s)');
    const noteFirst = selectInitialBatch([note, user, ambient]);
    expect(noteFirst.batch.map((m) => m.id)).toEqual(['chief-nudge:appr-1']);
    // Notes alone, or users alone, are unchanged.
    expect(selectInitialBatch([note]).logs).toEqual([]);
    expect(selectInitialBatch([user, ambient]).batch).toEqual([user, ambient]);
    // Only a trigger note splits; a same-id prefix on another kind does not.
    expect(selectInitialBatch([user, row('chief-nudge:x', 'chat-sdk')]).logs).toEqual([]);
  });

  it('runs co-arriving triggers from two senders as separate turns (first sender first)', () => {
    const from = (id: string, senderId: string, trigger: 0 | 1 = 1): MessageInRow =>
      ({
        ...row(id, 'chat-sdk', { trigger }),
        channel_type: 'discord',
        content: JSON.stringify({ senderId }),
      }) as MessageInRow;
    const a1 = from('a1', 'alice');
    const b1 = from('b1', 'bob');
    const a2 = from('a2', 'alice');
    const ambient = from('c0', 'carol', 0);
    const { batch, logs } = selectInitialBatch([a1, b1, ambient, a2]);
    // Alice's triggers run; Bob's waits; other people's context rides along.
    expect(batch.map((m) => m.id)).toEqual(['a1', 'c0', 'a2']);
    expect(logs.join('\n')).toContain('deferring 1 other-sender trigger row(s)');
    // Bob's turn next: the remaining rows are single-sender, unchanged.
    expect(selectInitialBatch([b1, ambient]).logs).toEqual([]);
    // One sender (or one trigger) never splits.
    expect(selectInitialBatch([a1, a2, ambient]).logs).toEqual([]);
  });

  it('counts deferred trigger rows in the operator-note split log', () => {
    const user = row('u1:ag-1', 'chat-sdk');
    const note = row('chief-nudge:appr-1', 'chat');
    const ambient = row('a1', 'chat-sdk', { trigger: 0 });
    expect(selectInitialBatch([note, user, ambient]).logs.join('\n')).toContain('deferring 2 row(s) (1 trigger=1)');
  });

  it('passes through a chat-only batch unchanged (no isolation triggered)', () => {
    const m = [row('c1', 'chat-sdk'), row('c2', 'chat')];
    const { batch, logs } = selectInitialBatch(m);
    expect(batch).toEqual(m);
    expect(logs).toEqual([]);
  });

  it('passes through a task-only batch unchanged', () => {
    const m = [row('t1', 'task', { series_id: 'rss' })];
    const { batch, logs } = selectInitialBatch(m);
    expect(batch).toEqual(m);
    expect(logs).toEqual([]);
  });

  it('defers chat when any task trigger is present (2026-05-16 AI-Friends leak)', () => {
    const dream = row('t-dream', 'task', { series_id: 'dream-ag-1' });
    const stickyChat = row('c-sticky', 'chat-sdk', { trigger: 1 });
    const ambientChat = row('c-amb', 'chat-sdk', { trigger: 0 });
    const { batch, logs } = selectInitialBatch([dream, stickyChat, ambientChat]);
    expect(batch.map((m) => m.id)).toEqual(['t-dream']);
    expect(logs[0]).toContain('deferring 2 chat row(s)');
    expect(logs[0]).toContain('1 trigger=1 sticky-engage');
  });

  it('defers non-dream tasks when a dream row is present (2026-05-25 Degenerate silent-fire)', () => {
    const dream = row('t-dream', 'task', { series_id: 'dream-ag-1778154011329-g9zust' });
    const recap = row('t-recap', 'task', { series_id: 'task-1777513235917-ui5728' });
    const rss = row('t-rss', 'task', { series_id: 'rss-news' });
    const { batch, logs } = selectInitialBatch([dream, recap, rss]);
    expect(batch.map((m) => m.id)).toEqual(['t-dream']);
    // Both layers may fire if chat is also present; here only the dream
    // layer should announce itself.
    expect(logs.some((l) => l.includes('Dream trigger present'))).toBe(true);
    expect(logs.some((l) => l.includes('deferring 2 non-dream row(s)'))).toBe(true);
  });

  it('applies both isolations: dream + chat + other task → only dream survives', () => {
    const dream = row('t-dream', 'task', { series_id: 'dream-ag-1' });
    const recap = row('t-recap', 'task', { series_id: 'task-recap' });
    const chat = row('c1', 'chat-sdk', { trigger: 1 });
    const { batch, logs } = selectInitialBatch([dream, recap, chat]);
    expect(batch.map((m) => m.id)).toEqual(['t-dream']);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('Task trigger present');
    expect(logs[1]).toContain('Dream trigger present');
  });

  it('does NOT defer non-dream when no dream is present (multi-task wakes still batch)', () => {
    const recap = row('t-recap', 'task', { series_id: 'task-recap' });
    const rss = row('t-rss', 'task', { series_id: 'rss-news' });
    const { batch, logs } = selectInitialBatch([recap, rss]);
    expect(batch.map((m) => m.id).sort()).toEqual(['t-recap', 't-rss']);
    expect(logs.some((l) => l.includes('Dream trigger'))).toBe(false);
  });

  it('keeps multiple dream rows together (e.g. catch-up wake fires two days at once)', () => {
    const d1 = row('t-d1', 'task', { series_id: 'dream-ag-1' });
    const d2 = row('t-d2', 'task', { series_id: 'dream-ag-1' });
    const other = row('t-other', 'task', { series_id: 'recap' });
    const { batch } = selectInitialBatch([d1, d2, other]);
    expect(batch.map((m) => m.id).sort()).toEqual(['t-d1', 't-d2']);
  });

  it('treats null series_id as non-dream (does not crash on legacy rows)', () => {
    const dream = row('t-dream', 'task', { series_id: 'dream-x' });
    const legacy = row('t-legacy', 'task'); // series_id null
    const { batch } = selectInitialBatch([dream, legacy]);
    expect(batch.map((m) => m.id)).toEqual(['t-dream']);
  });

  it('chat-only batch with one dream task still isolates dream', () => {
    // A dream row that co-arrived with chat: chat dropped by step 1,
    // dream survives, no second isolation needed (it's the only row).
    const dream = row('t-dream', 'task', { series_id: 'dream-ag-1' });
    const chat = row('c1', 'chat-sdk');
    const { batch, logs } = selectInitialBatch([dream, chat]);
    expect(batch.map((m) => m.id)).toEqual(['t-dream']);
    expect(logs.some((l) => l.includes('Task trigger present'))).toBe(true);
    // Step 2 has nothing to defer (batch is already just the dream).
    expect(logs.some((l) => l.includes('Dream trigger'))).toBe(false);
  });
});

describe('supersedeCurrentChatPush', () => {
  it('marks the unresolved provider push stale when a chat follow-up arrives', () => {
    const superseded = [false];
    expect(supersedeCurrentChatPush(superseded, 0)).toBe(true);
    expect(superseded).toEqual([true]);
  });

  it('does not rewrite an already-consumed push', () => {
    const superseded = [false];
    expect(supersedeCurrentChatPush(superseded, 1)).toBe(false);
    expect(superseded).toEqual([false]);
  });

  it('notifies each queued follow-up while the unresolved result is withheld', () => {
    const superseded = [false];
    expect(supersedeCurrentChatPush(superseded, 0)).toBe(true);
    superseded.push(false);
    expect(supersedeCurrentChatPush(superseded, 0)).toBe(true);
    expect(superseded).toEqual([true, false]);
  });

  it('keeps Claude results deliverable because pushed input can join the pending result', () => {
    const superseded = [false];
    expect(supersedeCurrentChatPush(superseded, 0, 'claude')).toBe(false);
    expect(superseded).toEqual([false]);
  });
});

describe('supersedeQueuedChatPushes (Pi, Tico 2026-10-31)', () => {
  it('marks nothing when the chat message is steered into the running turn', () => {
    const superseded = [false];
    expect(supersedeQueuedChatPushes(superseded, [true], 0, 0)).toBe(false);
    expect(superseded).toEqual([false]);
  });

  it('marks the running chat reply and a queued chat reply ahead of the new message', () => {
    const superseded = [false, false];
    expect(supersedeQueuedChatPushes(superseded, [true, true], 0, 2)).toBe(true);
    expect(superseded).toEqual([true, true]);
  });

  it('never withholds a task result; a chat reply queued behind the task still is', () => {
    const superseded = [false, false];
    expect(supersedeQueuedChatPushes(superseded, [false, true], 0, 2)).toBe(true);
    expect(superseded).toEqual([false, true]);
    expect(supersedeQueuedChatPushes([false], [false], 0, 1)).toBe(false);
  });

  it('only touches the newest waitsFor unresolved pushes, never consumed ones', () => {
    const superseded = [false, false, false];
    // Push 0 consumed; push 1 already produced (dispatching); push 2 running.
    expect(supersedeQueuedChatPushes(superseded, [true, true, true], 1, 1)).toBe(true);
    expect(superseded).toEqual([false, false, true]);
  });
});

// Reverse isolation: a task trigger arriving as a FOLLOW-UP during an active
// CHAT turn must be deferred so it gets its own selectInitialBatch-isolated
// turn — otherwise the dream/maintenance prompt folds into the live chat
// conversation and the consolidation never runs (2026-05-31 degen incident:
// dream fires 05-27/30/31 empty, group memory frozen since 05-28).
describe('shouldDeferTaskFromChatTurn', () => {
  it('defers a task trigger that arrives during an active chat turn', () => {
    const dream = row('t-dream', 'task', { trigger: 1, series_id: 'dream-ag-x' });
    expect(shouldDeferTaskFromChatTurn('Teddy', [dream])).toBe(true);
  });

  it('does not defer when the active turn is task-only (activeSender null)', () => {
    const dream = row('t-dream', 'task', { trigger: 1, series_id: 'dream-ag-x' });
    // Task-only turns are handled by the existing forward guard, not this one.
    expect(shouldDeferTaskFromChatTurn(null, [dream])).toBe(false);
  });

  it('does not defer chat-only follow-ups during a chat turn', () => {
    const chat = row('c1', 'chat-sdk', { trigger: 1 });
    expect(shouldDeferTaskFromChatTurn('Teddy', [chat])).toBe(false);
  });

  it('ignores trigger=0 accumulate task rows (only trigger=1 tasks defer)', () => {
    const accum = row('t0', 'task', { trigger: 0 });
    expect(shouldDeferTaskFromChatTurn('Teddy', [accum])).toBe(false);
  });

  it('defers a mixed chat+task follow-up batch during a chat turn', () => {
    const chat = row('c1', 'chat-sdk', { trigger: 1 });
    const dream = row('t-dream', 'task', { trigger: 1, series_id: 'dream-ag-x' });
    expect(shouldDeferTaskFromChatTurn('Teddy', [chat, dream])).toBe(true);
  });
});

// Deferred-follow-up gates must not tear down any in-flight turn before its
// first result. This covers accumulate-only rows and chat deferred from an
// active task: both remain pending while the current turn finishes, then may
// unwind the stream so the outer loop can process the deferred work.
describe('mayEndQueryForDeferredFollowUps', () => {
  it('does NOT allow ending while the active turn awaits its first result', () => {
    expect(mayEndQueryForDeferredFollowUps(1)).toBe(false);
    expect(mayEndQueryForDeferredFollowUps(2)).toBe(false);
  });

  it('allows ending after the active turn produced a result', () => {
    expect(mayEndQueryForDeferredFollowUps(0)).toBe(true);
  });

  it('does NOT allow ending during asynchronous result dispatch', () => {
    expect(mayEndQueryForDeferredFollowUps(0, true)).toBe(false);
  });
});

// Reaction-only-wake isolation (2026-08-20 shit-talk): a 😂 on the agent's
// own message is a soft trigger, not a request to answer four minutes of
// ambient chat that accumulated since the agent last spoke.
describe('selectInitialBatch — reaction-only wake', () => {
  it('defers accumulate-only chat when the only trigger is a reaction', () => {
    const reaction = row('r1', 'reaction', { trigger: 1 });
    const ambient = [row('c1', 'chat-sdk', { trigger: 0 }), row('c2', 'chat-sdk', { trigger: 0 })];
    const { batch, logs } = selectInitialBatch([...ambient, reaction]);

    expect(batch).toEqual([reaction]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Reaction-only wake');
    expect(logs[0]).toContain('deferring 2 accumulate-only chat row(s)');
  });

  it('does NOT isolate when a real chat trigger is also present', () => {
    // An @mention alongside the reaction makes this a genuine chat turn —
    // the ambient rows are legitimate context for answering it.
    const m = [
      row('c1', 'chat-sdk', { trigger: 0 }),
      row('c2', 'chat-sdk', { trigger: 1 }),
      row('r1', 'reaction', { trigger: 1 }),
    ];
    const { batch, logs } = selectInitialBatch(m);

    expect(batch).toEqual(m);
    expect(logs).toEqual([]);
  });

  it('keeps a reaction-only batch with no ambient rows untouched', () => {
    const m = [row('r1', 'reaction', { trigger: 1 })];
    const { batch, logs } = selectInitialBatch(m);

    expect(batch).toEqual(m);
    expect(logs).toEqual([]);
  });

  it('keeps trigger=0 reactions as silent context alongside the trigger', () => {
    // Reactions between other people are ambient, but they are cheap and
    // carry the same "someone reacted" shape — only chat rows are deferred.
    const m = [
      row('r0', 'reaction', { trigger: 0 }),
      row('r1', 'reaction', { trigger: 1 }),
      row('c1', 'chat-sdk', { trigger: 0 }),
    ];
    const { batch } = selectInitialBatch(m);

    expect(batch.map((b) => b.id)).toEqual(['r0', 'r1']);
  });

  it('replays the shit-talk incident batch: 1 reaction trigger + 7 ambient', () => {
    const ambient = Array.from({ length: 7 }, (_, i) => row(`amb${i}`, 'chat-sdk', { trigger: 0 }));
    const reaction = row('laugh', 'reaction', { trigger: 1 });
    const { batch } = selectInitialBatch([...ambient, reaction]);

    // Pre-fix this was all 8 rows, and the ambient "We should ask Hyung"
    // became an implicit prompt to reply.
    expect(batch).toEqual([reaction]);
  });
});
