import { EventEmitter } from 'events';
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Baileys and pino are installed by /add-whatsapp, not by trunk, so both are mocked.
const sockets: Array<{ ev: EventEmitter; end: ReturnType<typeof vi.fn> }> = [];
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(() => {
    const ev = new EventEmitter();
    // Like Baileys, end() emits the close synchronously.
    const end = vi.fn(() =>
      ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: undefined } }),
    );
    const sock = { ev, end, user: { id: '14155551234:7@s.whatsapp.net' } };
    sockets.push(sock);
    return sock;
  }),
  Browsers: { macOS: (browser: string) => ['Mac OS', browser, '14.4.1'] },
  DisconnectReason: { loggedOut: 401, timedOut: 408 },
  fetchLatestWaWebVersion: vi.fn(async () => ({ version: [2, 3000, 1049214511], isLatest: true })),
  makeCacheableSignalKeyStore: vi.fn(() => ({})),
  useMultiFileAuthState: vi.fn(async () => ({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() })),
}));
vi.mock('pino', () => ({ pino: () => ({}) }));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

const { run } = await import('./whatsapp-auth.js');
const { makeWASocket } = await import('@whiskeysockets/baileys');
const { emitStatus } = await import('./status.js');

class Exit extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

const blocks = () => vi.mocked(emitStatus).mock.calls;

async function connected(): Promise<(typeof sockets)[number]> {
  void run(['--method', 'qr']).catch(() => {});
  await vi.waitFor(() => expect(makeWASocket).toHaveBeenCalledTimes(1));
  return sockets[0];
}

beforeEach(() => {
  sockets.length = 0;
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
  it('fails at once with the reason when WhatsApp refuses the connection', async () => {
    const sock = await connected();
    const refused = Object.assign(new Error('Connection Failure'), { output: { statusCode: 405 } });

    expect(() =>
      sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: refused } }),
    ).toThrow('process.exit(1)');
    expect(blocks()).toEqual([
      [
        'WHATSAPP_AUTH',
        {
          STATUS: 'failed',
          ERROR:
            'WhatsApp closed the connection before linking (405 Connection Failure). Clear store/auth/ and run the step again.',
        },
      ],
    ]);
  });

  it('does not report its own close after a successful link as a failure', async () => {
    const sock = await connected();

    sock.ev.emit('connection.update', { connection: 'open' });

    expect(sock.end).toHaveBeenCalled();
    expect(blocks()).toEqual([['WHATSAPP_AUTH', { STATUS: 'success', PHONE: '14155551234' }]]);
    expect(() => vi.advanceTimersByTime(1000)).toThrow('process.exit(0)');
  });
});
