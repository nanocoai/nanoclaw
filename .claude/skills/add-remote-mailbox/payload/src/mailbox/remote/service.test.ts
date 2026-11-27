import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-test-remote-svc-${process.pid}` }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import type { RemoteSessionKey } from './ids.js';
import { startRemoteMailboxService, MAX_REQUEST_BODY_BYTES } from './service.js';
import type { RemoteMailboxService, RemoteMailboxExecutor } from './service.js';
import { createTestSession, hostInsert } from './test-fixture.js';
import { issueMailboxToken, revokeMailboxToken } from './tokens.js';

let service: RemoteMailboxService;
let key: RemoteSessionKey;
let dir: string;
let token: string;
let nextId = 1;

interface Reply {
  status: number;
  body: { id?: number; ok: boolean; result?: any; error?: { code: string; message: string } };
}

async function rpc(
  op: string,
  args: unknown[] = [],
  opts: { token?: string | null; session?: string | null; id?: number; port?: number } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = opts.token === undefined ? token : opts.token;
  const s = opts.session === undefined ? `${key.agentGroupId}/${key.sessionId}` : opts.session;
  if (t !== null) headers.authorization = `Bearer ${t}`;
  if (s !== null) headers['x-nanoclaw-session'] = s;
  const res = await fetch(`http://127.0.0.1:${opts.port ?? service.port}/v1/mailbox`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: opts.id ?? nextId++, op, args }),
  });
  return { status: res.status, body: (await res.json()) as Reply['body'] };
}

async function boot(executor?: RemoteMailboxExecutor): Promise<void> {
  service = await startRemoteMailboxService({ port: 0, executor });
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  ({ key, dir } = createTestSession());
  token = issueMailboxToken(key);
});

