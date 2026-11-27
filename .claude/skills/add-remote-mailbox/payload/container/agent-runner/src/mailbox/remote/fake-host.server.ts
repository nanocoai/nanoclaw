/**
 * Fake mailbox host for tests, following the wire spec with in-memory state.
 * Runs as its own process: the runner client blocks its thread on every call,
 * so a server in the same event loop could never answer.
 *
 * env: PORT, TOKEN, SESSION (`<group>/<session>`), START_DELAY_MS
 * control plane (not part of the spec): POST /_ctl {cmd, ...}
 */
const PORT = Number(process.env.PORT);
const TOKEN = process.env.TOKEN ?? 'token';
const SESSION = process.env.SESSION ?? 'ag-1/sess-1';
const [AGENT_GROUP, SESSION_ID] = SESSION.split('/');

const files = new Map<string, { data: Buffer; mtimeMs: number }>();
const outbox = new Map<string, { chunks: Buffer[]; complete: boolean }>();
const state = new Map<string, { value: string; updatedAt: string }>();
const outbound: Array<Record<string, unknown>> = [];
let pending: Array<Record<string, unknown>> = [];
const log: Array<{ op: string; args: unknown[]; session: string | null; id: number }> = [];
let nextSeq = 1;
let delayNextMs = 0;
let wrongIdNext = false;
let rejectAll = false;
let inboxReads = 0;
let maliciousInbox: Array<{ path: string; size: number; mtimeMs: number }> = [];

function handleOp(op: string, a: unknown[]): unknown {
  switch (op) {
    case 'hello':
      return { agentGroupId: AGENT_GROUP, sessionId: SESSION_ID };
    case 'getPendingMessages':
      return pending.slice(0, a[0] as number);
    case 'markMessages':
      pending = pending.filter((m) => !(a[0] as string[]).includes(m.id as string));
      return null;
    case 'markScriptSkipped':
    case 'setContainerToolInFlight':
    case 'clearContainerToolInFlight':
    case 'clearStaleProcessingAcks':
    case 'deleteState':
      if (op === 'deleteState') state.delete(a[0] as string);
      return null;
    case 'getMessageIn':
    case 'findQuestionResponse':
    case 'findCliResponse':
      return pending.find((m) => m.id === a[0]) ?? null;
    case 'writeMessageOut': {
      const seq = nextSeq;
      nextSeq += 2; // container parity: odd
      outbound.push({ ...(a[0] as object), sequence: seq });
      return seq;
    }
    case 'getMessageIdBySeq':
      return (outbound.find((m) => m.sequence === a[0])?.id as string | undefined) ?? null;
    case 'getRoutingBySeq':
      return outbound.some((m) => m.sequence === a[0])
        ? { channelType: 'telegram', platformId: 'p1', threadId: null }
        : null;
    case 'getLatestInboundRoute':
      return { threadId: null, inReplyTo: 'in-1' };
    case 'getUndeliveredMessages':
      return outbound;
    case 'getDeliveryStatus':
      return null;
    case 'getState':
      return state.get(a[0] as string) ?? null;
    case 'setState':
      state.set(a[0] as string, { value: a[1] as string, updatedAt: new Date().toISOString() });
      return null;
    case 'getSessionRouting':
      return { channelType: 'telegram', platformId: 'p1', threadId: null };
    case 'getDestinations':
      return [{ name: 'main', displayName: 'Main', type: 'channel', channelType: 'telegram', platformId: 'p1' }];
    case 'findDestinationByName':
      return a[0] === 'main' ? { name: 'main', type: 'channel', channelType: 'telegram', platformId: 'p1' } : null;
    case 'findDestinationByRouting':
      return null;
    case 'inboxList':
      return [...[...files].map(([path, f]) => ({ path, size: f.data.length, mtimeMs: f.mtimeMs })), ...maliciousInbox];
    case 'inboxRead': {
      inboxReads++;
      const f = files.get(a[0] as string);
      if (!f) throw new Error('no such file');
      const offset = a[1] as number;
      const length = Math.min(a[2] as number, 4 * 1024 * 1024);
      return {
        data: f.data.subarray(offset, offset + length).toString('base64'),
        eof: offset + length >= f.data.length,
      };
    }
    case 'outboxWrite': {
      const key = `${a[0]}/${a[1]}`;
      const entry = outbox.get(key) ?? { chunks: [], complete: false };
      if ((a[2] as number) !== entry.chunks.reduce((n, c) => n + c.length, 0)) throw new Error('bad offset');
      entry.chunks.push(Buffer.from(a[3] as string, 'base64'));
      entry.complete = a[4] === true;
      outbox.set(key, entry);
      return null;
    }
    default:
      return undefined;
  }
}

