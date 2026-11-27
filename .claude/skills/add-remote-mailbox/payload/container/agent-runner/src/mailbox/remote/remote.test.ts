import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { touchHeartbeat } from '../../heartbeat.js';
import { createComposedMailbox } from '../compose.js';
import { resetAgentMailboxForTesting } from '../index.js';
import type { InboundMessage, OutboundMessageDraft } from '../types.js';
import { type FakeHost, freePort, startFakeHost } from './fake-host.js';
import { MailboxAuthError, MailboxRpcError, RemoteAgentMailbox } from './index.js';
import { SqliteAgentMailbox } from '../sqlite/index.js';

let host: FakeHost;
const tmpDirs: string[] = [];
const mailboxes: RemoteAgentMailbox[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mailbox-'));
  tmpDirs.push(dir);
  return dir;
};
const make = (over: Partial<ConstructorParameters<typeof RemoteAgentMailbox>[0]> = {}) => {
  const mailbox = new RemoteAgentMailbox({
    url: host.url,
    token: host.token,
    session: host.session,
    inboxRoot: path.join(tmp(), 'inbox'),
    outboxRoot: path.join(tmp(), 'outbox'),
    ...over,
  });
  mailboxes.push(mailbox);
  return mailbox;
};
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

beforeAll(async () => {
  host = await startFakeHost();
});
afterAll(() => host.stop());
afterEach(async () => {
  for (const m of mailboxes.splice(0)) await m.stop();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.NANOCLAW_MAILBOX_URL;
  delete process.env.NANOCLAW_MAILBOX_TOKEN;
  delete process.env.NANOCLAW_MAILBOX_SESSION;
  delete process.env.NANOCLAW_HEARTBEAT_PATH;
  await host.ctl({ cmd: 'rejectAll', value: false });
});

