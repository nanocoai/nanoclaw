import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceClient } from './device-client.js';
import { DEVICE_PROOF_HEADER, ensureDeviceKey, verifyDeviceProof, type DeviceKey } from './device-key.js';
import { errorCode, errorStatus } from './errors.js';

/**
 * The remote-terminal routes of the account service, pinned request by
 * request: method, path, auth, body and answer, plus every error the host
 * must recognise. A stand-in service replays scripted answers; nothing here
 * talks to the real service.
 */
interface Seen {
  method: string;
  route: string;
  authorization?: string;
  proofValid?: boolean;
  body: unknown;
}
let server: Server;
let origin: string;
let home: string;
let key: DeviceKey;
let client: DeviceClient;
const seen: Seen[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let text = '';
  for await (const chunk of req) text += chunk;
  const proof = req.headers[DEVICE_PROOF_HEADER];
  seen.push({
    method: req.method ?? '',
    route: new URL(req.url ?? '/', origin).pathname,
    authorization: req.headers.authorization,
    ...(typeof proof === 'string' ? { proofValid: verifyDeviceProof(proof, key.publicKeyJwk).valid } : {}),
    body: text ? JSON.parse(text) : undefined,
  });
  res.setHeader('content-type', 'application/json');
  res.writeHead(answer.status);
  res.end(JSON.stringify(answer.body));
}

/** The code and status the host sees for a refused call. */
async function refused(call: Promise<unknown>): Promise<[number | undefined, string]> {
  try {
    await call;
  } catch (error) {
    return [errorStatus(error), errorCode(error)];
  }
  throw new Error('the call was accepted');
}

