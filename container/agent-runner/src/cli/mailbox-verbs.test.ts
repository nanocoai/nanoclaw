/**
 * Container-local mailbox verbs against a REGISTERED mailbox that is not
 * SQLite — the point of the exercise.
 *
 * The fixture is an in-memory AgentMailbox holding only canonical records,
 * so a verb that reached for a file, a table or a connection would fail
 * here rather than on the one deployment whose store is an object store.
 * The delivery-loop half of the same contract stays on the SQLite fixture
 * (mailbox.test.ts): that suite is about the state machine, this one is
 * about the transport being nobody's business.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { loadConfig } from '../config.js';
import { getAgentMailbox, registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { parseInboundRecord, parseSessionRoutingRecord } from '../mailbox/model.generated.js';
import type {
  AgentMailbox,
  AgentMailboxFactory,
  InboundRecord,
  MailboxOperations,
  OutboundRecord,
  ProcessingStatus,
  SessionRoutingRecord,
} from '../mailbox/types.js';
import { inboxRead, outboxSend, runMailboxVerb, type MailboxPaths } from './mailbox-verbs.js';

loadConfig(); // defaults — the pending fetch reads maxMessagesPerPrompt

let composed: AgentMailboxFactory | undefined;
let paths: MailboxPaths;
let store: FakeMailbox;

/**
 * Everything a verb did NOT ask for throws by name, so a verb that grows a
 * dependency on some other operation says which one, here, instead of on a
 * deployment.
 */
function seamOnly(implemented: Partial<MailboxOperations>): MailboxOperations {
  return new Proxy(implemented as Record<string, unknown>, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target))
        throw new Error(`fake mailbox: verb reached for an unimplemented operation ${key}`);
      return target[key as string];
    },
  }) as unknown as MailboxOperations;
}

/**
 * The smallest honest mailbox: canonical records in Maps, the seam's own
 * selection and sequence rules, and nothing else. Unimplemented operations
 * throw, so a verb that grew a new dependency says so.
 */
class FakeMailbox implements AgentMailbox {
  readonly inbound = new Map<string, InboundRecord>();
  readonly outbound = new Map<string, OutboundRecord>();
  readonly acks = new Map<string, ProcessingStatus>();
  routing: SessionRoutingRecord = parseSessionRoutingRecord({
    channelType: 'slack',
    platformId: 'C999',
    threadId: null,
  });
  runs = 0;

  readonly operations = seamOnly({
    getPendingMessages: (limit: number, isFirstPoll: boolean): InboundRecord[] =>
      [...this.inbound.values()]
        .filter(
          (m) =>
            m.status === 'pending' &&
            (m.processAfter === null || Date.parse(m.processAfter) <= Date.now()) &&
            (!m.onWake || isFirstPoll) &&
            !this.acks.has(m.id),
        )
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .slice(0, limit),
    markMessages: (ids: string[], status: ProcessingStatus): void => {
      for (const id of ids) this.acks.set(id, status);
    },
    getMessageIn: (id: string): InboundRecord | undefined => this.inbound.get(id),
    getSessionRouting: (): SessionRoutingRecord => this.routing,
    writeMessageOut: async (message: Parameters<MailboxOperations['writeMessageOut']>[0]): Promise<number> => {
      const max = Math.max(
        0,
        ...[...this.inbound.values()].map((m) => m.sequence ?? 0),
        ...[...this.outbound.values()].map((m) => m.sequence ?? 0),
      );
      const sequence = max % 2 === 0 ? max + 1 : max + 2;
      this.outbound.set(message.id, {
        id: message.id,
        sequence,
        inReplyTo: message.inReplyTo ?? null,
        timestamp: new Date().toISOString(),
        deliverAfter: null,
        recurrence: null,
        kind: message.kind,
        platformId: message.platformId ?? null,
        channelType: message.channelType ?? null,
        threadId: message.threadId ?? null,
        content: message.content,
      } as OutboundRecord);
      return sequence;
    },
  });

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async run<T>(action: () => T | Promise<T>): Promise<T> {
    this.runs++;
    return action();
  }
}

function seedInbound(
  id: string,
  opts: { text?: string; kind?: string; seq?: number; onWake?: boolean; trigger?: boolean } = {},
): void {
  store.inbound.set(
    id,
    parseInboundRecord({
      id,
      sequence: opts.seq ?? null,
      kind: opts.kind ?? 'chat',
      timestamp: new Date().toISOString(),
      status: 'pending',
      processAfter: null,
      recurrence: null,
      seriesId: id,
      tries: 0,
      trigger: opts.trigger ?? true,
      platformId: 'C123',
      channelType: 'slack',
      threadId: 'T456',
      content: JSON.stringify({ text: opts.text ?? `text of ${id}`, sender: 'gavriel' }),
      sourceSessionId: null,
      onWake: opts.onWake ?? false,
    }),
  );
}

