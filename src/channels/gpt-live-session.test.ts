/**
 * Unit tests for the gpt-live session state machine. These exercise the
 * protocol bookkeeping the adapter relies on — where a delegation's
 * transcript is cut, chunking under the per-append cap, barge-in — with a
 * recording sink standing in for the sideband socket. No network.
 */
import { describe, expect, it } from 'vitest';

import {
  chunkForAppend,
  GptLiveSession,
  MAX_APPEND_CHARS,
  type DelegationRequest,
  type LiveClientEvent,
} from './gpt-live-session.js';

function recorder() {
  const sent: LiveClientEvent[] = [];
  const delegations: DelegationRequest[] = [];
  const closed: string[] = [];
  const session = new GptLiveSession('live_test', {
    send: (e) => sent.push(e),
    onDelegation: (d) => delegations.push(d),
    onClosed: (r) => closed.push(r),
  });
  return { session, sent, delegations, closed };
}

const callerSays = (s: GptLiveSession, ...deltas: string[]) =>
  deltas.forEach((delta) => s.handle({ type: 'session.input_transcript.delta', delta }));
const assistantSays = (s: GptLiveSession, ...deltas: string[]) =>
  deltas.forEach((delta) => s.handle({ type: 'session.output_transcript.delta', delta }));
const delegate = (s: GptLiveSession, id: string, offset_ms = 1000) =>
  s.handle({ type: 'session.delegation.created', delegation: { id, type: 'delegation', target: 'client' }, offset_ms });

describe('GptLiveSession', () => {
  it('cuts the transcript at the delegation and hands it over with the id', () => {
    const { session, delegations } = recorder();
    assistantSays(session, 'Hi, how can ', 'I help?');
    callerSays(session, "What's on my ", 'calendar tomorrow?');
    delegate(session, 'item_1', 4200);

    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      sessionId: 'live_test',
      delegationId: 'item_1',
      offsetMs: 4200,
      supersedes: null,
    });
    expect(delegations[0].transcript).toBe("Assistant: Hi, how can I help?\nCaller: What's on my calendar tomorrow?");
    expect(session.currentDelegation()).toBe('item_1');
  });

  it('speaks a reply as commentary bound to the open delegation', () => {
    const { session, sent } = recorder();
    callerSays(session, 'Anything due today?');
    delegate(session, 'item_1');
    const ids = session.speak('Two things: the invoice and the standup notes.');

    expect(ids).toHaveLength(1);
    expect(sent).toEqual([
      {
        type: 'session.commentary.append',
        event_id: ids[0],
        delegation_id: 'item_1',
        content: 'Two things: the invoice and the standup notes.',
      },
    ]);
  });

  it('chunks a long reply under the append cap, every chunk on the same delegation', () => {
    const { session, sent } = recorder();
    delegate(session, 'item_1');
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} is here to pad things out.`).join(' ');
    const ids = session.speak(long);

    expect(ids.length).toBeGreaterThan(1);
    for (const e of sent) {
      expect(e.type).toBe('session.commentary.append');
      if (e.type === 'session.commentary.append') {
        expect(e.delegation_id).toBe('item_1');
        expect(e.content.length).toBeLessThanOrEqual(MAX_APPEND_CHARS);
        expect(e.content.endsWith('.')).toBe(true); // cut on sentence boundaries
      }
    }
    expect(sent.map((e) => (e.type === 'session.commentary.append' ? e.content : '')).join(' ')).toBe(long);
  });

  it('a barge-in delegation supersedes the open one and only carries the newer turns', () => {
    const { session, delegations, sent } = recorder();
    callerSays(session, 'Book me a table for two.');
    delegate(session, 'item_1');
    session.think('Looking up restaurants.');
    callerSays(session, 'Actually, make it four.');
    delegate(session, 'item_2');

    expect(delegations[1]).toMatchObject({ delegationId: 'item_2', supersedes: 'item_1' });
    expect(delegations[1].transcript).toBe('Caller: Actually, make it four.');
    expect(session.currentDelegation()).toBe('item_2');

    // A late result for the superseded task is still sent, addressed to its own id.
    session.speak('Found three places for two.', 'item_1');
    const last = sent.at(-1);
    expect(last).toMatchObject({ type: 'session.commentary.append', delegation_id: 'item_1' });
  });

  it('speaks with a null delegation id when nothing is delegated (proactive message)', () => {
    const { session, sent } = recorder();
    session.speak('Reminder: your call with Dana starts in five minutes.');
    expect(sent[0]).toMatchObject({ type: 'session.commentary.append', delegation_id: null });
  });

  it('stops emitting and reports the reason once the session closes', () => {
    const { session, sent, closed } = recorder();
    session.handle({ type: 'session.closed' });
    expect(closed).toEqual(['session.closed']);
    expect(session.isClosed()).toBe(true);
    expect(session.speak('too late')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('ignores events it does not track', () => {
    const { session, sent, delegations } = recorder();
    session.handle({ type: 'session.usage.updated', usage: {} });
    session.handle({ type: 'session.commentary.appended', event_id: 'x' });
    expect(sent).toEqual([]);
    expect(delegations).toEqual([]);
  });
});

describe('chunkForAppend', () => {
  it('returns one chunk for short text and nothing for blank text', () => {
    expect(chunkForAppend('hello')).toEqual(['hello']);
    expect(chunkForAppend('   ')).toEqual([]);
  });

  it('falls back to word boundaries when there is no sentence end', () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkForAppend(words, 200);
    expect(chunks.every((c) => c.length <= 200 && !c.startsWith(' ') && !c.endsWith(' '))).toBe(true);
    expect(chunks.join(' ')).toBe(words);
  });
});

// Adapter-level behaviour, covered once GL-03 and GL-05 land (see the board tracker).
describe.todo('gpt-live adapter');
