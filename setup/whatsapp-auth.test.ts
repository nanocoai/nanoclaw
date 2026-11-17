import { EventEmitter } from 'events';
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Creds = Record<string, unknown>;
type MockSocket = {
  ev: EventEmitter;
  end: ReturnType<typeof vi.fn>;
  requestPairingCode: ReturnType<typeof vi.fn>;
};

// Baileys and pino are installed by /add-whatsapp, not by trunk, so both are mocked.
const sockets: MockSocket[] = [];
// store/auth/creds.json as the step would read it; a creds write that lands updates it.
let disk: string | undefined;
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn((config: { auth: { creds: Creds } }) => {
    const ev = new EventEmitter();
    // Like Baileys, merge each creds update into the creds before other listeners see it.
    ev.on('creds.update', (update: Creds) => Object.assign(config.auth.creds, update));
    // Like Baileys, end() emits the close synchronously.
    const end = vi.fn(() =>
      ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: undefined } }),
    );
    // Like Baileys, a requested code stores a placeholder `me` before any pairing.
    const requestPairingCode = vi.fn(async (phone: string) => {
      config.auth.creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' };
      ev.emit('creds.update', config.auth.creds);
      return 'ABCD1234';
    });
    const sock = { ev, end, requestPairingCode, user: { id: '14155551234:7@s.whatsapp.net' } };
    sockets.push(sock);
    return sock;
  }),
  Browsers: { macOS: (browser: string) => ['Mac OS', browser, '14.4.1'] },
  DisconnectReason: { loggedOut: 401, timedOut: 408 },
  fetchLatestWaWebVersion: vi.fn(async () => ({ version: [2, 3000, 1049214511], isLatest: true })),
  makeCacheableSignalKeyStore: vi.fn(() => ({})),
  useMultiFileAuthState: vi.fn(async () => {
    const creds = {};
    return { state: { creds, keys: {} }, saveCreds: vi.fn(async () => void (disk = JSON.stringify(creds))) };
  }),
}));
vi.mock('pino', () => ({ pino: () => ({}) }));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

const { run } = await import('./whatsapp-auth.js');
const { makeWASocket, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
const { emitStatus } = await import('./status.js');

class Exit extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

const blocks = () => vi.mocked(emitStatus).mock.calls;
const failed = (error: string) => [['WHATSAPP_AUTH', { STATUS: 'failed', ERROR: error }]];
const BEFORE = (detail: string) =>
  `WhatsApp closed the connection before linking (${detail}). Clear store/auth/ and run the step again.`;
const AFTER = (detail: string) =>
  `WhatsApp closed the connection after pairing (${detail}). The link is saved in store/auth/, so run the step again to use it.`;
const PROBABLY_SAVED = (detail: string) =>
  `WhatsApp closed the connection after pairing (${detail}). The link is probably saved in store/auth/ (a creds write had not finished), so run the step again to use it.`;
const NOT_SAVED = (detail: string) =>
  `WhatsApp closed the connection after pairing (${detail}), but the link was not saved. Clear store/auth/ and run the step again.`;
const NO_LINK =
  'store/auth/ has WhatsApp credentials but no linked device (for example, from a pairing code that was never entered). Clear store/auth/ and run the step again.';
const NOT_JSON =
  'store/auth/creds.json is not valid JSON (it may be mid-write). Stop the NanoClaw service if it is running, then run the step again.';
const CANNOT_OPEN = (code: string) =>
  `store/auth/creds.json could not be opened (${code}). Make it readable by the user running setup, then run the step again.`;
const UNREADABLE_AFTER = (detail: string) =>
  `WhatsApp closed the connection after pairing (${detail}), but store/auth/creds.json could not be read. Run the step again to check the saved link.`;

const PHONE = '14155551234';
const METHODS = ['qr', 'pairing-code'] as const;
type Method = (typeof METHODS)[number];
// A finished pairing saves the device and its `account`; a requested code saves only `me`.
const PAIRED: Creds = { me: { id: `${PHONE}:7@s.whatsapp.net` }, account: { details: 'signed-device-identity' } };
const REQUESTED_CODE: Creds = { me: { id: `${PHONE}@s.whatsapp.net`, name: '~' } };

const authState = (creds: Creds, saveCreds: () => Promise<void> = async () => void (disk = JSON.stringify(creds))) =>
  ({ state: { creds, keys: {} }, saveCreds }) as never;

const close = (sock: MockSocket, statusCode: number, message: string) => () =>
  sock.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) },
  });

