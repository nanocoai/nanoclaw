/**
 * Unit tests for the matrix-bot-sdk patch (patches/matrix-bot-sdk@0.8.0.patch).
 *
 * Stock matrix-bot-sdk@0.8.0's RustEngine request runner THROWS on the
 * SignatureUpload (type 4) and KeysBackup (type 6) request types, and provides
 * no way to publish a cross-signing identity. The patch:
 *   - turns those throwing cases into real HTTP handlers, and
 *   - adds RustEngine.bootstrapCrossSigning(), which publishes the cross-signing
 *     public keys to /keys/device_signing/upload, completing the
 *     User-Interactive Auth (UIA) challenge, then self-signs the device.
 *
 * These tests run with NO live homeserver and NO running service: the MatrixClient
 * (HTTP) and the native OlmMachine are both mocked. They assert the exact
 * endpoints, the UIA 401 -> password -> resubmit flow, and that markRequestAsSent
 * is called with the right (id, type, response) so the crypto state machine
 * advances.
 *
 * The patched RustEngine is @internal, so it is imported via its package subpath.
 * Vitest resolves `matrix-bot-sdk` to the patched copy (pnpm patchedDependencies),
 * so this exercises the SHIPPED patch, not a reimplementation.
 */
import { describe, it, expect, vi } from 'vitest';

// RustEngine is @internal (not re-exported from the package barrel), so it is
// imported via its package subpath. Vitest resolves `matrix-bot-sdk` to the
// PATCHED copy (pnpm patchedDependencies), so this exercises the shipped patch.
import { RustEngine, extractUIA, hasFailedUIA } from 'matrix-bot-sdk/lib/e2ee/RustEngine.js';

// RequestType discriminants (from @matrix-org/matrix-sdk-crypto-nodejs).
const RT = {
  KeysUpload: 0,
  KeysQuery: 1,
  KeysClaim: 2,
  ToDevice: 3,
  SignatureUpload: 4,
  KeysBackup: 6,
} as const;

/** A 401 UIA response as matrix-bot-sdk surfaces it: `throw response`. */
function uia401(body: Record<string, unknown>) {
  return { statusCode: 401, body };
}

/** A MatrixError-shaped hard failure (has errcode). */
function matrixError(statusCode: number, errcode: string, error = 'nope') {
  return { statusCode, body: { errcode, error }, errcode, error };
}

interface DoRequestCall {
  method: string;
  path: string;
  qs: unknown;
  body: unknown;
}

/**
 * A mock MatrixClient capturing doRequest calls, with a programmable response
 * function so individual tests can simulate UIA and errors.
 */
function makeClient(respond: (call: DoRequestCall) => unknown) {
  const calls: DoRequestCall[] = [];
  const client = {
    calls,
    async doRequest(method: string, path: string, qs?: unknown, body?: unknown) {
      const call = { method, path, qs: qs ?? null, body: body ?? null };
      calls.push(call);
      return respond(call); // may throw to simulate non-2xx
    },
    async sendToDevices() {
      return {};
    },
    async getJoinedRoomMembers() {
      return [];
    },
  };
  return client;
}

/** A mock OlmMachine with a programmable outgoing-request queue. */
function makeMachine(
  opts: {
    outgoing?: () => unknown[];
    bootstrap?: () => unknown;
  } = {},
) {
  const markSent = vi.fn(async () => true);
  let queue = opts.outgoing ? opts.outgoing() : [];
  const machine = {
    markRequestAsSent: markSent,
    async outgoingRequests() {
      const q = queue;
      queue = []; // drain once so run()'s loop terminates
      return q;
    },
    async bootstrapCrossSigning() {
      return opts.bootstrap ? opts.bootstrap() : undefined;
    },
    async updateTrackedUsers() {},
    async getMissingSessions() {
      return null;
    },
  };
  return { machine, markSent };
}

function engineFor(machine: unknown, client: unknown): RustEngine {
  // The RustEngine ctor is (machine, client). Cast through unknown — we only
  // exercise the request-pump + cross-signing paths, which need just these two.
  return new (RustEngine as unknown as new (m: unknown, c: unknown) => RustEngine)(machine, client);
}

