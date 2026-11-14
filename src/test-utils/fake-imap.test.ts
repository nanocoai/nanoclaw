/**
 * The fake IMAP server the Proton Mail adapter tests run against: its
 * sequence-set semantics must match RFC 9051, or the adapter tests prove
 * nothing about the cursor.
 */
import { describe, expect, it } from 'vitest';

import { FakeImapServer, resolveSequenceSet } from './fake-imap.js';

describe('resolveSequenceSet (RFC 9051 §9 sequence-set)', () => {
  const uids = [2, 3, 5, 9];

  it('takes single numbers, ranges and comma lists; numbers not in use are ignored', () => {
    expect(resolveSequenceSet('3', uids)).toEqual([3]);
    expect(resolveSequenceSet('4', uids)).toEqual([]);
    expect(resolveSequenceSet('2:5', uids)).toEqual([2, 3, 5]);
    expect(resolveSequenceSet('9,2,4', uids)).toEqual([2, 9]);
    expect(resolveSequenceSet('2,2:3', uids)).toEqual([2, 3]);
  });

  it('a range is unordered: 9:3 is 3:9', () => {
    expect(resolveSequenceSet('9:3', uids)).toEqual([3, 5, 9]);
  });

  it('* is the highest number in use, so N:* above it still returns that message', () => {
    expect(resolveSequenceSet('*', uids)).toEqual([9]);
    expect(resolveSequenceSet('4:*', uids)).toEqual([5, 9]);
    expect(resolveSequenceSet('10:*', uids)).toEqual([9]);
    expect(resolveSequenceSet('*:10', uids)).toEqual([9]);
  });

  it('an empty mailbox matches nothing, even for *', () => {
    expect(resolveSequenceSet('1:*', [])).toEqual([]);
    expect(resolveSequenceSet('*', [])).toEqual([]);
  });

  it('refuses a malformed set, as a server answers BAD', () => {
    for (const bad of ['', '0', '1:2:3', 'a', '1,', '-1', '1.5', '4294967296']) {
      expect(() => resolveSequenceSet(bad, uids), bad).toThrow(/BAD/);
    }
  });
});