/** What Baileys emits on pair-success: the new device's creds, then isNewLogin. */
function pair(sock: MockSocket): void {
  sock.ev.emit('creds.update', PAIRED);
  sock.ev.emit('connection.update', { isNewLogin: true, qr: undefined });
}

/** Start the step; for a pairing code, wait until the code is shown. */
async function connected(method: Method = 'qr'): Promise<MockSocket> {
  const args = method === 'qr' ? ['--method', 'qr'] : ['--method', 'pairing-code', '--phone', PHONE];
  void run(args).catch(() => {});
  await vi.waitFor(() => expect(makeWASocket).toHaveBeenCalledTimes(1));
  if (method === 'pairing-code') {
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(blocks()).toEqual([['WHATSAPP_AUTH_PAIRING_CODE', { CODE: 'ABCD1234' }]]));
    vi.mocked(emitStatus).mockClear();
  }
  return sockets[0];
}

/** WhatsApp restarts the stream (515) and the step reconnects; `saved` is what it reads from store/auth/. */
async function reconnectedAfter515(method: Method, saved: Creds, saveCreds?: () => Promise<void>): Promise<MockSocket> {
  const first = await connected(method);
  disk = JSON.stringify(saved);
  vi.mocked(useMultiFileAuthState).mockResolvedValueOnce(authState({ ...saved }, saveCreds));
  expect(close(first, 515, 'Stream Errored (restart required)')).not.toThrow();
  await vi.waitFor(() => expect(makeWASocket).toHaveBeenCalledTimes(2));
  expect(blocks()).toEqual([]);
  return sockets[1];
}

const realReadFileSync = fs.readFileSync;