describe('extractUIA / hasFailedUIA helpers', () => {
  it('extracts a UIA challenge from a raw 401 response (throw response shape)', () => {
    const uia = extractUIA(uia401({ flows: [{ stages: ['m.login.password'] }], session: 'S1', params: { a: 1 } }));
    expect(uia).toEqual({ flows: [{ stages: ['m.login.password'] }], session: 'S1', params: { a: 1 } });
  });

  it('returns null for a non-401 or a body without flows', () => {
    expect(extractUIA(matrixError(403, 'M_FORBIDDEN'))).toBeNull();
    expect(extractUIA(uia401({ session: 'x' }))).toBeNull(); // no flows[]
    expect(extractUIA(undefined)).toBeNull();
    expect(extractUIA('boom')).toBeNull();
  });

  it('hasFailedUIA is true only when the body carries an errcode', () => {
    expect(hasFailedUIA(matrixError(401, 'M_FORBIDDEN'))).toBe(true);
    expect(hasFailedUIA(uia401({ flows: [], session: 's' }))).toBe(false);
    expect(hasFailedUIA(undefined)).toBe(false);
  });
});

describe('RustEngine request pump (patched SignatureUpload / KeysBackup)', () => {
  it('no longer throws on SignatureUpload — POSTs to /keys/signatures/upload and marks sent', async () => {
    const client = makeClient(() => ({ failures: {} }));
    const { machine, markSent } = makeMachine({
      outgoing: () => [
        { id: 'sig1', type: RT.SignatureUpload, body: JSON.stringify({ '@bot:s': { 'ed25519:DEV': {} } }) },
      ],
    });
    const engine = engineFor(machine, client);

    await expect(engine.run()).resolves.toBeUndefined();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      path: '/_matrix/client/v3/keys/signatures/upload',
      body: { '@bot:s': { 'ed25519:DEV': {} } },
    });
    expect(markSent).toHaveBeenCalledWith('sig1', RT.SignatureUpload, JSON.stringify({ failures: {} }));
  });

  it('handles KeysBackup by writing to the active backup version and marking sent', async () => {
    const client = makeClient((call) => {
      if (call.method === 'GET' && call.path === '/_matrix/client/v3/room_keys/version') return { version: '7' };
      if (call.method === 'PUT' && call.path === '/_matrix/client/v3/room_keys/keys') return { count: 1, etag: 'e' };
      return {};
    });
    const { machine, markSent } = makeMachine({
      outgoing: () => [{ id: 'bk1', type: RT.KeysBackup, body: JSON.stringify({ rooms: {} }) }],
    });
    const engine = engineFor(machine, client);

    await engine.run();

    const put = client.calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ path: '/_matrix/client/v3/room_keys/keys', qs: { version: '7' }, body: { rooms: {} } });
    expect(markSent).toHaveBeenCalledWith('bk1', RT.KeysBackup, JSON.stringify({ count: 1, etag: 'e' }));
  });

  it('KeysBackup throws a clear error (does NOT silently drop keys) when no backup version exists', async () => {
    const client = makeClient((call) => {
      if (call.method === 'GET') throw matrixError(404, 'M_NOT_FOUND'); // no backup version
      return {};
    });
    const { machine, markSent } = makeMachine({
      outgoing: () => [{ id: 'bk1', type: RT.KeysBackup, body: JSON.stringify({ rooms: {} }) }],
    });
    const engine = engineFor(machine, client);

    await expect(engine.run()).rejects.toThrow(/no server-side backup version/);
    expect(markSent).not.toHaveBeenCalled();
  });

  it('still handles ordinary KeysUpload (regression: shared loop not broken by the patch)', async () => {
    const client = makeClient(() => ({ one_time_key_counts: { signed_curve25519: 50 } }));
    const { machine, markSent } = makeMachine({
      outgoing: () => [{ id: 'ku1', type: RT.KeysUpload, body: JSON.stringify({ device_keys: {} }) }],
    });
    const engine = engineFor(machine, client);
    await engine.run();
    expect(client.calls[0]).toMatchObject({ method: 'POST', path: '/_matrix/client/v3/keys/upload' });
    expect(markSent).toHaveBeenCalledWith('ku1', RT.KeysUpload, expect.any(String));
  });
});