const KNOWN = new Set([
  'hello',
  'getPendingMessages',
  'markMessages',
  'markScriptSkipped',
  'getMessageIn',
  'findQuestionResponse',
  'findCliResponse',
  'writeMessageOut',
  'getMessageIdBySeq',
  'getRoutingBySeq',
  'getLatestInboundRoute',
  'getUndeliveredMessages',
  'getDeliveryStatus',
  'getState',
  'setState',
  'deleteState',
  'getSessionRouting',
  'getDestinations',
  'findDestinationByName',
  'findDestinationByRouting',
  'setContainerToolInFlight',
  'clearContainerToolInFlight',
  'clearStaleProcessingAcks',
  'inboxList',
  'inboxRead',
  'outboxWrite',
]);

async function control(body: Record<string, any>): Promise<unknown> {
  switch (body.cmd) {
    case 'seed':
      for (const [p, b64] of Object.entries(body.files ?? {})) {
        files.set(p, { data: Buffer.from(b64 as string, 'base64'), mtimeMs: body.mtimeMs ?? 1_700_000_000_000 });
      }
      if (body.pending) pending = body.pending;
      if (body.malicious) maliciousInbox = body.malicious;
      return {};
    case 'delayNext':
      delayNextMs = body.ms;
      return {};
    case 'wrongIdNext':
      wrongIdNext = true;
      return {};
    case 'rejectAll':
      rejectAll = body.value;
      return {};
    case 'dump':
      return {
        log,
        inboxReads,
        outbound,
        outbox: Object.fromEntries(
          [...outbox].map(([k, v]) => [
            k,
            { data: Buffer.concat(v.chunks).toString('base64'), complete: v.complete, chunks: v.chunks.length },
          ]),
        ),
      };
    default:
      return {};
  }
}

const start = () =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/_ctl') return Response.json(await control(await req.json()));
      if (url.pathname !== '/v1/mailbox' || req.method !== 'POST') return new Response('not found', { status: 404 });
      const unauthorized = () =>
        Response.json({ ok: false, error: { code: 'unauthorized', message: 'unauthorized' } }, { status: 401 });
      if (rejectAll || req.headers.get('authorization') !== `Bearer ${TOKEN}`) return unauthorized();
      const session = req.headers.get('x-nanoclaw-session');
      if (session !== SESSION) return unauthorized();
      let body: { id: number; op: string; args: unknown[] };
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: { code: 'bad_request', message: 'bad json' } }, { status: 400 });
      }
      if (!KNOWN.has(body.op)) {
        return Response.json({ ok: false, error: { code: 'unknown_op', message: body.op } }, { status: 400 });
      }
      log.push({ op: body.op, args: body.args, session, id: body.id });
      if (delayNextMs) {
        const ms = delayNextMs;
        delayNextMs = 0;
        await Bun.sleep(ms);
      }
      let id = body.id;
      if (wrongIdNext) {
        wrongIdNext = false;
        id = body.id - 1000;
      }
      try {
        const result = handleOp(body.op, body.args);
        return Response.json({ id, ok: true, result: result === undefined ? null : result });
      } catch (error) {
        return Response.json({ id, ok: false, error: { code: 'op_failed', message: String(error) } });
      }
    },
  });

const delay = Number(process.env.START_DELAY_MS ?? 0);
if (delay) await Bun.sleep(delay);
start();
console.log('ready');