beforeEach(() => {
  sockets.length = 0;
  disk = undefined;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Nothing reaches the network: any tracker fetch fails and the mocked Baileys lookup answers.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline in tests');
    }),
  );
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: never) => {
    if (!String(file).endsWith('creds.json')) return realReadFileSync(file, options);
    if (disk === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return disk;
  }) as typeof fs.readFileSync);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exit(code);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('whatsapp-auth step', () => {
  it('reports a finished pairing in store/auth/ as already linked', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    disk = JSON.stringify(PAIRED);

    await run(['--method', 'qr']);

    expect(makeWASocket).not.toHaveBeenCalled();
    expect(blocks()).toEqual([
      ['WHATSAPP_AUTH', { STATUS: 'skipped', REASON: 'already-authenticated', AUTH_DIR: expect.any(String), PHONE }],
    ]);
  });

  it('reports a finished pairing with an odd `me` as linked, with no number', async () => {
    disk = JSON.stringify({ ...PAIRED, me: { id: 14155551234 } });

    await run(['--method', 'qr']);

    expect(blocks()).toEqual([
      [
        'WHATSAPP_AUTH',
        { STATUS: 'skipped', REASON: 'already-authenticated', AUTH_DIR: expect.any(String), PHONE: '' },
      ],
    ]);
  });

  it.each([
    // Only a creds.json that parses and lacks a pairing may be cleared.
    ['a pairing code that was never entered', JSON.stringify(REQUESTED_CODE), NO_LINK],
    // One still cut short after 1 s may yet hold a link, so it is not cleared.
    ['a creds.json cut short', '{"me":', NOT_JSON],
  ])('%s in store/auth/ is not reported as linked', async (_name, saved, error) => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    disk = saved;

    const result = run(['--method', 'pairing-code', '--phone', PHONE]).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await result).toBeInstanceOf(Exit);
    expect(makeWASocket).not.toHaveBeenCalled();
    expect(blocks()).toEqual(failed(error));
  });

  it('does not call a creds.json it may not open damaged', async () => {
    const read = vi.mocked(fs.readFileSync).getMockImplementation()!;
    vi.mocked(fs.readFileSync).mockImplementation(((file: fs.PathOrFileDescriptor, options?: never) => {
      // For example, store/auth/ belongs to the service's user.
      if (String(file).endsWith('creds.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return read(file, options);
    }) as typeof fs.readFileSync);

    const result = run(['--method', 'qr']).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await result).toBeInstanceOf(Exit);
    expect(makeWASocket).not.toHaveBeenCalled();
    expect(blocks()).toEqual(failed(CANNOT_OPEN('EACCES')));
  });

  it('judges creds.json by one read, even if a running service rewrites it right after', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    disk = JSON.stringify(PAIRED);
    const read = vi.mocked(fs.readFileSync).getMockImplementation()!;
    vi.mocked(fs.readFileSync).mockImplementation(((file: fs.PathOrFileDescriptor, options?: never) => {
      const data = read(file, options);
      // The service truncates creds.json to rewrite it just after the step reads it.
      if (String(file).endsWith('creds.json')) disk = '';
      return data;
    }) as typeof fs.readFileSync);

    await run(['--method', 'qr']);

    expect(makeWASocket).not.toHaveBeenCalled();
    expect(blocks()).toEqual([
      ['WHATSAPP_AUTH', { STATUS: 'skipped', REASON: 'already-authenticated', AUTH_DIR: expect.any(String), PHONE }],
    ]);
  });

  it('reads a creds.json that a running service is rewriting again before judging it', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Baileys rewrites creds.json in place: for a moment it is empty.
    disk = '';

    const result = run(['--method', 'qr']);
    await vi.advanceTimersByTimeAsync(100);
    disk = JSON.stringify(PAIRED);
    await vi.advanceTimersByTimeAsync(200);
    await result;

    expect(makeWASocket).not.toHaveBeenCalled();
    expect(blocks()).toEqual([
      ['WHATSAPP_AUTH', { STATUS: 'skipped', REASON: 'already-authenticated', AUTH_DIR: expect.any(String), PHONE }],
    ]);
  });

  it.each(METHODS)('%s: fails at once with the reason when WhatsApp refuses the connection', async (method) => {
    const sock = await connected(method);

    expect(close(sock, 405, 'Connection Failure')).toThrow('process.exit(1)');
    expect(blocks()).toEqual(failed(BEFORE('405 Connection Failure')));
  });

  it('does not report its own close after a successful link as a failure', async () => {
    const sock = await connected();

    sock.ev.emit('connection.update', { connection: 'open' });

    expect(sock.end).toHaveBeenCalled();
    expect(blocks()).toEqual([['WHATSAPP_AUTH', { STATUS: 'success', PHONE }]]);
    expect(() => vi.advanceTimersByTime(1000)).toThrow('process.exit(0)');
  });

  it.each(METHODS)('%s: reconnects after a 515 and reports the link once the new socket opens', async (method) => {
    const sock = await reconnectedAfter515(method, PAIRED);
    // A pairing code is requested on the first connect only.
    await vi.advanceTimersByTimeAsync(3000);
    expect(sock.requestPairingCode).not.toHaveBeenCalled();

    sock.ev.emit('connection.update', { connection: 'open' });

    expect(blocks()).toEqual([['WHATSAPP_AUTH', { STATUS: 'success', PHONE }]]);
    expect(() => vi.advanceTimersByTime(1000)).toThrow('process.exit(0)');
  });

  it.each([
    ['qr', 'a paired device', PAIRED, AFTER('428 Connection Closed')],
    ['pairing-code', 'a paired device', PAIRED, AFTER('428 Connection Closed')],
    ['qr', 'nothing', {}, BEFORE('428 Connection Closed')],
    ['pairing-code', 'only a requested code', REQUESTED_CODE, BEFORE('428 Connection Closed')],
  ] as const)('%s: a close after the 515 reconnect, with %s saved', async (method, _saved, creds, error) => {
    const sock = await reconnectedAfter515(method, creds);
    // After pairing, the step exits once the creds write lands, not at once.
    vi.mocked(process.exit).mockImplementation(() => undefined as never);

    close(sock, 428, 'Connection Closed')();

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(blocks()).toEqual(failed(error));
  });

  /** Pair on the first socket; its creds writes stay pending until the test settles them. */
  async function pairedWithPendingWrites(method: Method) {
    const writes: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    const creds: Creds = {};
    // Each write saves the creds as they are when it starts.
    const saveCreds = () => {
      const snapshot = JSON.stringify(creds);
      return new Promise<void>((resolve, reject) =>
        writes.push({ resolve: () => ((disk = snapshot), resolve()), reject }),
      );
    };
    vi.mocked(useMultiFileAuthState).mockResolvedValueOnce(authState(creds, saveCreds));
    const sock = await connected(method);
    vi.mocked(process.exit).mockImplementation(() => undefined as never);
    pair(sock);
    return { sock, writes };
  }

  /** ...then close it before the 515. */
  async function closedAfterPairing(method: Method) {
    const { sock, writes } = await pairedWithPendingWrites(method);
    close(sock, 428, 'Connection Closed')();

    // Nothing is reported, and the step does not exit, while the pairing's write runs.
    await new Promise((resolve) => setImmediate(resolve));
    expect(blocks()).toEqual([]);
    expect(process.exit).not.toHaveBeenCalled();
    return writes;
  }

  it.each(METHODS)('%s: a close after pairing but before the 515 waits for the new creds', async (method) => {
    const writes = await closedAfterPairing(method);

    // Like Baileys' per-file lock, the writes land in order.
    for (const write of writes) write.resolve();

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(blocks()).toEqual(failed(AFTER('428 Connection Closed')));
  });

  type Writes = Awaited<ReturnType<typeof closedAfterPairing>>;
  const enospc = new Error('ENOSPC');
  it.each([
    ['qr', 'the pairing write fails', (w: Writes) => w[0].reject(enospc), NOT_SAVED],
    ['qr', 'the pairing write never lands', () => vi.advanceTimersByTimeAsync(5000), NOT_SAVED],
    // The file can already hold the pairing while its write has not returned.
    [
      'qr',
      'the pairing is on disk but its write is still running after 5 s',
      () => ((disk = JSON.stringify(PAIRED)), vi.advanceTimersByTimeAsync(5000)),
      PROBABLY_SAVED,
    ],
    // The code request's write is still pending too. The last write holds the whole creds, so it decides.
    [
      'pairing-code',
      'an earlier write fails but the pairing write lands',
      (w: Writes) => (w[0].reject(enospc), w[1].resolve()),
      AFTER,
    ],
    ['pairing-code', 'both writes fail', (w: Writes) => (w[0].reject(enospc), w[1].reject(enospc)), NOT_SAVED],
    // creds.json then holds only the requested code's `me`, not a finished pairing.
    [
      'pairing-code',
      'only the code request write lands',
      (w: Writes) => (w[0].resolve(), w[1].reject(enospc)),
      NOT_SAVED,
    ],
    // A creds.json that can't be parsed may still be mid-write, so it is never cleared.
    [
      'pairing-code',
      'the pairing write cuts creds.json short and fails',
      (w: Writes) => (w[0].resolve(), (disk = '{"me":'), w[1].reject(enospc)),
      UNREADABLE_AFTER,
    ],
    [
      'qr',
      'the pairing write has emptied creds.json and is still running after 5 s',
      () => ((disk = ''), vi.advanceTimersByTimeAsync(5000)),
      UNREADABLE_AFTER,
    ],
  ] as const)('%s: after pairing, reports by the creds writes when %s', async (method, _name, settle, message) => {
    const writes = await closedAfterPairing(method);

    await settle(writes);

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(blocks()).toEqual(failed(message('428 Connection Closed')));
  });

  it('pairing-code: a failed write after the 515 reconnect keeps the saved link', async () => {
    const sock = await reconnectedAfter515('pairing-code', PAIRED, () => Promise.reject(new Error('EACCES')));
    vi.mocked(process.exit).mockImplementation(() => undefined as never);
    // Baileys updates creds again after login (e.g. the device's lid); this write fails.
    sock.ev.emit('creds.update', { me: { id: `${PHONE}:7@s.whatsapp.net`, lid: '123456:7@lid' } });

    close(sock, 428, 'Connection Closed')();

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(blocks()).toEqual(failed(AFTER('428 Connection Closed')));
  });

  it('qr: a later write still running after 5 s leaves the saved link as probably saved', async () => {
    const { sock, writes } = await pairedWithPendingWrites('qr');
    writes[0].resolve();
    // A later creds update starts a write that hangs, so the step cannot be sure of creds.json.
    sock.ev.emit('creds.update', { me: { id: `${PHONE}:7@s.whatsapp.net`, lid: '123456:7@lid' } });
    expect(writes).toHaveLength(2);

    close(sock, 428, 'Connection Closed')();
    await vi.advanceTimersByTimeAsync(5000);

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(blocks()).toEqual(failed(PROBABLY_SAVED('428 Connection Closed')));
  });

  it('qr: a pairing write that failed before the close is still reported as not saved', async () => {
    const { sock, writes } = await pairedWithPendingWrites('qr');
    writes[0].reject(enospc);
    await new Promise((resolve) => setImmediate(resolve));

    close(sock, 428, 'Connection Closed')();

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(blocks()).toEqual(failed(NOT_SAVED('428 Connection Closed')));
  });
});