afterEach(async () => {
  await service?.stop();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('protocol', () => {
  it('echoes the request id and returns ok results; undefined becomes null', async () => {
    await boot();
    hostInsert(key, { id: 'm1' });
    const pending = await rpc('getPendingMessages', [10, true], { id: 4242 });
    expect(pending.status).toBe(200);
    expect(pending.body.id).toBe(4242);
    expect(pending.body.ok).toBe(true);
    expect(pending.body.result[0]).toMatchObject({ id: 'm1', sequence: 2, status: 'pending' });

    const missing = await rpc('getMessageIn', ['nope'], { id: 7 });
    expect(missing.body).toEqual({ id: 7, ok: true, result: null });

    const write = await rpc('writeMessageOut', [{ id: 'o1', kind: 'chat', content: 'x' }], { id: 8 });
    expect(write.body).toEqual({ id: 8, ok: true, result: 3 });
  });

  it('hello returns the authenticated session identity', async () => {
    await boot();
    expect((await rpc('hello')).body.result).toEqual({ agentGroupId: key.agentGroupId, sessionId: key.sessionId });
  });

  it('covers every runner operation end to end over HTTP', async () => {
    await boot();
    expect((await rpc('setState', ['k', 'v'])).body.ok).toBe(true);
    expect((await rpc('getState', ['k'])).body.result.value).toBe('v');
    expect((await rpc('deleteState', ['k'])).body.ok).toBe(true);
    expect((await rpc('getState', ['k'])).body.result).toBeNull();
    expect((await rpc('markMessages', [['a'], 'processing'])).body.ok).toBe(true);
    expect((await rpc('markScriptSkipped', [[{ id: 'b', reason: 'error' }]])).body.ok).toBe(true);
    expect((await rpc('clearStaleProcessingAcks')).body.ok).toBe(true);
    expect((await rpc('setContainerToolInFlight', ['Bash', null])).body.ok).toBe(true);
    expect((await rpc('clearContainerToolInFlight')).body.ok).toBe(true);
    expect((await rpc('getSessionRouting')).body.result).toEqual({
      channelType: null,
      platformId: null,
      threadId: null,
    });
    expect((await rpc('getDestinations')).body.result).toEqual([]);
    expect((await rpc('findDestinationByName', ['x'])).body.result).toBeNull();
    expect((await rpc('findDestinationByRouting', ['tg', 'x'])).body.result).toBeNull();
    expect((await rpc('findQuestionResponse', ['q'])).body.result).toBeNull();
    expect((await rpc('findCliResponse', ['r'])).body.result).toBeNull();
    expect((await rpc('getMessageIdBySeq', [5])).body.result).toBeNull();
    expect((await rpc('getRoutingBySeq', [5])).body.result).toBeNull();
    expect((await rpc('getLatestInboundRoute', ['tg', 'x'])).body.result).toBeNull();
    expect((await rpc('getUndeliveredMessages')).body.result).toEqual([]);
    expect((await rpc('getDeliveryStatus', ['o'])).body.result).toBeNull();
  });

  it('answers 400 for malformed JSON, unknown ops and bad shapes; 404/405 for the wrong route', async () => {
    await boot();
    const base = `http://127.0.0.1:${service.port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      'x-nanoclaw-session': `${key.agentGroupId}/${key.sessionId}`,
      'content-type': 'application/json',
    };
    expect((await fetch(`${base}/v1/mailbox`, { method: 'POST', headers, body: '{nope' })).status).toBe(400);
    expect((await rpc('dropEverything')).status).toBe(400);
    expect((await rpc('__proto__')).status).toBe(400);
    expect((await rpc('constructor')).status).toBe(400);
    expect((await fetch(`${base}/v1/mailbox`, { method: 'POST', headers, body: '[]' })).status).toBe(400);
    expect(
      (
        await fetch(`${base}/v1/mailbox`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: 'x', op: 'hello', args: [] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/v1/mailbox`, { method: 'POST', headers, body: JSON.stringify({ id: 1, op: 'hello' }) }))
        .status,
    ).toBe(400);
    expect((await fetch(`${base}/v1/mailbox`, { method: 'GET', headers })).status).toBe(405);
    expect((await fetch(`${base}/elsewhere`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
  });

  it('reports bad arguments as an op-level invalid_args error, not a crash', async () => {
    await boot();
    const reply = await rpc('getMessageIn', [123]);
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error?.code).toBe('invalid_args');
    expect((await rpc('markMessages', [['a'], 'bogus'])).body.error?.code).toBe('invalid_args');
    expect((await rpc('getMessageIn', [])).body.error?.code).toBe('invalid_args');
  });

  it('reports a vanished session as session_unavailable once authenticated', async () => {
    await boot();
    fs.rmSync(dir, { recursive: true, force: true });
    expect((await rpc('getUndeliveredMessages')).body.error?.code).toBe('session_unavailable');
  });
});

describe('authentication', () => {
  it('rejects a missing token, a wrong token and a missing session header with 401', async () => {
    await boot();
    const wrong = issueMailboxToken({ agentGroupId: 'ag-x', sessionId: 'sess-x' });
    for (const opts of [{ token: null }, { token: wrong }, { token: 'garbage' }, { session: null }]) {
      const reply = await rpc('hello', [], opts);
      expect(reply.status).toBe(401);
      expect(reply.body.ok).toBe(false);
      expect(reply.body.error?.code).toBe('unauthorized');
    }
  });

  it("a session A token against session B's header is 401 and indistinguishable from an unknown session", async () => {
    await boot();
    const b = createTestSession('ag-test', 'sess-b').key;
    issueMailboxToken(b);
    const toExisting = await rpc('hello', [], { session: 'ag-test/sess-b' });
    const toMissing = await rpc('hello', [], { session: 'ag-test/sess-does-not-exist' });
    expect(toExisting.status).toBe(401);
    expect(toMissing.status).toBe(401);
    expect(toExisting.body).toEqual(toMissing.body);
  });

  it('rejects a revoked token', async () => {
    await boot();
    expect((await rpc('hello')).status).toBe(200);
    revokeMailboxToken(key);
    expect((await rpc('hello')).status).toBe(401);
  });

  it('rejects malformed session ids in the header', async () => {
    await boot();
    for (const session of [
      '../ag-test/sess-test',
      'ag-test/../sess-test',
      'ag-test',
      'ag-test/sess-test/x',
      '/ag-test/sess-test',
    ]) {
      expect((await rpc('hello', [], { session })).status).toBe(401);
    }
  });

  it('never runs an op for an unauthenticated caller', async () => {
    const calls: string[] = [];
    await boot(async (_k, operation) => void calls.push(operation));
    await rpc('hello', [], { token: 'nope' });
    expect(calls).toEqual([]);
    await rpc('hello');
    expect(calls).toEqual(['hello']);
  });
});

describe('body limit and network exposure', () => {
  it('rejects an oversized declared body with 413 before reading it', async () => {
    await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: service.port,
          method: 'POST',
          path: '/v1/mailbox',
          headers: {
            authorization: `Bearer ${token}`,
            'x-nanoclaw-session': `${key.agentGroupId}/${key.sessionId}`,
            'content-type': 'application/json',
            'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      req.write('{"id":1');
    });
    expect(status).toBe(413);
  });

  it('rejects an oversized chunked body (no content-length) with 413 and stays healthy', async () => {
    await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: service.port,
          method: 'POST',
          path: '/v1/mailbox',
          headers: {
            authorization: `Bearer ${token}`,
            'x-nanoclaw-session': `${key.agentGroupId}/${key.sessionId}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', (err) => {
        if (!['ECONNRESET', 'EPIPE'].includes((err as NodeJS.ErrnoException).code ?? '')) reject(err);
      });
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 9; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
    expect((await rpc('hello')).status).toBe(200);
  });

  it('accepts a body just under the limit', async () => {
    await boot();
    const big = 'a'.repeat(MAX_REQUEST_BODY_BYTES - 1024);
    const reply = await rpc('setState', ['big', big]);
    expect(reply.body.ok).toBe(true);
  });

  it('listens on loopback only', async () => {
    await boot();
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (external) {
      const refused = await new Promise<string>((resolve) => {
        const socket = net.connect({ host: external.address, port: service.port });
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', (err) => resolve((err as NodeJS.ErrnoException).code ?? 'error'));
      });
      expect(refused).toBe('ECONNREFUSED');
    }
    const probe = net.connect({ host: '127.0.0.1', port: service.port });
    await new Promise<void>((resolve, reject) => {
      probe.once('connect', resolve);
      probe.once('error', reject);
    });
    probe.destroy();
  });
});

describe('per-session serialization', () => {
  it('runs one request at a time per session but sessions in parallel', async () => {
    let running = 0;
    let maxRunning = 0;
    const perSessionMax = new Map<string, number>();
    const perSession = new Map<string, number>();
    const order: string[] = [];
    await boot(async (k, _op, args) => {
      const name = `${k.agentGroupId}/${k.sessionId}`;
      running++;
      maxRunning = Math.max(maxRunning, running);
      const here = (perSession.get(name) ?? 0) + 1;
      perSession.set(name, here);
      perSessionMax.set(name, Math.max(perSessionMax.get(name) ?? 0, here));
      order.push(`start ${String(args[0])}`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`end ${String(args[0])}`);
      perSession.set(name, here - 1);
      running--;
      return args[0];
    });
    const other = createTestSession('ag-test', 'sess-other').key;
    const otherToken = issueMailboxToken(other);

    const replies = await Promise.all([
      rpc('getState', ['a1']),
      rpc('getState', ['a2']),
      rpc('getState', ['a3']),
      rpc('getState', ['b1'], { token: otherToken, session: 'ag-test/sess-other' }),
    ]);
    expect(replies.map((r) => r.body.result)).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(perSessionMax.get('ag-test/sess-test')).toBe(1);
    expect(perSessionMax.get('ag-test/sess-other')).toBe(1);
    expect(maxRunning).toBe(2); // the other session overlapped
    // Same-session requests ran in arrival order, strictly nested start/end.
    const own = order.filter((e) => /a\d/.test(e));
    expect(own).toEqual(['start a1', 'end a1', 'start a2', 'end a2', 'start a3', 'end a3']);
  });

  it('keeps serving the session after an op throws', async () => {
    let calls = 0;
    await boot(async () => {
      if (calls++ === 0) throw new Error('boom');
      return 'fine';
    });
    const [first, second] = await Promise.all([rpc('getState', ['x']), rpc('getState', ['x'])]);
    expect(first.body.ok).toBe(false);
    expect(first.body.error?.code).toBe('op_failed');
    expect(second.body.result).toBe('fine');
  });
});

describe('inbox', () => {
  beforeEach(async () => {
    await boot();
    fs.mkdirSync(path.join(dir, 'inbox', 'msg-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'inbox', 'msg-1', 'a.txt'), 'hello world');
    fs.writeFileSync(path.join(dir, 'inbox', 'top.bin'), Buffer.from([1, 2, 3]));
  });

  it('lists regular files with relative /-separated paths, size and mtime', async () => {
    const list = (await rpc('inboxList')).body.result as Array<{ path: string; size: number; mtimeMs: number }>;
    expect(list.map((e) => e.path).sort()).toEqual(['msg-1/a.txt', 'top.bin']);
    const a = list.find((e) => e.path === 'msg-1/a.txt')!;
    expect(a.size).toBe(11);
    expect(a.mtimeMs).toBeGreaterThan(0);
  });

  it('is empty when there is no inbox', async () => {
    fs.rmSync(path.join(dir, 'inbox'), { recursive: true });
    expect((await rpc('inboxList')).body.result).toEqual([]);
  });

  it('reads in chunks with eof', async () => {
    const first = (await rpc('inboxRead', ['msg-1/a.txt', 0, 5])).body.result;
    expect(Buffer.from(first.data, 'base64').toString()).toBe('hello');
    expect(first.eof).toBe(false);
    const rest = (await rpc('inboxRead', ['msg-1/a.txt', 5, 100])).body.result;
    expect(Buffer.from(rest.data, 'base64').toString()).toBe(' world');
    expect(rest.eof).toBe(true);
    const past = (await rpc('inboxRead', ['msg-1/a.txt', 50, 10])).body.result;
    expect(past).toEqual({ data: '', eof: true });
  });

  it('rejects lengths above 4 MiB and negative or fractional offsets', async () => {
    expect((await rpc('inboxRead', ['top.bin', 0, 4 * 1024 * 1024 + 1])).body.error?.code).toBe('path_rejected');
    expect((await rpc('inboxRead', ['top.bin', -1, 1])).body.error?.code).toBe('path_rejected');
    expect((await rpc('inboxRead', ['top.bin', 0.5, 1])).body.error?.code).toBe('path_rejected');
    expect((await rpc('inboxRead', ['top.bin', 0, 4 * 1024 * 1024])).body.ok).toBe(true);
  });

  it('rejects traversal, absolute paths, NUL, backslashes and empty segments', async () => {
    fs.writeFileSync(path.join(TEST_DIR, 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(dir, 'outbound-neighbour'), 'secret');
    for (const bad of [
      '../secret.txt',
      '../../secret.txt',
      'msg-1/../../outbound-neighbour',
      '/etc/passwd',
      path.join(TEST_DIR, 'secret.txt'),
      'msg-1/a.txt\0',
      'a\0b',
      'msg-1\\a.txt',
      'msg-1//a.txt',
      '',
      '.',
      '..',
      42,
    ]) {
      const reply = await rpc('inboxRead', [bad, 0, 10]);
      expect(reply.body.ok, JSON.stringify(bad)).toBe(false);
      expect(reply.body.error?.code, JSON.stringify(bad)).toBe('path_rejected');
    }
  });

  it('refuses a symlinked file, lists nothing for it, and never leaks the target', async () => {
    const secret = path.join(TEST_DIR, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    fs.symlinkSync(secret, path.join(dir, 'inbox', 'msg-1', 'link.txt'));
    const reply = await rpc('inboxRead', ['msg-1/link.txt', 0, 100]);
    expect(reply.body.ok).toBe(false);
    expect(JSON.stringify(reply.body)).not.toContain('TOP SECRET');
    const list = (await rpc('inboxList')).body.result as Array<{ path: string }>;
    expect(list.map((e) => e.path)).not.toContain('msg-1/link.txt');
  });

  it('refuses a symlinked directory component and does not descend into it when listing', async () => {
    const outside = path.join(TEST_DIR, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.txt'), 'outside data');
    fs.symlinkSync(outside, path.join(dir, 'inbox', 'escape'));
    const reply = await rpc('inboxRead', ['escape/x.txt', 0, 100]);
    expect(reply.body.ok).toBe(false);
    expect(JSON.stringify(reply.body)).not.toContain('outside data');
    const list = (await rpc('inboxList')).body.result as Array<{ path: string }>;
    expect(list.some((e) => e.path.startsWith('escape'))).toBe(false);
  });

  it('refuses an inbox that is itself a symlink', async () => {
    const outside = path.join(TEST_DIR, 'outside-inbox');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.txt'), 'outside data');
    fs.rmSync(path.join(dir, 'inbox'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'inbox'));
    expect((await rpc('inboxList')).body.error?.code).toBe('path_rejected');
    expect((await rpc('inboxRead', ['x.txt', 0, 10])).body.error?.code).toBe('path_rejected');
  });

  it('refuses a FIFO without blocking, and does not list it', async () => {
    const fifo = path.join(dir, 'inbox', 'pipe');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    const reply = await rpc('inboxRead', ['pipe', 0, 10]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reply.body.ok).toBe(false);
    expect(reply.body.error?.code).toBe('path_rejected');
    const list = (await rpc('inboxList')).body.result as Array<{ path: string }>;
    expect(list.map((e) => e.path)).not.toContain('pipe');
    // The service is still responsive.
    expect((await rpc('hello')).status).toBe(200);
  });
});

describe('outbox', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  beforeEach(async () => {
    await boot();
  });

  it('stages chunks and renames into place only on the final chunk', async () => {
    const final = path.join(dir, 'outbox', 'msg-1', 'report.txt');
    expect((await rpc('outboxWrite', ['msg-1', 'report.txt', 0, b64('hello '), false])).body).toMatchObject({
      ok: true,
      result: null,
    });
    expect(fs.existsSync(final)).toBe(false);
    expect((await rpc('outboxWrite', ['msg-1', 'report.txt', 6, b64('world'), true])).body.ok).toBe(true);
    expect(fs.readFileSync(final, 'utf8')).toBe('hello world');
    expect(fs.readdirSync(path.dirname(final))).toEqual(['report.txt']); // no temp left behind
  });

  it('rejects an out-of-order chunk and restarts cleanly at offset 0', async () => {
    await rpc('outboxWrite', ['m', 'f.txt', 0, b64('abc'), false]);
    expect((await rpc('outboxWrite', ['m', 'f.txt', 5, b64('zzz'), true])).body.error?.code).toBe('path_rejected');
    expect((await rpc('outboxWrite', ['m', 'f.txt', 0, b64('xy'), true])).body.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'outbox', 'm', 'f.txt'), 'utf8')).toBe('xy');
  });

  it('is safe to replay: repeated chunks, including a lost-reply final chunk, do not corrupt the file', async () => {
    const final = path.join(dir, 'outbox', 'm', 'f.txt');
    await rpc('outboxWrite', ['m', 'f.txt', 0, b64('abc'), false]);
    await rpc('outboxWrite', ['m', 'f.txt', 0, b64('abc'), false]); // replay of first chunk
    await rpc('outboxWrite', ['m', 'f.txt', 3, b64('def'), false]);
    expect((await rpc('outboxWrite', ['m', 'f.txt', 3, b64('def'), false])).body.ok).toBe(true); // replay mid-file
    expect((await rpc('outboxWrite', ['m', 'f.txt', 6, b64('ghi'), true])).body.ok).toBe(true);
    expect((await rpc('outboxWrite', ['m', 'f.txt', 6, b64('ghi'), true])).body.ok).toBe(true); // replay after rename
    expect(fs.readFileSync(final, 'utf8')).toBe('abcdefghi');
    expect(fs.readdirSync(path.dirname(final))).toEqual(['f.txt']);
    // A different payload at an already-applied offset is still refused.
    expect((await rpc('outboxWrite', ['m', 'f.txt', 6, b64('XXX'), true])).body.error?.code).toBe('path_rejected');
    expect(fs.readFileSync(final, 'utf8')).toBe('abcdefghi');
  });

  it('handles an empty single-chunk file', async () => {
    expect((await rpc('outboxWrite', ['m', 'empty', 0, '', true])).body.ok).toBe(true);
    expect(fs.statSync(path.join(dir, 'outbox', 'm', 'empty')).size).toBe(0);
  });

  it('rejects unsafe message ids and filenames and writes nothing outside the outbox', async () => {
    const attempts: Array<[unknown, unknown]> = [
      ['../escape', 'f.txt'],
      ['..', 'f.txt'],
      ['a/b', 'f.txt'],
      ['/abs', 'f.txt'],
      ['m\0', 'f.txt'],
      ['', 'f.txt'],
      ['m', '../f.txt'],
      ['m', '..'],
      ['m', '.'],
      ['m', 'a/b.txt'],
      ['m', '/etc/passwd'],
      ['m', 'a\\b'],
      ['m', 'f\0.txt'],
      ['m', '.hidden'],
      ['m', 'x'.repeat(256)],
      ['m', ''],
    ];
    for (const [messageId, filename] of attempts) {
      const reply = await rpc('outboxWrite', [messageId, filename, 0, b64('PWNED'), true]);
      expect(reply.body.ok, JSON.stringify([messageId, filename])).toBe(false);
      expect(reply.body.error?.code).toBe('path_rejected');
    }
    expect(fs.existsSync(path.join(dir, 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'outbox', 'f.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'f.txt'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_DIR, 'f.txt'))).toBe(false);
  });

  it('rejects invalid data and flag types', async () => {
    expect((await rpc('outboxWrite', ['m', 'f', 0, '!!!not base64', true])).body.error?.code).toBe('path_rejected');
    expect((await rpc('outboxWrite', ['m', 'f', 0, b64('x'), 'yes'])).body.error?.code).toBe('path_rejected');
    expect((await rpc('outboxWrite', ['m', 'f', -1, b64('x'), true])).body.error?.code).toBe('path_rejected');
    expect((await rpc('outboxWrite', ['m', 'f'])).body.error?.code).toBe('invalid_args');
  });

  it('refuses an outbox directory that is a symlink and writes nothing through it', async () => {
    const outside = path.join(TEST_DIR, 'outside-outbox');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, 'outbox'));
    expect((await rpc('outboxWrite', ['m', 'f.txt', 0, b64('PWNED'), true])).body.error?.code).toBe('path_rejected');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a per-message directory that is a symlink', async () => {
    const outside = path.join(TEST_DIR, 'outside-msg');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(dir, 'outbox'));
    fs.symlinkSync(outside, path.join(dir, 'outbox', 'm'));
    expect((await rpc('outboxWrite', ['m', 'f.txt', 0, b64('PWNED'), true])).body.error?.code).toBe('path_rejected');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('replaces a symlink planted at the final name instead of following it', async () => {
    const victim = path.join(TEST_DIR, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.mkdirSync(path.join(dir, 'outbox', 'm'), { recursive: true });
    fs.symlinkSync(victim, path.join(dir, 'outbox', 'm', 'f.txt'));
    expect((await rpc('outboxWrite', ['m', 'f.txt', 0, b64('new'), true])).body.ok).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
    expect(fs.lstatSync(path.join(dir, 'outbox', 'm', 'f.txt')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'outbox', 'm', 'f.txt'), 'utf8')).toBe('new');
  });
});
