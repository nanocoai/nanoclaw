/**
 * Unit tests for the native Matrix adapter (matrix-bot-sdk + native crypto).
 *
 * These run without a live homeserver: matrix-bot-sdk is mocked, and a fake
 * MatrixClient is injected through the adapter's `deps` seam. They cover:
 *   - config parsing (auth modes, defaults, store paths)
 *   - the DM platform-id <-> room resolution mapping (both directions)
 *   - inbound event -> InboundMessage mapping (matrix: senderId prefix,
 *     isMention/isGroup for DMs vs group rooms, own-echo suppression)
 *   - that the persistent crypto store directory is created/wired
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { ChannelSetup } from './adapter.js';
import {
  parseMatrixConfig,
  stripMatrixPrefix,
  isUserPlatformId,
  isRoomId,
  dmPlatformId,
  ensureCryptoStoreDir,
  reportCryptoStatus,
  extractReadonlyMachine,
  makeUIACallback,
  bootstrapCrossSigning,
  createMatrixAdapter,
  type MatrixConfig,
  type MatrixClientDeps,
  type OlmMachineReadonly,
  type UIAChallenge,
  type CrossSigningEngine,
  type UIACallbackFn,
} from './matrix.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Fakes for the matrix-bot-sdk surface the adapter touches
// ---------------------------------------------------------------------------

type MsgHandler = (roomId: string, event: unknown) => void;

class FakeMatrixClient {
  static lastCtorArgs: unknown[] = [];
  public crypto = {
    prepared: [] as string[],
    clientDeviceId: 'DEVICEID123',
    async prepare(roomIds: string[]) {
      this.prepared = roomIds;
    },
    // Read-only OlmMachine surface used by reportCryptoStatus. Defaults to an
    // unverified device with no key backup (the realistic fresh-bot state).
    engine: {
      machine: {
        async crossSigningStatus() {
          return { hasMaster: false, hasSelfSigning: false, hasUserSigning: false };
        },
        async getBackupKeys() {
          return {} as { backupVersion?: string; decryptionKeyBase64?: string };
        },
      },
    },
  };
  private handlers = new Map<string, MsgHandler[]>();
  public started = false;

  // Configurable test state
  public botUserId = '@bot:server';
  public dmRooms = new Map<string, string>(); // userId -> roomId
  public roomMembers = new Map<string, string[]>(); // roomId -> members
  public directRooms = new Set<string>(); // roomIds known as DMs
  public joinedRooms: string[] = [];
  public sent: Array<{ roomId: string; text: string }> = [];

  constructor(...args: unknown[]) {
    FakeMatrixClient.lastCtorArgs = args;
  }

  dms = {
    getOrCreateDm: async (userId: string): Promise<string> => {
      let roomId = this.dmRooms.get(userId);
      if (!roomId) {
        roomId = `!dm_${userId.replace(/[^a-z0-9]/gi, '')}:server`;
        this.dmRooms.set(userId, roomId);
        this.directRooms.add(roomId);
        this.roomMembers.set(roomId, [this.botUserId, userId]);
      }
      return roomId;
    },
    isDm: (roomId: string): boolean => this.directRooms.has(roomId),
    update: async () => {},
  };

  on(event: string, handler: MsgHandler): unknown {
    const arr = this.handlers.get(event) ?? [];
    arr.push(handler);
    this.handlers.set(event, arr);
    return this;
  }

  emit(event: string, roomId: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(roomId, payload);
  }

  async getUserId(): Promise<string> {
    return this.botUserId;
  }
  async getWhoAmI(): Promise<{ user_id: string; device_id?: string }> {
    return { user_id: this.botUserId, device_id: 'DEVICEID123' };
  }
  async getJoinedRooms(): Promise<string[]> {
    return this.joinedRooms;
  }
  async getJoinedRoomMembers(roomId: string): Promise<string[]> {
    return this.roomMembers.get(roomId) ?? [];
  }
  async joinRoom(roomId: string): Promise<string> {
    return roomId;
  }
  async sendText(roomId: string, text: string): Promise<string> {
    this.sent.push({ roomId, text });
    return `$evt_${this.sent.length}`;
  }
  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<string> {
    this.sent.push({ roomId, text: String(content.body ?? '') });
    return `$evt_${this.sent.length}`;
  }
  async downloadContent(_mxcUrl: string): Promise<{ data: Buffer; contentType: string }> {
    return { data: Buffer.alloc(0), contentType: 'audio/ogg' };
  }
  async start(): Promise<unknown> {
    this.started = true;
    return {};
  }
  stop(): void {
    this.started = false;
  }
}

class FakeFsStore {
  public values = new Map<string, string>();
  constructor(public filename: string) {}
  readValue(key: string): string | null | undefined {
    return this.values.get(key) ?? null;
  }
  storeValue(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeCryptoStore {
  static lastPath: string | null = null;
  static lastType: number | null = null;
  private deviceId: string | null = null;
  constructor(
    public storagePath: string,
    public storageType: number,
  ) {
    FakeCryptoStore.lastPath = storagePath;
    FakeCryptoStore.lastType = storageType;
  }
  async getDeviceId(): Promise<string> {
    return this.deviceId ?? '';
  }
  async setDeviceId(id: string): Promise<void> {
    this.deviceId = id;
  }
}

const FakeAutojoin = { setupOnClient: vi.fn() };

class FakeAuth {
  static logins: Array<{ username: string; password: string }> = [];
  constructor(public homeserverUrl: string) {}
  async passwordLogin(username: string, password: string): Promise<{ accessToken: string }> {
    FakeAuth.logins.push({ username, password });
    return { accessToken: 'token-from-login' };
  }
}

function makeDeps(): MatrixClientDeps {
  return {
    MatrixClient: FakeMatrixClient as unknown as MatrixClientDeps['MatrixClient'],
    MatrixAuth: FakeAuth as unknown as MatrixClientDeps['MatrixAuth'],
    SimpleFsStorageProvider: FakeFsStore as unknown as MatrixClientDeps['SimpleFsStorageProvider'],
    RustSdkCryptoStorageProvider: FakeCryptoStore as unknown as MatrixClientDeps['RustSdkCryptoStorageProvider'],
    AutojoinRoomsMixin: FakeAutojoin as unknown as MatrixClientDeps['AutojoinRoomsMixin'],
  };
}

/**
 * Deps whose MatrixClient records every constructed instance, so tests can
 * reach the live fake client (to emit events / inspect sends).
 */