describe('FakeImapServer', () => {
  const src = (s: string) => Buffer.from(`Subject: ${s}\r\n\r\n${s}`);

  async function open(server: FakeImapServer) {
    const { FakeImapClient } = await import('./fake-imap.js');
    const c = new FakeImapClient(server);
    await c.connect();
    await c.mailboxOpen('INBOX');
    return c;
  }
  const list = async (c: any, range: string) => {
    const out: number[] = [];
    for await (const m of c.fetch(range, { uid: true, size: true }, { uid: true })) out.push(m.uid);
    return out;
  };

  it('UIDs are never reused after an expunge; the mailbox survives a reconnect', async () => {
    const server = new FakeImapServer();
    server.deliver(src('a'));
    server.deliver(src('b'));
    server.expunge(2);
    expect(server.deliver(src('c'))).toBe(3);
    const c1 = await open(server);
    server.dropConnection();
    // imapflow answers fetch and fetchOne with nothing once the mailbox is closed.
    expect(await list(c1, '1:*')).toEqual([]);
    expect(await c1.fetchOne('1', { source: true }, { uid: true })).toBeUndefined();
    await expect(c1.messageFlagsAdd('1', ['\\Seen'], { uid: true })).rejects.toThrow(/Connection not available/);
    const c2 = await open(server);
    expect(await list(c2, '1:*')).toEqual([1, 3]);
    expect(c2.mailbox).toMatchObject({ uidValidity: 1n, uidNext: 4 });
  });

  it('renumber gives a new UIDVALIDITY, UIDs from 1, and drops every connection', async () => {
    const server = new FakeImapServer({ uidValidity: 7 });
    server.deliver(src('a'));
    server.deliver(src('b'));
    server.expunge(1);
    const c = await open(server);
    let closed = 0;
    c.on('close', () => closed++);
    expect(server.renumber()).toBe(8n);
    expect(closed).toBe(1);
    const c2 = await open(server);
    expect(c2.mailbox).toMatchObject({ uidValidity: 8n, uidNext: 2 });
    expect(await list(c2, '1:*')).toEqual([1]);
  });

  it('fail(op, n) throws for the next n calls, optionally only those `when` accepts', async () => {
    const server = new FakeImapServer();
    server.deliver(src('a'));
    server.deliver(src('b'));
    const c = await open(server);
    server.fail('fetchOne', 1, { when: ([uid]) => uid === '2' });
    expect(await c.fetchOne('1', { source: true }, { uid: true })).toMatchObject({ uid: 1 });
    await expect(c.fetchOne('2', { source: true }, { uid: true })).rejects.toThrow(/injected/);
    expect(await c.fetchOne('2', { source: true }, { uid: true })).toMatchObject({ uid: 2 });
    expect(await c.fetchOne('9', { source: true }, { uid: true })).toBe(false);
    expect(server.calls('fetchOne', { all: true }).map((e) => e.ok)).toEqual([true, false, true, true]);
  });

  it('a connect failure leaves the client unusable; deliver emits exists to open clients only', async () => {
    const server = new FakeImapServer();
    server.fail('connect');
    const { FakeImapClient } = await import('./fake-imap.js');
    const bad = new FakeImapClient(server);
    await expect(bad.connect()).rejects.toThrow(/injected/);
    await expect(bad.mailboxOpen('INBOX')).rejects.toThrow(/Connection not available/);
    const good = await open(server);
    const heard: unknown[] = [];
    good.on('exists', (e) => heard.push(e));
    server.deliver(src('a'));
    server.deliver(src('b'), { notify: false });
    await Promise.resolve();
    expect(heard).toEqual([{ path: 'INBOX', count: 1 }]);
  });

  it('logs messageFlagsAdd by UID', async () => {
    const server = new FakeImapServer();
    server.deliver(src('a'));
    const c = await open(server);
    await c.messageFlagsAdd('1', ['\\Seen'], { uid: true });
    expect(server.flagsAdded()).toEqual([[1, ['\\Seen']]]);
    expect([...server.messages.get(1)!.flags]).toEqual(['\\Seen']);
  });

  it('like imapflow, fetch and fetchOne with no mailbox open answer nothing; a fetch in flight still fails on a drop', async () => {
    const server = new FakeImapServer();
    server.deliver(src('a'));
    server.deliver(src('b'));
    const { FakeImapClient } = await import('./fake-imap.js');
    const notOpen = new FakeImapClient(server);
    await notOpen.connect();
    expect(await list(notOpen, '1:*')).toEqual([]);
    expect(await notOpen.fetchOne('1', { source: true }, { uid: true })).toBeUndefined();
    // An interceptor dropping the connection as fetchOne starts: the mailbox is gone, so undefined.
    const c = await open(server);
    const off = server.intercept('fetchOne', () => server.dropConnection());
    expect(await c.fetchOne('1', { source: true }, { uid: true })).toBeUndefined();
    off();
    // A drop while the listing is being read ends it with an error.
    const c2 = await open(server);
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const m of c2.fetch('1:*', { uid: true }, { uid: true })) {
          seen.push(m.uid);
          server.dropConnection();
        }
      })(),
    ).rejects.toThrow(/Connection not available/);
    expect(seen).toEqual([1]);
    // A drop during the command itself: a fail() whose error drops the connection.
    const c3 = await open(server);
    server.fail('fetchOne', 1, {
      error: () => {
        server.dropConnection();
        return Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
      },
    });
    await expect(c3.fetchOne('1', { source: true }, { uid: true })).rejects.toThrow(/Connection not available/);
    expect(c3.usable).toBe(false);
  });

  it('refuses any command while a fetch iterator is open, as imapflow would deadlock, and records it', async () => {
    const server = new FakeImapServer();
    server.deliver(src('a'));
    server.deliver(src('b'));
    const c = await open(server);
    const errors: string[] = [];
    for await (const m of c.fetch('1:*', { uid: true }, { uid: true })) {
      for (const cmd of [
        () => c.fetchOne(String(m.uid), { source: true }, { uid: true }),
        () => c.messageFlagsAdd(String(m.uid), ['\\Seen'], { uid: true }),
        () => list(c, '1:*'),
      ])
        await cmd().catch((e: Error) => errors.push(e.message));
    }
    expect(errors).toHaveLength(6);
    expect(errors[0]).toMatch(/fetchOne issued while a fetch iterator is open/);
    expect(server.protocolErrors).toEqual(errors);
    expect(server.flagsAdded()).toEqual([]);
    // Once the listing is done, or left early, commands run again.
    expect(await c.fetchOne('1', { source: true }, { uid: true })).toMatchObject({ uid: 1 });
    for await (const _ of c.fetch('1:*', { uid: true }, { uid: true })) break;
    await c.messageFlagsAdd('2', ['\\Seen'], { uid: true });
    expect(server.flagsAdded()).toEqual([[2, ['\\Seen']]]);
    expect(server.protocolErrors).toHaveLength(6);
  });
});