function refuse(status: number, code: string, extra: Record<string, unknown> = {}): void {
  answer = { status, body: { error: code, ...extra } };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-terminal-routes-'));
  seen.length = 0;
  answer = { status: 200, body: { ok: true } };
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
  key = ensureDeviceKey({ homeDir: home });
  client = new DeviceClient({
    origin,
    file: path.join(home, 'journal.json'),
    identity: { token: 'tok', accountId: 'acct-1', installId: 'inst-1' },
    deviceKey: key,
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

describe('terminal routes', () => {
  it('POST /api/v1/terminal/enable: bearer and device proof, an optional name and host key, the name and address back', async () => {
    const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb6Yl9Sqj4H6E3yJx0V5Z9p2Q3o4c5r6s7t8u9v0w1x nanoclaw-door';
    answer = {
      status: 200,
      body: { name: 'alice', address: '2600:1f18:aaaa:bbbb:5:12:3456:789a', hostKeyFingerprint: 'SHA256:h0stK3y' },
    };
    expect(await client.terminalEnable({ hostKey })).toEqual(answer.body);
    expect(seen[0]).toEqual({
      method: 'POST',
      route: '/api/v1/terminal/enable',
      authorization: 'Bearer tok',
      proofValid: true,
      body: { hostKey },
    });
    await client.terminalEnable({ name: 'alice', hostKey });
    expect(seen[1].body).toEqual({ name: 'alice', hostKey });
    await client.terminalEnable({});
    expect(seen[2].body).toEqual({});
    answer = {
      status: 200,
      body: { name: 'alice', address: '2600:1f18:aaaa:bbbb:5:12:3456:789a', hostKeyFingerprint: null },
    };
    expect((await client.terminalEnable({})).hostKeyFingerprint).toBeNull();
    for (const [status, code, extra] of [
      [400, 'invalid_name'],
      [400, 'invalid_host_key'],
      [409, 'terminal_bound', { deviceId: 'dev_other', label: 'another machine' }],
      [409, 'name_taken'],
      [409, 'busy'],
      [502, 'dns_unavailable'],
      [503, 'terminal_unconfigured'],
    ] as [number, string, Record<string, unknown>?][]) {
      refuse(status, code, extra);
      expect(await refused(client.terminalEnable({ name: 'alice', hostKey }))).toEqual([status, code]);
    }
    // No device key: the proof cannot be made and nothing is sent.
    const keyless = new DeviceClient({ origin, file: path.join(home, 'j2.json'), identity: client.identity });
    expect(await refused(keyless.terminalEnable({ hostKey }))).toEqual([undefined, 'device_key_required']);
    expect(seen).toHaveLength(11);
  });

  it('PUT /api/v1/terminal/host: bearer only, the door state with its port and honoured keys, the service view back', async () => {
    answer = { status: 200, body: { ok: true, enabled: true } };
    const report = {
      enabled: true,
      hostKey: 'ssh-ed25519 AAAA nanoclaw-door',
      doorPort: 33022,
      authorizedFingerprints: ['SHA256:a', 'SHA256:b'],
    };
    expect(await client.reportTerminal(report)).toEqual({ ok: true, enabled: true });
    expect(seen[0]).toEqual({
      method: 'PUT',
      route: '/api/v1/terminal/host',
      authorization: 'Bearer tok',
      body: report,
    });
    answer = { status: 200, body: { ok: true, enabled: false } };
    expect(await client.reportTerminal({ enabled: false, authorizedFingerprints: [] })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(seen[1].body).toEqual({ enabled: false, authorizedFingerprints: [] });
    for (const [status, code] of [
      [400, 'invalid_report'],
      [400, 'invalid_host_key'],
      [403, 'terminal_not_bound'],
    ] as [number, string][]) {
      refuse(status, code);
      expect(await refused(client.reportTerminal(report))).toEqual([status, code]);
    }
  });

  it('POST /api/v1/terminal/keys/pending: the waiting key with its type, blob and source; the code, page and expiry back', async () => {
    answer = {
      status: 200,
      body: { code: 'K7PQ-2M4Z', url: `${origin}/?approve=K7PQ2M4Z`, expiresAt: '2026-09-11T10:10:00.000Z' },
    };
    const request = {
      fingerprint: 'SHA256:Z8c2Xa9bQeR7tYuIoPaSdFgHjKlZxCvBnMqWeRtYuIo',
      keyType: 'ssh-ed25519',
      publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIGb6Yl9Sqj4H6E3yJx0V5Z9p2Q3o4c5r6s7t8u9v0w1x',
      source: { ip: '2001:db8::9', port: 4242 },
      at: '2026-09-11T10:00:00.000Z',
    };
    expect(await client.terminalPending(request)).toEqual(answer.body);
    expect(seen[0]).toEqual({
      method: 'POST',
      route: '/api/v1/terminal/keys/pending',
      authorization: 'Bearer tok',
      body: request,
    });
    const { at: _at, ...withoutAt } = request;
    await client.terminalPending(withoutAt);
    expect(seen[1].body).toEqual(withoutAt);
    for (const [status, code] of [
      [400, 'invalid_key'],
      [400, 'invalid_source'],
      [403, 'terminal_not_bound'],
      [409, 'disabled'],
      [409, 'key_approved'],
      [429, 'pending_limit'],
    ] as [number, string][]) {
      refuse(status, code);
      expect(await refused(client.terminalPending(request))).toEqual([status, code]);
    }
  });

  it('POST and DELETE /api/v1/terminal/sandboxes, and GET /api/v1/terminal/keys', async () => {
    answer = {
      status: 200,
      body: { name: 'api', address: '2600:1f18:aaaa:bbbb:5:12:3456:789b', host: 'api.alice.example.test' },
    };
    expect(await client.terminalSandboxAdd('api')).toEqual(answer.body);
    expect(seen[0]).toEqual({
      method: 'POST',
      route: '/api/v1/terminal/sandboxes',
      authorization: 'Bearer tok',
      body: { name: 'api' },
    });
    for (const [status, code] of [
      [400, 'invalid_name'],
      [409, 'name_taken'],
      [409, 'name_reserved'],
      [403, 'terminal_not_bound'],
    ] as [number, string][]) {
      refuse(status, code);
      expect(await refused(client.terminalSandboxAdd('api'))).toEqual([status, code]);
    }
    answer = { status: 200, body: { ok: true } };
    expect(await client.terminalSandboxRemove('api')).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({
      method: 'DELETE',
      route: '/api/v1/terminal/sandboxes/api',
      authorization: 'Bearer tok',
      body: undefined,
    });
    await client.terminalSandboxRemove('odd name');
    expect(seen.at(-1)?.route).toBe('/api/v1/terminal/sandboxes/odd%20name');
    const terminal = {
      enabled: true,
      name: 'alice',
      address: '2600:1f18:aaaa:bbbb:5:12:3456:789a',
      deviceId: 'dev_1',
      keys: [],
      pending: [],
      sandboxes: [
        { name: 'api', address: '2600:1f18:aaaa:bbbb:5:12:3456:789b', createdAt: '2026-09-11T10:00:00.000Z' },
      ],
    };
    answer = { status: 200, body: terminal };
    expect(await client.terminalKeys()).toEqual(terminal);
    expect(seen.at(-1)).toEqual({
      method: 'GET',
      route: '/api/v1/terminal/keys',
      authorization: 'Bearer tok',
      body: undefined,
    });
  });
});