describe('RustEngine.bootstrapCrossSigning (UIA flow)', () => {
  /** A realistic bootstrap return: device-keys upload + signing-keys body + signatures. */
  function bootstrapReturn() {
    return {
      uploadKeysReq: { id: 'devkeys1', type: RT.KeysUpload, body: JSON.stringify({ device_keys: { '@bot:s': {} } }) },
      uploadSigningKeysReq: JSON.stringify({
        master_key: { keys: { 'ed25519:M': 'M' } },
        self_signing_key: { keys: { 'ed25519:S': 'S' } },
        user_signing_key: { keys: { 'ed25519:U': 'U' } },
      }),
      uploadSignaturesReq: { id: 'sig1', type: RT.SignatureUpload, body: JSON.stringify({ '@bot:s': {} }) },
    };
  }

  it('completes the UIA password flow: first 401 with flows -> resubmit with auth -> success; uploads device keys + signatures', async () => {
    let signingUploadAttempts = 0;
    const client = makeClient((call) => {
      if (call.path === '/_matrix/client/v3/keys/device_signing/upload') {
        signingUploadAttempts++;
        const body = call.body as { auth?: unknown };
        if (!body.auth) {
          // First attempt: no auth -> server demands UIA.
          throw uia401({ flows: [{ stages: ['m.login.password'] }], session: 'UIA-SESSION', params: {} });
        }
        // Resubmission carried auth -> accepted.
        return {};
      }
      return {}; // keys/upload + signatures/upload + (no backup) succeed
    });

    const { machine, markSent } = makeMachine({ bootstrap: bootstrapReturn });
    const engine = engineFor(machine, client);

    const uiaCallback = vi.fn(async (uia: { session?: string }) => ({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: '@bot:s' },
      password: 'pw',
      session: uia.session,
    }));

    await expect(engine.bootstrapCrossSigning(uiaCallback)).resolves.toBeUndefined();

    // UIA: first attempt rejected, second accepted (two POSTs to device_signing).
    expect(signingUploadAttempts).toBe(2);
    expect(uiaCallback).toHaveBeenCalledTimes(1);
    expect(uiaCallback.mock.calls[0]![0]).toMatchObject({
      session: 'UIA-SESSION',
      flows: [{ stages: ['m.login.password'] }],
    });

    // The retry carried the auth dict (with the threaded session).
    const signingCalls = client.calls.filter((c) => c.path === '/_matrix/client/v3/keys/device_signing/upload');
    expect((signingCalls[1]!.body as { auth: { session: string } }).auth.session).toBe('UIA-SESSION');
    // ...and resubmitted the SAME cross-signing key body.
    expect((signingCalls[1]!.body as { master_key: unknown }).master_key).toBeDefined();

    // Device keys + signatures were uploaded to the right endpoints.
    const paths = client.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /_matrix/client/v3/keys/upload'); // uploadKeysReq
    expect(paths).toContain('POST /_matrix/client/v3/keys/signatures/upload'); // uploadSignaturesReq

    // markRequestAsSent: the device-keys upload and the signature upload are
    // marked sent (the cross-signing keys upload has no id, per the binding).
    expect(markSent).toHaveBeenCalledWith('devkeys1', RT.KeysUpload, expect.any(String));
    expect(markSent).toHaveBeenCalledWith('sig1', RT.SignatureUpload, expect.any(String));
  });

  it('accepts a server that requires NO UIA (rare): single POST, no callback', async () => {
    const client = makeClient(() => ({})); // everything 2xx
    const { machine } = makeMachine({ bootstrap: bootstrapReturn });
    const engine = engineFor(machine, client);
    const uiaCallback = vi.fn();
    await engine.bootstrapCrossSigning(uiaCallback);
    expect(uiaCallback).not.toHaveBeenCalled();
    const signingCalls = client.calls.filter((c) => c.path === '/_matrix/client/v3/keys/device_signing/upload');
    expect(signingCalls).toHaveLength(1);
  });

  it('throws when the binding is too old: bootstrapCrossSigning() returns void (no upload requests)', async () => {
    const client = makeClient(() => ({}));
    const { machine } = makeMachine({ bootstrap: () => undefined }); // 0.4.0 behavior
    const engine = engineFor(machine, client);
    await expect(engine.bootstrapCrossSigning(vi.fn())).rejects.toThrow(/did not return the upload requests/);
  });

  it('surfaces a credential rejection (Synapse: 401 retains flows AND adds errcode) rather than looping forever', async () => {
    // Synapse re-sends the 401 UIA body with the flows still present plus
    // `errcode`/`error`/`completed: []` when a password stage is rejected.
    const client = makeClient((call) => {
      if (call.path === '/_matrix/client/v3/keys/device_signing/upload') {
        const body = call.body as { auth?: unknown };
        if (!body.auth) throw uia401({ flows: [{ stages: ['m.login.password'] }], session: 'S' });
        throw {
          statusCode: 401,
          body: {
            flows: [{ stages: ['m.login.password'] }],
            session: 'S',
            completed: [],
            errcode: 'M_FORBIDDEN',
            error: 'Invalid password',
          },
        };
      }
      return {};
    });
    const { machine } = makeMachine({ bootstrap: bootstrapReturn });
    const engine = engineFor(machine, client);
    const uiaCallback = vi.fn(async () => ({ type: 'm.login.password', password: 'wrong' }));
    await expect(engine.bootstrapCrossSigning(uiaCallback)).rejects.toThrow(/credentials rejected/);
  });

  it('re-throws a plain (non-UIA-shaped) 401 from the device-signing upload as-is', async () => {
    // A 401 with errcode but no `flows` is a hard auth error, not a UIA stage —
    // we surface the original error rather than inventing a message.
    const client = makeClient((call) => {
      if (call.path === '/_matrix/client/v3/keys/device_signing/upload') {
        const body = call.body as { auth?: unknown };
        if (!body.auth) throw uia401({ flows: [{ stages: ['m.login.password'] }], session: 'S' });
        throw matrixError(401, 'M_UNKNOWN_TOKEN');
      }
      return {};
    });
    const { machine } = makeMachine({ bootstrap: bootstrapReturn });
    const engine = engineFor(machine, client);
    const uiaCallback = vi.fn(async () => ({ type: 'm.login.password', password: 'x' }));
    await expect(engine.bootstrapCrossSigning(uiaCallback)).rejects.toMatchObject({
      body: { errcode: 'M_UNKNOWN_TOKEN' },
    });
  });

  it('propagates a non-UIA hard error from the device-signing upload', async () => {
    const client = makeClient((call) => {
      if (call.path === '/_matrix/client/v3/keys/device_signing/upload') throw matrixError(500, 'M_UNKNOWN');
      return {};
    });
    const { machine } = makeMachine({ bootstrap: bootstrapReturn });
    const engine = engineFor(machine, client);
    await expect(engine.bootstrapCrossSigning(vi.fn())).rejects.toMatchObject({ statusCode: 500 });
  });

  it('aborts (throws) when the UIA callback returns null (cannot satisfy the challenge)', async () => {
    const client = makeClient((call) => {
      if (call.path === '/_matrix/client/v3/keys/device_signing/upload') {
        const body = call.body as { auth?: unknown };
        if (!body.auth) throw uia401({ flows: [{ stages: ['m.login.sso'] }], session: 'S' });
        return {};
      }
      return {};
    });
    const { machine } = makeMachine({ bootstrap: bootstrapReturn });
    const engine = engineFor(machine, client);
    const uiaCallback = vi.fn(async () => null); // cannot satisfy
    await expect(engine.bootstrapCrossSigning(uiaCallback)).rejects.toThrow(/was not satisfied/);
  });
});

describe('RustEngine.enableKeyBackup', () => {
  it('creates a backup version and returns its id', async () => {
    const client = makeClient((call) => {
      if (call.method === 'POST' && call.path === '/_matrix/client/v3/room_keys/version') return { version: '3' };
      return {};
    });
    const { machine } = makeMachine();
    const engine = engineFor(machine, client);
    const version = await engine.enableKeyBackup({ public_key: 'PUB', signatures: {} });
    expect(version).toBe('3');
    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      path: '/_matrix/client/v3/room_keys/version',
      body: { algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2', auth_data: { public_key: 'PUB', signatures: {} } },
    });
  });
});