function ackedIds(status: ProcessingStatus = 'completed'): string[] {
  return [...store.acks.entries()]
    .filter(([, value]) => value === status)
    .map(([id]) => id)
    .sort();
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-verbs-'));
  paths = { containerJson: path.join(dir, 'container.json') };
  fs.writeFileSync(paths.containerJson, JSON.stringify({ codeMode: true }));
  store = new FakeMailbox();
  // Capture per test, not once at import: another suite may hold the slot
  // when this file loads, and a swap must always put back what it took.
  composed = resetAgentMailboxForTesting();
  registerAgentMailbox(() => store);
});

afterEach(() => {
  resetAgentMailboxForTesting();
  if (composed) registerAgentMailbox(composed);
});

describe('inbox read', () => {
  it('returns pending mail chronologically and consumes it by default', async () => {
    seedInbound('m1', { seq: 2, text: 'first' });
    seedInbound('m2', { seq: 4, text: 'second' });
    const res = await inboxRead({});
    if (!res.ok) throw new Error(res.error.message);
    const data = res.data as { messages: Array<{ id: string; text: string; sender: string }>; consumed: boolean };
    expect(data.messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(data.messages[0].sender).toBe('gavriel');
    expect(data.consumed).toBe(true);
    expect(ackedIds()).toEqual(['m1', 'm2']);

    // Consumed mail does not reappear.
    const again = await inboxRead({});
    if (!again.ok) throw new Error(again.error.message);
    expect((again.data as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('--peek reads without consuming', async () => {
    seedInbound('m1');
    const res = await inboxRead({ peek: true });
    if (!res.ok) throw new Error(res.error.message);
    expect((res.data as { messages: unknown[] }).messages).toHaveLength(1);
    expect([...store.acks.keys()]).toEqual([]);
  });

  it('--id fetches full text regardless of ack state (the preview follow-up)', async () => {
    seedInbound('m1', { text: 'the full long text' });
    await inboxRead({}); // consume it
    const res = await inboxRead({ id: 'm1' });
    if (!res.ok) throw new Error(res.error.message);
    expect((res.data as { message: { text: string } }).message.text).toBe('the full long text');
  });

  it('never surfaces kind=system transport envelopes', async () => {
    seedInbound('resp', { kind: 'system', text: 'cli_response' });
    const res = await inboxRead({});
    if (!res.ok) throw new Error(res.error.message);
    expect((res.data as { messages: unknown[] }).messages).toHaveLength(0);
    // Not even acked — it belongs to the cli poll this same process is running.
    expect([...store.acks.keys()]).toEqual([]);
  });

  it('sees an on_wake row the delivery loop has already polled past', async () => {
    seedInbound('wake', { onWake: true, text: 'you were restarted' });
    // The loop, past its first poll, cannot see this row at all.
    expect(store.operations.getPendingMessages(10, false)).toHaveLength(0);
    const res = await inboxRead({});
    if (!res.ok) throw new Error(res.error.message);
    expect((res.data as { messages: Array<{ text: string }> }).messages[0].text).toBe('you were restarted');
  });

  it('says so when the seam cap holds mail back — twelve waiting, ten shown, and the agent can tell', async () => {
    for (let i = 1; i <= 12; i++) seedInbound(`m${i}`, { seq: i * 2 });
    const res = await inboxRead({});
    if (!res.ok) throw new Error(res.error.message);
    const first = res.data as { messages: unknown[]; truncated: boolean };
    expect(first.messages).toHaveLength(10);
    expect(first.truncated).toBe(true);
    expect(res.human).toContain('batch capped at 10');

    // Reading again drains the rest, and a short batch claims no cap.
    const again = await inboxRead({});
    if (!again.ok) throw new Error(again.error.message);
    const rest = again.data as { messages: unknown[]; truncated: boolean };
    expect(rest.messages).toHaveLength(2);
    expect(rest.truncated).toBe(false);
    expect(again.human).not.toContain('capped');
  });

  it('a capped batch of system envelopes still announces the mail behind it', async () => {
    // The system filter runs AFTER the cap, so "inbox empty" can be a lie
    // told by ten transport envelopes. The note is on the pre-filter length.
    for (let i = 1; i <= 10; i++) seedInbound(`sys${i}`, { kind: 'system', seq: i * 2 });
    seedInbound('mail', { seq: 22, text: 'behind the envelopes' });
    const res = await inboxRead({});
    if (!res.ok) throw new Error(res.error.message);
    expect((res.data as { messages: unknown[]; truncated: boolean }).truncated).toBe(true);
    expect(res.human).toContain('inbox empty');
    expect(res.human).toContain('batch capped at 10');
    expect([...store.acks.keys()]).toEqual([]); // envelopes are still never acked
  });

  it('never claims mail the delivery loop is mid-delivery on', async () => {
    seedInbound('m1');
    store.operations.markMessages(['m1'], 'processing');
    const res = await inboxRead({});
    if (!res.ok) throw new Error(res.error.message);
    expect((res.data as { messages: unknown[] }).messages).toHaveLength(0);
    // The loop's claim is intact — the read never overwrote it.
    expect(store.acks.get('m1')).toBe('processing');
  });
});

describe('outbox send', () => {
  it('writes a chat message routed to the session routing with an odd seq and JSON content', async () => {
    seedInbound('m1', { seq: 2 }); // host wrote even seq 2
    const res = await outboxSend({ text: 'hello from the sandbox' });
    if (!res.ok) throw new Error(res.error.message);
    const rows = [...store.outbound.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].platformId).toBe('C999');
    expect((rows[0].sequence as number) % 2).toBe(1);
    expect((rows[0].sequence as number) > 2).toBe(true);
    expect(JSON.parse(rows[0].content)).toEqual({ text: 'hello from the sandbox' });
  });

  it('--reply-to copies the inbound routing and sets inReplyTo', async () => {
    seedInbound('m1', { seq: 2 });
    const res = await outboxSend({ text: 'threaded reply', 'reply-to': 'm1' });
    if (!res.ok) throw new Error(res.error.message);
    const row = [...store.outbound.values()][0];
    expect(row.platformId).toBe('C123'); // from m1, not the session routing
    expect(row.threadId).toBe('T456');
    expect(row.inReplyTo).toBe('m1');
  });

  it('refuses empty text and unknown reply targets', async () => {
    expect((await outboxSend({})).ok).toBe(false);
    expect((await outboxSend({ text: 'x', 'reply-to': 'nope' })).ok).toBe(false);
    expect(store.outbound.size).toBe(0);
  });

  it('refuses when the session has no routing to answer', async () => {
    store.routing = parseSessionRoutingRecord({ channelType: null, platformId: null, threadId: null });
    const res = await outboxSend({ text: 'into the void' });
    expect(res.ok).toBe(false);
    expect(store.outbound.size).toBe(0);
  });
});

describe('the seam is the only transport', () => {
  it('scopes every verb in one mailbox run() and never reaches past operations', async () => {
    seedInbound('m1', { seq: 2 });
    await inboxRead({});
    await outboxSend({ text: 'reply' });
    // Two logical operations, two scopes — the unit an implementation is
    // allowed to serialize and flush around.
    expect(store.runs).toBe(2);
  });
});

describe('runMailboxVerb dispatch', () => {
  it('routes inbox-read, recovers a dash-joined positional id, and ignores foreign commands', async () => {
    seedInbound('msg-17-abc', { text: 'positional target' });
    expect(await runMailboxVerb('groups-list', {}, paths)).toBeNull();

    const byPositional = await runMailboxVerb('inbox-read-msg-17-abc', {}, paths);
    if (!byPositional?.ok) throw new Error('expected ok');
    expect((byPositional.data as { message: { text: string } }).message.text).toBe('positional target');
  });

  it('refuses to dispatch locally in a chat-mode container — the poll loop owns consumption there', async () => {
    seedInbound('m1');
    fs.writeFileSync(paths.containerJson, JSON.stringify({})); // no codeMode
    expect(await runMailboxVerb('inbox-read', {}, paths)).toBeNull();
    fs.rmSync(paths.containerJson); // no config at all — same refusal
    expect(await runMailboxVerb('inbox-read', {}, paths)).toBeNull();
    expect([...store.acks.keys()]).toEqual([]); // and nothing was consumed
  });
});

describe('non-destructive misuse', () => {
  it('--help never consumes the inbox', async () => {
    seedInbound('m1');
    const res = await inboxRead({ help: true });
    if (!res.ok) throw new Error('expected ok');
    expect(String(res.data)).toContain('usage:');
    expect([...store.acks.keys()]).toEqual([]);
  });

  it('unknown flags are rejected before the mailbox is opened at all', async () => {
    seedInbound('m1');
    const res = await inboxRead({ 'delete-all': true });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.message).toContain('--delete-all');
    expect([...store.acks.keys()]).toEqual([]);
    expect(store.runs).toBe(0);

    const send = await outboxSend({ text: 'x', dest: 'nope' });
    expect(send.ok).toBe(false);
    expect(store.outbound.size).toBe(0);
    expect(store.runs).toBe(0);
  });
});

describe('registration', () => {
  it('resolves the mailbox at call time, so composition — not this file — picks the store', () => {
    expect(getAgentMailbox()).toBe(store);
  });
});