function depsCapturing(): { deps: MatrixClientDeps; getClient: () => FakeMatrixClient } {
  const instances: FakeMatrixClient[] = [];
  class Capturing extends FakeMatrixClient {
    constructor(...args: unknown[]) {
      super(...args);
      instances.push(this);
    }
  }
  const deps = makeDeps();
  deps.MatrixClient = Capturing as unknown as MatrixClientDeps['MatrixClient'];
  return { deps, getClient: () => instances[instances.length - 1]! };
}

function makeSetup() {
  return {
    onInbound: vi.fn() as unknown as ChannelSetup['onInbound'] & ReturnType<typeof vi.fn>,
    onInboundEvent: vi.fn() as unknown as ChannelSetup['onInboundEvent'] & ReturnType<typeof vi.fn>,
    onMetadata: vi.fn() as unknown as ChannelSetup['onMetadata'] & ReturnType<typeof vi.fn>,
    onAction: vi.fn() as unknown as ChannelSetup['onAction'] & ReturnType<typeof vi.fn>,
  };
}

let tmpRoot: string;
function baseConfig(overrides: Partial<MatrixConfig> = {}): MatrixConfig {
  return {
    baseUrl: 'https://matrix.example',
    accessToken: 'tok',
    userId: '@bot:server',
    cryptoStorePath: path.join(tmpRoot, 'crypto'),
    fsStorePath: path.join(tmpRoot, 'store.json'),
    autojoin: true,
    ffmpegBin: 'ffmpeg',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeAuth.logins = [];
  FakeCryptoStore.lastPath = null;
  FakeCryptoStore.lastType = null;
  FakeMatrixClient.lastCtorArgs = [];
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'matrix-test-'));
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('platform-id helpers', () => {
  it('strips the matrix: prefix', () => {
    expect(stripMatrixPrefix('matrix:@a:s')).toBe('@a:s');
    expect(stripMatrixPrefix('@a:s')).toBe('@a:s');
    expect(stripMatrixPrefix('matrix:!r:s')).toBe('!r:s');
  });

  it('classifies user vs room platform ids', () => {
    expect(isUserPlatformId('matrix:@a:s')).toBe(true);
    expect(isUserPlatformId('@a:s')).toBe(true);
    expect(isUserPlatformId('matrix:!room:s')).toBe(false);
    expect(isRoomId('matrix:!room:s')).toBe(true);
    expect(isRoomId('#alias:s')).toBe(true);
    expect(isRoomId('matrix:@a:s')).toBe(false);
  });

  it('builds dm platform ids with a single matrix: prefix', () => {
    expect(dmPlatformId('@a:s')).toBe('matrix:@a:s');
    expect(dmPlatformId('matrix:@a:s')).toBe('matrix:@a:s');
  });
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe('parseMatrixConfig', () => {
  it('returns null without a base url', () => {
    expect(parseMatrixConfig({})).toBeNull();
    expect(parseMatrixConfig({ MATRIX_ACCESS_TOKEN: 't', MATRIX_USER_ID: '@b:s' })).toBeNull();
  });

  it('returns null when neither auth method is complete', () => {
    expect(parseMatrixConfig({ MATRIX_BASE_URL: 'https://x' })).toBeNull();
    // token without user id
    expect(parseMatrixConfig({ MATRIX_BASE_URL: 'https://x', MATRIX_ACCESS_TOKEN: 't' })).toBeNull();
    // username without password
    expect(parseMatrixConfig({ MATRIX_BASE_URL: 'https://x', MATRIX_USERNAME: 'bot' })).toBeNull();
  });

  it('parses token auth', () => {
    const cfg = parseMatrixConfig({
      MATRIX_BASE_URL: 'https://x',
      MATRIX_ACCESS_TOKEN: 'tok',
      MATRIX_USER_ID: '@bot:s',
    });
    expect(cfg).toMatchObject({ baseUrl: 'https://x', accessToken: 'tok', userId: '@bot:s' });
  });

  it('parses password auth', () => {
    const cfg = parseMatrixConfig({
      MATRIX_BASE_URL: 'https://x',
      MATRIX_USERNAME: 'bot',
      MATRIX_PASSWORD: 'pw',
    });
    expect(cfg).toMatchObject({ baseUrl: 'https://x', username: 'bot', password: 'pw' });
  });

  it('defaults store paths and autojoin, resolves to absolute paths', () => {
    const cfg = parseMatrixConfig({
      MATRIX_BASE_URL: 'https://x',
      MATRIX_ACCESS_TOKEN: 'tok',
      MATRIX_USER_ID: '@bot:s',
    })!;
    expect(cfg.autojoin).toBe(true);
    expect(path.isAbsolute(cfg.cryptoStorePath)).toBe(true);
    expect(path.isAbsolute(cfg.fsStorePath)).toBe(true);
    expect(cfg.cryptoStorePath.endsWith(path.join('data', 'v2-matrix-crypto'))).toBe(true);
  });

  it('honours autojoin=false and custom store path + device id + recovery key', () => {
    const cfg = parseMatrixConfig({
      MATRIX_BASE_URL: 'https://x',
      MATRIX_ACCESS_TOKEN: 'tok',
      MATRIX_USER_ID: '@bot:s',
      MATRIX_INVITE_AUTOJOIN: 'false',
      MATRIX_CRYPTO_STORE_PATH: '/tmp/my-crypto',
      MATRIX_DEVICE_ID: 'STABLE01',
      MATRIX_RECOVERY_KEY: 'EsT 1234',
    })!;
    expect(cfg.autojoin).toBe(false);
    expect(cfg.cryptoStorePath).toBe('/tmp/my-crypto');
    expect(cfg.deviceId).toBe('STABLE01');
    expect(cfg.recoveryKey).toBe('EsT 1234');
  });
});

// ---------------------------------------------------------------------------
// Crypto store directory
// ---------------------------------------------------------------------------

describe('ensureCryptoStoreDir', () => {
  it('creates the crypto store directory when missing', () => {
    const dir = path.join(tmpRoot, 'nested', 'crypto');
    expect(existsSync(dir)).toBe(false);
    ensureCryptoStoreDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent on an existing directory', () => {
    const dir = path.join(tmpRoot, 'crypto');
    ensureCryptoStoreDir(dir);
    ensureCryptoStoreDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Internal-machine extraction (guards against SDK field renames)
// ---------------------------------------------------------------------------

describe('extractReadonlyMachine', () => {
  const goodMachine = {
    crossSigningStatus: async () => ({ hasMaster: false, hasSelfSigning: false, hasUserSigning: false }),
    getBackupKeys: async () => ({}),
  };

  it('returns null when crypto is undefined', () => {
    expect(extractReadonlyMachine(undefined)).toBeNull();
  });

  it('returns null when engine is missing (SDK renamed `engine`)', () => {
    expect(extractReadonlyMachine({})).toBeNull();
  });

  it('returns null when machine is missing (SDK renamed `machine`)', () => {
    expect(extractReadonlyMachine({ engine: {} })).toBeNull();
  });

  it('returns null when the machine lacks the read-only methods (SDK changed shape)', () => {
    expect(extractReadonlyMachine({ engine: { machine: { somethingElse: () => {} } } })).toBeNull();
  });

  it('returns the machine when the read-only methods are present', () => {
    expect(extractReadonlyMachine({ engine: { machine: goodMachine } })).toBe(goodMachine);
  });
});

// ---------------------------------------------------------------------------
// Cross-signing / key-backup status reporting (read-only, never mutates)
// ---------------------------------------------------------------------------

describe('reportCryptoStatus', () => {
  const machine = (over: Partial<{ cs: Record<string, boolean>; backupVersion: string }>): OlmMachineReadonly => ({
    async crossSigningStatus() {
      return { hasMaster: false, hasSelfSigning: false, hasUserSigning: false, ...(over.cs ?? {}) };
    },
    async getBackupKeys() {
      return over.backupVersion ? { backupVersion: over.backupVersion } : {};
    },
  });

  it('is a silent no-op when crypto is genuinely inactive (cryptoActive=false)', async () => {
    await reportCryptoStatus(undefined, true, false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns loudly when crypto IS active but the machine cannot be reached (SDK drift)', async () => {
    await reportCryptoStatus(null, false, true);
    const warnMsgs = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnMsgs.some((m: string) => /OlmMachine read-only API could not be reached/.test(m))).toBe(true);
    expect(warnMsgs.some((m: string) => /changed its internal shape/.test(m))).toBe(true);
  });

  it('warns (not silent debug) when a read-only call throws — also SDK drift', async () => {
    const broken: OlmMachineReadonly = {
      async crossSigningStatus() {
        throw new Error('signature changed');
      },
      async getBackupKeys() {
        return {};
      },
    };
    await reportCryptoStatus(broken, false, true);
    const warnMsgs = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnMsgs.some((m: string) => /possible SDK drift/.test(m))).toBe(true);
  });

  it('logs an unverified-device hint (mentioning MATRIX_RECOVERY_KEY) when not cross-signed and no recovery key set', async () => {
    await reportCryptoStatus(machine({}), false);
    const infoMsgs = (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(infoMsgs.some((m: string) => /not cross-signed/.test(m) && /MATRIX_RECOVERY_KEY/.test(m))).toBe(true);
  });

  it('warns that cross-signing did not take when MATRIX_RECOVERY_KEY is set but the device is still not cross-signed', async () => {
    // After a (failed) bootstrap attempt, the device is still not cross-signed —
    // reportCryptoStatus points at the preceding WARN rather than the verify hint.
    await reportCryptoStatus(machine({}), true);
    const warnMsgs = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnMsgs.some((m: string) => /cross-signing was requested/.test(m) && /still not/.test(m))).toBe(true);
  });

  it('reports crossSigningReady: true and stays quiet about verification once the device IS cross-signed', async () => {
    await reportCryptoStatus(machine({ cs: { hasMaster: true, hasSelfSigning: true } }), true);
    const statusCall = (log.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'Matrix: E2EE trust status',
    );
    expect(statusCall?.[1]).toMatchObject({ crossSigningReady: true });
    const warnMsgs = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnMsgs.some((m: string) => /cross-signing was requested/.test(m))).toBe(false);
  });

  it('does not warn about recovery key when none is set, even if cross-signed', async () => {
    await reportCryptoStatus(machine({ cs: { hasMaster: true, hasSelfSigning: true } }), false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('NEVER calls a backup-write / signature-upload path (only read-only methods)', async () => {
    // A machine that throws if anything beyond the two read-only methods is touched.
    const csSpy = vi.fn(async () => ({ hasMaster: true, hasSelfSigning: true, hasUserSigning: true }));
    const bkSpy = vi.fn(async () => ({ backupVersion: 'v3' }));
    const guarded = new Proxy({ crossSigningStatus: csSpy, getBackupKeys: bkSpy } as unknown as OlmMachineReadonly, {
      get(target, prop, recv) {
        if (prop !== 'crossSigningStatus' && prop !== 'getBackupKeys') {
          throw new Error(`reportCryptoStatus touched a mutating method: ${String(prop)}`);
        }
        return Reflect.get(target, prop, recv);
      },
    });
    await expect(reportCryptoStatus(guarded, true)).resolves.toBeUndefined();
    expect(csSpy).toHaveBeenCalledTimes(1);
    expect(bkSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// UIA callback for the cross-signing device-signing upload
// ---------------------------------------------------------------------------

describe('makeUIACallback', () => {
  it('returns null when there is no password (token auth, no MATRIX_PASSWORD)', () => {
    expect(makeUIACallback('@bot:server', undefined)).toBeNull();
    expect(makeUIACallback('@bot:server', '')).toBeNull();
  });

  it('produces an m.login.password auth dict including the session id', async () => {
    const cb = makeUIACallback('@bot:server', 'pw')!;
    expect(cb).toBeTypeOf('function');
    const auth = await cb({ flows: [{ stages: ['m.login.password'] }], session: 'sess-123' });
    expect(auth).toEqual({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: '@bot:server' },
      password: 'pw',
      session: 'sess-123',
    });
  });

  it('omits the session key when the challenge has none', async () => {
    const cb = makeUIACallback('@bot:server', 'pw')!;
    const auth = (await cb({ flows: [{ stages: ['m.login.password'] }] })) as Record<string, unknown>;
    expect('session' in auth).toBe(false);
  });

  it('returns null (abandons) when no flow offers m.login.password', async () => {
    const cb = makeUIACallback('@bot:server', 'pw')!;
    const auth = await cb({ flows: [{ stages: ['m.login.sso'] }], session: 's' } as UIAChallenge);
    expect(auth).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bootstrapCrossSigning adapter helper (idempotent + strictly non-fatal)
// ---------------------------------------------------------------------------

describe('bootstrapCrossSigning (adapter helper)', () => {
  const uia = makeUIACallback('@bot:server', 'pw');

  function machineWith(states: Array<{ hasMaster: boolean; hasSelfSigning: boolean }>): OlmMachineReadonly {
    let i = 0;
    return {
      async crossSigningStatus() {
        const s = states[Math.min(i, states.length - 1)]!;
        i++;
        return { hasUserSigning: s.hasSelfSigning, ...s };
      },
      async getBackupKeys() {
        return {};
      },
    };
  }

  it('skips (idempotent) and returns true when already cross-signed — never calls the engine', async () => {
    const engine: Partial<CrossSigningEngine> = { bootstrapCrossSigning: vi.fn() };
    const ok = await bootstrapCrossSigning(machineWith([{ hasMaster: true, hasSelfSigning: true }]), engine, uia);
    expect(ok).toBe(true);
    expect(engine.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it('drives the engine and returns true when the device becomes cross-signed', async () => {
    // First status read (pre-check): not cross-signed. After the engine runs: cross-signed.
    const machine = machineWith([
      { hasMaster: false, hasSelfSigning: false },
      { hasMaster: true, hasSelfSigning: true },
    ]);
    const engine: Partial<CrossSigningEngine> = { bootstrapCrossSigning: vi.fn(async () => {}) };
    const ok = await bootstrapCrossSigning(machine, engine, uia);
    expect(ok).toBe(true);
    expect(engine.bootstrapCrossSigning).toHaveBeenCalledWith(uia, false);
  });

  it('is NON-FATAL: a throwing engine returns false and does not propagate', async () => {
    const machine = machineWith([{ hasMaster: false, hasSelfSigning: false }]);
    const engine: Partial<CrossSigningEngine> = {
      bootstrapCrossSigning: vi.fn(async () => {
        throw new Error('UIA rejected / binding too old');
      }),
    };
    let threw = false;
    let result: boolean | undefined;
    try {
      result = await bootstrapCrossSigning(machine, engine, uia);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns false + WARNs when the engine lacks bootstrapCrossSigning (patch not applied)', async () => {
    const machine = machineWith([{ hasMaster: false, hasSelfSigning: false }]);
    const ok = await bootstrapCrossSigning(machine, {}, uia);
    expect(ok).toBe(false);
    const warnMsgs = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnMsgs.some((m: string) => /patch.*not applied|bootstrap is unavailable/.test(m))).toBe(true);
  });

  it('returns false + WARNs when no UIA callback is available (no password)', async () => {
    const machine = machineWith([{ hasMaster: false, hasSelfSigning: false }]);
    const engine: Partial<CrossSigningEngine> = { bootstrapCrossSigning: vi.fn() };
    const ok = await bootstrapCrossSigning(machine, engine, null);
    expect(ok).toBe(false);
    expect(engine.bootstrapCrossSigning).not.toHaveBeenCalled();
    const warnMsgs = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnMsgs.some((m: string) => /User-Interactive Auth|MATRIX_PASSWORD/.test(m))).toBe(true);
  });

  it('returns false when the machine is unreachable (SDK drift)', async () => {
    const ok = await bootstrapCrossSigning(null, { bootstrapCrossSigning: vi.fn() }, uia);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Setup: crypto store wiring + device id + auth
// ---------------------------------------------------------------------------

describe('adapter.setup', () => {
  it('wires a persistent crypto store at the configured path and prepares crypto', async () => {
    const adapter = createMatrixAdapter(baseConfig(), makeDeps());
    await adapter.setup(makeSetup());

    expect(existsSync(baseConfig().cryptoStorePath)).toBe(true);
    expect(FakeCryptoStore.lastPath).toBe(baseConfig().cryptoStorePath);
    expect(FakeCryptoStore.lastType).toBe(0); // Sqlite
    expect(adapter.isConnected()).toBe(true);
  });

  it('uses the access token directly for token auth (no login)', async () => {
    const adapter = createMatrixAdapter(baseConfig({ accessToken: 'tok' }), makeDeps());
    await adapter.setup(makeSetup());
    expect(FakeAuth.logins).toHaveLength(0);
    // 2nd ctor arg is the access token
    expect(FakeMatrixClient.lastCtorArgs[1]).toBe('tok');
  });

  it('performs password login once and persists the token for a stable device', async () => {
    const deps = makeDeps();
    const cfg = baseConfig({ accessToken: undefined, userId: undefined, username: 'bot', password: 'pw' });

    const adapter = createMatrixAdapter(cfg, deps);
    await adapter.setup(makeSetup());

    expect(FakeAuth.logins).toEqual([{ username: 'bot', password: 'pw' }]);
    expect(FakeMatrixClient.lastCtorArgs[1]).toBe('token-from-login');

    // The token must be persisted into the FS store so a future boot reuses it.
    const storeInstance = FakeMatrixClient.lastCtorArgs[2] as FakeFsStore;
    expect(storeInstance.values.get('nanoclaw.matrix.accessToken')).toBe('token-from-login');
  });

  it('seeds a FRESH crypto store with the SERVER-ASSIGNED device id (getWhoAmI), not the pinned env value', async () => {
    // Regression: pre-seeding the store from MATRIX_DEVICE_ID before login made
    // the crypto machine sign keys as a device that did not match the session's
    // server-assigned device -> M_BAD_JSON on key upload. The store must agree
    // with the homeserver's device id.
    const adapter = createMatrixAdapter(baseConfig({ deviceId: 'PINNED01' }), makeDeps());
    await adapter.setup(makeSetup());
    const store = FakeMatrixClient.lastCtorArgs[3] as FakeCryptoStore;
    // FakeMatrixClient.getWhoAmI returns device_id 'DEVICEID123'.
    expect(await store.getDeviceId()).toBe('DEVICEID123');
  });

  it('leaves an EXISTING crypto-store device id untouched on restart', async () => {
    // Pre-populate the store so getDeviceId() returns a value -> no reseed.
    class PreSeeded extends FakeCryptoStore {
      constructor(p: string, t: number) {
        super(p, t);
        // simulate a prior run's persisted device id
        void this.setDeviceId('PRIOR_DEVICE');
      }
    }
    const deps = makeDeps();
    deps.RustSdkCryptoStorageProvider = PreSeeded as unknown as MatrixClientDeps['RustSdkCryptoStorageProvider'];
    const adapter = createMatrixAdapter(baseConfig(), deps);
    await adapter.setup(makeSetup());
    const store = FakeMatrixClient.lastCtorArgs[3] as FakeCryptoStore;
    expect(await store.getDeviceId()).toBe('PRIOR_DEVICE');
  });

  it('triggers cross-signing bootstrap through the patched engine when MATRIX_RECOVERY_KEY is set (password auth)', async () => {
    // A client whose engine exposes the patched bootstrapCrossSigning method,
    // and whose machine flips to cross-signed once it is called.
    let crossSigned = false;
    const bootstrapSpy = vi.fn(async (_cb: UIACallbackFn, _reset?: boolean) => {
      crossSigned = true;
    });
    class CryptoCapable extends FakeMatrixClient {
      public crypto = {
        prepared: [] as string[],
        clientDeviceId: 'DEVICEID123',
        async prepare(roomIds: string[]) {
          this.prepared = roomIds;
        },
        engine: {
          machine: {
            async crossSigningStatus() {
              return { hasMaster: crossSigned, hasSelfSigning: crossSigned, hasUserSigning: crossSigned };
            },
            async getBackupKeys() {
              return {} as { backupVersion?: string };
            },
          },
          bootstrapCrossSigning: bootstrapSpy,
        },
      };
    }
    const deps = makeDeps();
    deps.MatrixClient = CryptoCapable as unknown as MatrixClientDeps['MatrixClient'];

    // Password auth so a UIA callback is available.
    const cfg = baseConfig({
      accessToken: undefined,
      userId: undefined,
      username: 'bot',
      password: 'pw',
      recoveryKey: 'EsT recovery',
    });
    const adapter = createMatrixAdapter(cfg, deps);
    await adapter.setup(makeSetup());

    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
    // Called with a UIA callback function + reset=false.
    expect(bootstrapSpy.mock.calls[0]![1]).toBe(false);
    expect(bootstrapSpy.mock.calls[0]![0]).toBeTypeOf('function');

    // Status report should now show crossSigningReady: true.
    const statusCall = (log.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'Matrix: E2EE trust status',
    );
    expect(statusCall?.[1]).toMatchObject({ crossSigningReady: true });
    expect(adapter.isConnected()).toBe(true);
  });

  it('does NOT attempt bootstrap when MATRIX_RECOVERY_KEY is unset', async () => {
    const bootstrapSpy = vi.fn();
    class CryptoCapable extends FakeMatrixClient {
      public crypto = {
        prepared: [] as string[],
        clientDeviceId: 'DEVICEID123',
        async prepare() {},
        engine: {
          machine: {
            async crossSigningStatus() {
              return { hasMaster: false, hasSelfSigning: false, hasUserSigning: false };
            },
            async getBackupKeys() {
              return {} as { backupVersion?: string };
            },
          },
          bootstrapCrossSigning: bootstrapSpy,
        },
      };
    }
    const deps = makeDeps();
    deps.MatrixClient = CryptoCapable as unknown as MatrixClientDeps['MatrixClient'];
    const adapter = createMatrixAdapter(baseConfig({ recoveryKey: undefined }), deps);
    await adapter.setup(makeSetup());
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  it('setup stays non-fatal when the bootstrap engine throws (E2EE/connection unaffected)', async () => {
    class CryptoCapable extends FakeMatrixClient {
      public crypto = {
        prepared: [] as string[],
        clientDeviceId: 'DEVICEID123',
        async prepare() {},
        engine: {
          machine: {
            async crossSigningStatus() {
              return { hasMaster: false, hasSelfSigning: false, hasUserSigning: false };
            },
            async getBackupKeys() {
              return {} as { backupVersion?: string };
            },
          },
          bootstrapCrossSigning: vi.fn(async () => {
            throw new Error('binding too old');
          }),
        },
      };
    }
    const deps = makeDeps();
    deps.MatrixClient = CryptoCapable as unknown as MatrixClientDeps['MatrixClient'];
    const cfg = baseConfig({
      accessToken: undefined,
      userId: undefined,
      username: 'bot',
      password: 'pw',
      recoveryKey: 'EsT recovery',
    });
    const adapter = createMatrixAdapter(cfg, deps);
    // Must not throw despite the bootstrap failing.
    await expect(adapter.setup(makeSetup())).resolves.toBeUndefined();
    expect(adapter.isConnected()).toBe(true);
  });

  it('sets up autojoin when enabled and skips it when disabled', async () => {
    await createMatrixAdapter(baseConfig({ autojoin: true }), makeDeps()).setup(makeSetup());
    expect(FakeAutojoin.setupOnClient).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await createMatrixAdapter(baseConfig({ autojoin: false }), makeDeps()).setup(makeSetup());
    expect(FakeAutojoin.setupOnClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Inbound mapping
// ---------------------------------------------------------------------------

describe('inbound message mapping', () => {
  it('maps a DM message to matrix:<user> platformId with isMention=true, isGroup=false', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    const cfg = makeSetup();
    await adapter.setup(cfg);

    const client = getClient();
    const roomId = '!dmroom:server';
    client.directRooms.add(roomId);
    client.roomMembers.set(roomId, ['@bot:server', '@alice:server']);

    client.emit('room.message', roomId, {
      sender: '@alice:server',
      event_id: '$e1',
      origin_server_ts: 1700000000000,
      content: { msgtype: 'm.text', body: 'hello bot' },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(cfg.onMetadata).toHaveBeenCalledWith('matrix:@alice:server', '@alice:server', false);
    expect(cfg.onInbound).toHaveBeenCalledWith(
      'matrix:@alice:server',
      null,
      expect.objectContaining({
        id: '$e1',
        kind: 'chat',
        isMention: true,
        isGroup: false,
        content: expect.objectContaining({
          text: 'hello bot',
          sender: '@alice:server',
          senderId: 'matrix:@alice:server',
          senderName: '@alice:server',
        }),
      }),
    );
  });

  it('maps a group-room message to matrix:<roomId> with isGroup=true, isMention=false', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    const cfg = makeSetup();
    await adapter.setup(cfg);

    const client = getClient();
    const roomId = '!groupchat:server';
    client.roomMembers.set(roomId, ['@bot:server', '@alice:server', '@bob:server']);

    client.emit('room.message', roomId, {
      sender: '@bob:server',
      event_id: '$g1',
      origin_server_ts: 1700000000000,
      content: { msgtype: 'm.text', body: 'hey everyone' },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(cfg.onMetadata).toHaveBeenCalledWith('matrix:!groupchat:server', '!groupchat:server', true);
    expect(cfg.onInbound).toHaveBeenCalledWith(
      'matrix:!groupchat:server',
      null,
      expect.objectContaining({
        isGroup: true,
        isMention: false,
        content: expect.objectContaining({ senderId: 'matrix:@bob:server', text: 'hey everyone' }),
      }),
    );
  });

  it("suppresses the bot's own echoed messages", async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    const cfg = makeSetup();
    await adapter.setup(cfg);

    getClient().emit('room.message', '!r:server', {
      sender: '@bot:server',
      content: { msgtype: 'm.text', body: 'my own reply' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(cfg.onInbound).not.toHaveBeenCalled();
  });

  it('ignores empty / non-text events', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    const cfg = makeSetup();
    await adapter.setup(cfg);

    const client = getClient();
    client.emit('room.message', '!r:server', { sender: '@alice:server', content: { msgtype: 'm.text', body: '   ' } });
    client.emit('room.message', '!r:server', {
      sender: '@alice:server',
      content: { msgtype: 'm.image', body: 'pic.png' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(cfg.onInbound).not.toHaveBeenCalled();
  });

  it('routes m.audio as [Voice message] when WHISPER_BIN is not set', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    const cfg = makeSetup();
    await adapter.setup(cfg);

    delete process.env.WHISPER_BIN;
    const client = getClient();
    client.emit('room.message', '!r:server', {
      sender: '@alice:server',
      content: {
        msgtype: 'm.audio',
        body: 'voice-note.ogg',
        url: 'mxc://server/abc123',
        info: { mimetype: 'audio/ogg', duration: 3000 },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(cfg.onInbound).toHaveBeenCalledOnce();
    const msg = cfg.onInbound.mock.calls[0][2] as { content: { text: string } };
    expect(msg.content.text).toBe('[Voice message]');
  });
});

// ---------------------------------------------------------------------------
// Outbound: DM platform-id -> room resolution + send
// ---------------------------------------------------------------------------

describe('outbound DM resolution + delivery', () => {
  it('resolves matrix:<user> to a DM room and sends (encrypted-transparent) text', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    await adapter.setup(makeSetup());

    const evt = await adapter.deliver('matrix:@alice:server', null, { kind: 'text', content: { text: 'hi alice' } });
    const client = getClient();
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.roomId).toBe(client.dmRooms.get('@alice:server'));
    expect(client.sent[0]!.text).toBe('hi alice');
    expect(evt).toBeDefined();
  });

  it('sends to a group room id directly (no DM creation)', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    await adapter.setup(makeSetup());

    await adapter.deliver('matrix:!groupchat:server', null, { kind: 'text', content: { text: 'group msg' } });
    const client = getClient();
    expect(client.sent[0]!.roomId).toBe('!groupchat:server');
    expect(client.dmRooms.size).toBe(0);
  });

  it('openDM returns the user-handle platform id and pre-creates the room', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    await adapter.setup(makeSetup());

    const pid = await adapter.openDM!('@carol:server');
    expect(pid).toBe('matrix:@carol:server');
    expect(getClient().dmRooms.has('@carol:server')).toBe(true);

    // accepts an already-prefixed handle too
    const pid2 = await adapter.openDM!('matrix:@dave:server');
    expect(pid2).toBe('matrix:@dave:server');
  });

  it('round-trips: inbound DM platformId is the same handle openDM/deliver target uses', async () => {
    const { deps, getClient } = depsCapturing();
    const adapter = createMatrixAdapter(baseConfig(), deps);
    const cfg = makeSetup();
    await adapter.setup(cfg);

    const client = getClient();
    const roomId = '!dmABC:server';
    client.directRooms.add(roomId);
    client.roomMembers.set(roomId, ['@bot:server', '@alice:server']);
    client.dmRooms.set('@alice:server', roomId); // same room the resolver will reuse

    client.emit('room.message', roomId, {
      sender: '@alice:server',
      event_id: '$e1',
      content: { msgtype: 'm.text', body: 'ping' },
    });
    await new Promise((r) => setTimeout(r, 0));

    const inboundPlatformId = (cfg.onInbound as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(inboundPlatformId).toBe('matrix:@alice:server');

    // Replying to that same platform id lands back in the same room.
    await adapter.deliver(inboundPlatformId, null, { kind: 'text', content: { text: 'pong' } });
    expect(client.sent[0]!.roomId).toBe(roomId);
  });
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('stops the client and reports disconnected', async () => {
    const adapter = createMatrixAdapter(baseConfig(), makeDeps());
    await adapter.setup(makeSetup());
    expect(adapter.isConnected()).toBe(true);
    await adapter.teardown();
    expect(adapter.isConnected()).toBe(false);
  });
});

// Clean up temp dirs created during the run.
afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