describe('operations round-trip', () => {
  test('start verifies hello; mismatch is rejected', async () => {
    const m = make();
    await m.start({ agentGroupId: 'ag-1', sessionId: 'sess-1', mailbox: null });
    const bad = make();
    await expect(bad.start({ agentGroupId: 'ag-1', sessionId: 'other', mailbox: null })).rejects.toThrow(
      /mismatch|rejected/,
    );
  });

  test('start without a context file takes the session from options/env (OpenShell VMs)', async () => {
    const m = make();
    await m.start(null);
    expect(m.getSessionRouting()).toBeDefined();
    const saved = process.env.NANOCLAW_MAILBOX_SESSION;
    delete process.env.NANOCLAW_MAILBOX_SESSION;
    try {
      await expect(make({ session: undefined, contextPath: '/nonexistent/ctx.json' }).start(null)).rejects.toThrow(
        /session identity/,
      );
    } finally {
      if (saved !== undefined) process.env.NANOCLAW_MAILBOX_SESSION = saved;
    }
  });

  test('every op sends positional args and maps null to undefined only where typed', async () => {
    const baseline = (await host.dump()).log.length;
    const m = make();
    await m.start({ agentGroupId: 'ag-1', sessionId: 'sess-1', mailbox: null });
    await host.ctl({
      cmd: 'seed',
      pending: [
        { id: 'm1', kind: 'chat', content: '{}' },
        { id: 'm2', kind: 'chat', content: '{}' },
      ],
    });
    expect(m.getPendingMessages(1, true).map((x: InboundMessage) => x.id)).toEqual(['m1']);
    expect(m.getMessageIn('m2')?.id).toBe('m2');
    expect(m.getMessageIn('nope')).toBeUndefined();
    expect(m.findQuestionResponse('q')).toBeUndefined();
    expect(m.findCliResponse('r')).toBeUndefined();
    m.markMessages(['m1'], 'completed');
    m.markScriptSkipped([{ id: 'm2', reason: 'x' }]);

    const draft: OutboundMessageDraft = { id: 'out-1', kind: 'chat', content: '{"text":"hi"}' };
    const seq = await m.writeMessageOut(draft);
    expect(seq % 2).toBe(1);
    expect(m.getMessageIdBySeq(seq)).toBe('out-1');
    expect(m.getMessageIdBySeq(9999)).toBeNull();
    expect(m.getRoutingBySeq(seq)).toEqual({ channelType: 'telegram', platformId: 'p1', threadId: null });
    expect(m.getRoutingBySeq(9999)).toBeNull();
    expect(m.getLatestInboundRoute('telegram', 'p1')).toEqual({ threadId: null, inReplyTo: 'in-1' });
    expect(m.getUndeliveredMessages()[0].id).toBe('out-1');
    expect(m.getDeliveryStatus('out-1')).toBeNull();

    expect(m.getState('k')).toBeUndefined();
    m.setState('k', 'v');
    expect(m.getState('k')?.value).toBe('v');
    m.deleteState('k');
    expect(m.getState('k')).toBeUndefined();

    expect(m.getSessionRouting().channelType).toBe('telegram');
    expect(m.getDestinations()).toHaveLength(1);
    expect(m.findDestinationByName('main')?.name).toBe('main');
    expect(m.findDestinationByName('zzz')).toBeUndefined();
    expect(m.findDestinationByRouting('telegram', 'p1')).toBeUndefined();
    m.setContainerToolInFlight('Bash', null);
    m.setContainerToolInFlight('Bash', 5000);
    m.clearContainerToolInFlight();
    m.clearStaleProcessingAcks();

    const log = (await host.dump()).log.slice(baseline);
    const sent = (op: string) => log.filter((l) => l.op === op).map((l) => l.args);
    expect(sent('getPendingMessages')[0]).toEqual([1, true]);
    expect(sent('markMessages')[0]).toEqual([['m1'], 'completed']);
    expect(sent('markScriptSkipped')[0]).toEqual([[{ id: 'm2', reason: 'x' }]]);
    expect(sent('writeMessageOut')[0]).toEqual([draft]);
    expect(sent('setContainerToolInFlight')).toEqual([
      ['Bash', null],
      ['Bash', 5000],
    ]);
    expect(sent('findDestinationByRouting')[0]).toEqual(['telegram', 'p1']);
    // ids strictly increase in call order
    const ids = log.map((l) => l.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('session header comes from the start key', async () => {
    const m = make({ session: undefined });
    await m.start({ agentGroupId: 'ag-1', sessionId: 'sess-1', mailbox: null });
    expect(m.getDestinations()).toHaveLength(1);
  });

  test('two instances in one process do not cross wires', async () => {
    const other = await startFakeHost({ session: 'ag-2/sess-2' });
    try {
      const a = make();
      const b = make({ url: other.url, token: other.token, session: other.session });
      a.setState('who', 'a');
      b.setState('who', 'b');
      expect(a.getState('who')?.value).toBe('a');
      expect(b.getState('who')?.value).toBe('b');
      await b.start({ agentGroupId: 'ag-2', sessionId: 'sess-2', mailbox: null });
    } finally {
      other.stop();
    }
  });
});

describe('transport hardening', () => {
  test('a reply with a different request id is discarded, not returned', async () => {
    const m = make();
    m.setState('x', '1');
    await host.ctl({ cmd: 'wrongIdNext' });
    let error: unknown;
    try {
      m.getState('x');
    } catch (e) {
      error = e;
    }
    expect((error as MailboxRpcError).code).toBe('id_mismatch');
    expect(m.getState('x')?.value).toBe('1');
  });

  test('timeout throws, a late reply is never read as the next answer, next call works', async () => {
    const m = make({ timeoutMs: 300 });
    m.setState('k', 'first');
    await host.ctl({ cmd: 'delayNext', ms: 900 });
    const started = Date.now();
    expect(() => m.getState('k')).toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(800);
    await Bun.sleep(800); // let the abandoned reply arrive
    m.setState('k', 'second');
    expect(m.getState('k')?.value).toBe('second');
  });

  test('poll reads give up after the short read timeout while writes keep the long one', async () => {
    const m = make({ timeoutMs: 5000, readTimeoutMs: 300 });
    await host.ctl({ cmd: 'delayNext', ms: 900 });
    const started = Date.now();
    expect(() => m.getPendingMessages(10, false)).toThrow(/timed out after 300ms/);
    expect(Date.now() - started).toBeLessThan(800);
    await Bun.sleep(800);
    await host.ctl({ cmd: 'delayNext', ms: 600 });
    m.setState('slow', 'ok'); // 600 ms > read timeout, < write timeout
    expect(m.getState('slow')?.value).toBe('ok');
  });

  test('retries connection refused until the host comes up', async () => {
    const late = await startFakeHost({ startDelayMs: 1000, waitReady: false });
    try {
      const m = make({ url: late.url, token: late.token, session: late.session });
      const started = Date.now();
      expect(m.getSessionRouting().channelType).toBe('telegram');
      expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    } finally {
      late.stop();
    }
  });

  test('gives up after the retry budget', async () => {
    const port = await freePort();
    const m = make({ url: `http://127.0.0.1:${port}/v1/mailbox`, retryBudgetMs: 400 });
    expect(() => m.getDestinations()).toThrow(/unreachable/);
  });

  test('401 surfaces as an auth error and requests a restart', async () => {
    const m = make({ token: 'wrong' });
    let error: unknown;
    try {
      m.getDestinations();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MailboxAuthError);
    expect(m.shouldRestartAfter(error)).toBe(true);
    expect(m.shouldRestartAfter(new Error('boom'))).toBe(false);
    expect(m.shouldRestartAfter(new MailboxRpcError('timeout', 'x'))).toBe(false);
    await expect(m.start({ agentGroupId: 'ag-1', sessionId: 'sess-1', mailbox: null })).rejects.toBeInstanceOf(
      MailboxAuthError,
    );
  });

  test('measures per-call latency', () => {
    const m = make();
    m.setState('p', 'v');
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = performance.now();
      m.getState('p');
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`remote mailbox call latency: p50 ${times[150].toFixed(2)}ms p99 ${times[297].toFixed(2)}ms`);
    expect(times[150]).toBeLessThan(25);
  });
});

describe('inbox sync', () => {
  const pendingOne = [{ id: 'm1', kind: 'chat', content: '{}' }];

  test('downloads new files in chunks-capable form and skips unchanged ones', async () => {
    const m = make();
    const root = (m as any).inboxRoot as string;
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    await host.ctl({
      cmd: 'seed',
      pending: pendingOne,
      files: { 'msg-1/photo.jpg': b64('JPEG'), 'msg-1/big.bin': b64(big) },
    });
    m.getPendingMessages(10, true);
    expect(fs.readFileSync(path.join(root, 'msg-1/photo.jpg'), 'utf8')).toBe('JPEG');
    expect(fs.readFileSync(path.join(root, 'msg-1/big.bin')).equals(big)).toBe(true);
    const first = (await host.dump()).inboxReads;
    expect(first).toBeGreaterThanOrEqual(3); // 1 + 2 chunks for the 5 MiB file

    m.getPendingMessages(10, false);
    expect((await host.dump()).inboxReads).toBe(first);

    // changed file is re-fetched, unchanged one is not
    await host.ctl({ cmd: 'seed', files: { 'msg-1/photo.jpg': b64('JPEG2') }, mtimeMs: 1_700_000_999_000 });
    m.getPendingMessages(10, false);
    expect(fs.readFileSync(path.join(root, 'msg-1/photo.jpg'), 'utf8')).toBe('JPEG2');
  });

  test('rejects traversal and absolute paths from a malicious host', async () => {
    const base = tmp();
    const m = make({ inboxRoot: path.join(base, 'inbox') });
    await host.ctl({
      cmd: 'seed',
      pending: pendingOne,
      files: { 'ok/fine.txt': b64('fine') },
      malicious: [
        { path: '../escape.txt', size: 1, mtimeMs: 1 },
        { path: 'a/../../escape2.txt', size: 1, mtimeMs: 1 },
        { path: '/etc/evil', size: 1, mtimeMs: 1 },
        { path: 'a\\..\\b', size: 1, mtimeMs: 1 },
        { path: 'x/./y', size: 1, mtimeMs: 1 },
      ],
    });
    m.getPendingMessages(10, true);
    expect(fs.existsSync(path.join(base, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'escape2.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(base, 'inbox/ok/fine.txt'), 'utf8')).toBe('fine');
    const { log } = await host.dump();
    expect(log.filter((l) => l.op === 'inboxRead').every((l) => !String(l.args[0]).includes('..'))).toBe(true);
    await host.ctl({ cmd: 'seed', malicious: [] });
  });

  test('does not write through a planted symlink', async () => {
    const base = tmp();
    const inbox = path.join(base, 'inbox');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(inbox);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(inbox, 'link'));
    const m = make({ inboxRoot: inbox });
    await host.ctl({ cmd: 'seed', pending: pendingOne, files: { 'link/pwn.txt': b64('x') } });
    m.getPendingMessages(10, true);
    expect(fs.existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
  });
});

describe('outbox upload', () => {
  test('uploads chunked files with final=true on the last chunk, before the op', async () => {
    const outboxRoot = tmp();
    const m = make({ outboxRoot });
    const big = Buffer.alloc(7 * 1024 * 1024 + 5, 3);
    fs.mkdirSync(path.join(outboxRoot, 'out-9'));
    fs.writeFileSync(path.join(outboxRoot, 'out-9', 'report.pdf'), big);
    fs.writeFileSync(path.join(outboxRoot, 'out-9', 'empty.txt'), '');
    await m.writeMessageOut({ id: 'out-9', kind: 'chat', content: '{"files":["report.pdf"]}' });
    await m.writeMessageOut({ id: 'out-10', kind: 'chat', content: '{}' }); // no outbox dir: nothing uploaded

    const dump = await host.dump();
    const entry = dump.outbox['out-9/report.pdf'];
    expect(entry.complete).toBe(true);
    expect(entry.chunks).toBe(3);
    expect(Buffer.from(entry.data, 'base64').equals(big)).toBe(true);
    expect(dump.outbox['out-9/empty.txt']).toMatchObject({ complete: true, chunks: 1 });
    expect(Object.keys(dump.outbox).some((k) => k.startsWith('out-10/'))).toBe(false);

    const ops = dump.log.map((l) => l.op);
    const lastWrite = ops.lastIndexOf('outboxWrite');
    const sendIdx = dump.log.findIndex((l) => l.op === 'writeMessageOut' && (l.args[0] as any).id === 'out-9');
    expect(lastWrite).toBeLessThan(sendIdx);
    const finals = dump.log.filter((l) => l.op === 'outboxWrite' && l.args[1] === 'report.pdf').map((l) => l.args[4]);
    expect(finals).toEqual([false, false, true]);
  });
});

describe('heartbeat', () => {
  test('a remote-mailbox container touches its mounted heartbeat file', () => {
    // The host driver sets NANOCLAW_HEARTBEAT_PATH beside the mailbox env and
    // hard-links that file at <sessionDir>/.heartbeat.
    const file = path.join(tmp(), 'hb');
    fs.writeFileSync(file, '');
    fs.utimesSync(file, 0, 0);
    process.env.NANOCLAW_HEARTBEAT_PATH = file;
    process.env.NANOCLAW_MAILBOX_URL = host.url;
    process.env.NANOCLAW_MAILBOX_TOKEN = host.token;
    process.env.NANOCLAW_MAILBOX_SESSION = host.session;
    touchHeartbeat();
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('compose', () => {
  test('selects remote when the URL is set, sqlite otherwise', () => {
    expect(createComposedMailbox({})).toBeInstanceOf(SqliteAgentMailbox);
    expect(createComposedMailbox({ NANOCLAW_MAILBOX_URL: host.url, NANOCLAW_MAILBOX_TOKEN: 't' })).toBeInstanceOf(
      RemoteAgentMailbox,
    );
    expect(() => createComposedMailbox({ NANOCLAW_MAILBOX_URL: host.url })).toThrow(/TOKEN/);
  });

  test('the registered mailbox is the composed one: remote when the URL is set', async () => {
    // compose.ts (imported above, as the runner's modules barrel does) registers at import.
    const registered = resetAgentMailboxForTesting();
    expect(registered).toBeDefined();
    process.env.NANOCLAW_MAILBOX_URL = host.url;
    process.env.NANOCLAW_MAILBOX_TOKEN = host.token;
    process.env.NANOCLAW_MAILBOX_SESSION = host.session;
    const mailbox = registered!();
    expect(mailbox).toBeInstanceOf(RemoteAgentMailbox);
    await mailbox.stop();
  });
});
