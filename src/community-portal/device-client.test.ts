import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceClient, type Journal } from './device-client.js';
import {
  DEVICE_PROOF_HEADER,
  ensureDeviceKey,
  verifyDeviceProof,
  type DeviceKey,
  type DevicePublicJwk,
} from './device-key.js';
import type { InstallIdentity } from './install-identity.js';
import { SetupClient } from './setup-client.js';

/**
 * A stand-in portal: checks the device proof exactly where the contract puts
 * it (device registration against the key in the body, cell tickets against
 * the pinned key), records every request, and serves scripted responses.
 * Nothing here talks to the real portal.
 */
type Handler = (request: { method: string; route: string; body: unknown; authorization?: string }) => {
  status?: number;
  body: unknown;
};
interface Seen {
  method: string;
  route: string;
  body: unknown;
  authorization?: string;
  proof?: string;
  proofValid?: boolean;
}
let server: Server;
let origin: string;
let root: string;
let journalFile: string;
let handler: Handler;
let key: DeviceKey;
let pinned: DevicePublicJwk | undefined;
const identity: InstallIdentity = { token: 'tok', accountId: 'acct-1', installId: 'inst-1' };
const seen: Seen[] = [];
const DEVICE_ID = 'dev_0123456789abcdef01234567';

async function journal(): Promise<Journal> {
  return JSON.parse(await readFile(journalFile, 'utf8')) as Journal;
}
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const route = new URL(req.url ?? '/', origin).pathname;
  const body: unknown = raw ? JSON.parse(raw) : undefined;
  const request = { method: req.method ?? '', route, body, authorization: req.headers.authorization };
  const proof = req.headers[DEVICE_PROOF_HEADER];
  const record: Seen = { ...request, ...(typeof proof === 'string' ? { proof } : {}) };
  seen.push(record);
  const proofed = route === '/api/v1/devices' || route === '/api/v1/cell-ticket';
  let reply: ReturnType<Handler>;
  if (proofed) {
    if (typeof proof !== 'string') reply = { status: 401, body: { error: 'device_proof_required' } };
    else {
      const against =
        route === '/api/v1/devices' ? (body as { publicKey?: DevicePublicJwk } | undefined)?.publicKey : pinned;
      record.proofValid = Boolean(against) && verifyDeviceProof(proof, against!).valid;
      reply = record.proofValid ? handler(request) : { status: 401, body: { error: 'invalid_proof' } };
    }
  } else reply = handler(request);
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply.body));
}
const registration: Handler = ({ route, method, body }) => {
  if (route === '/api/v1/devices' && method === 'POST') {
    pinned = (body as { publicKey: DevicePublicJwk }).publicKey;
    return { body: { deviceId: DEVICE_ID, accountId: identity.accountId, installId: identity.installId } };
  }
  if (route === '/api/v1/cell-ticket')
    return { body: { ticket: 'tkt', expiresIn: 900, socketUrl: `${origin}/cell/link` } };
  if (route === '/api/v1/device/state') return { body: { grants: [] } };
  if (route.endsWith('/ack')) return { body: { ok: true } };
  return { status: 404, body: { error: 'not_found' } };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-client-'));
  journalFile = path.join(root, 'data/community-portal.json');
  key = ensureDeviceKey({ file: path.join(root, 'device-key.json') });
  pinned = undefined;
  seen.length = 0;
  handler = () => ({ status: 404, body: { error: 'not_found' } });
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('DeviceClient', () => {
  it('keeps a keyless private journal, sends plain bearer requests, and proves only registration and tickets', async () => {
    const client = await new DeviceClient({
      origin,
      file: journalFile,
      identity,
      deviceKey: key,
      label: 'lab',
    }).initialize();
    expect((await stat(journalFile)).mode & 0o777).toBe(0o600);
    expect(await journal()).toEqual({ origin, credentials: {}, operations: {} });
    handler = registration;
    await client.request('GET', '/api/v1/device/state');
    expect(seen).toEqual([
      { method: 'GET', route: '/api/v1/device/state', body: undefined, authorization: 'Bearer tok' },
    ]);
    const registered = await client.register();
    expect(registered).toEqual({ deviceId: DEVICE_ID, accountId: 'acct-1', installId: 'inst-1' });
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      route: '/api/v1/devices',
      body: { publicKey: key.publicKeyJwk, label: 'lab' },
      authorization: 'Bearer tok',
      proofValid: true,
    });
    expect(seen.at(-1)?.proof).toMatch(/^v1;kid=/);
    expect((await journal()).deviceId).toBe(DEVICE_ID);
    expect(client.local.deviceId).toBe(DEVICE_ID);
    await client.register();
    expect((await journal()).deviceId).toBe(DEVICE_ID);
    const ticket = await client.ticket();
    expect(ticket).toEqual({ ticket: 'tkt', expiresIn: 900, socketUrl: `${origin}/cell/link` });
    expect(seen.at(-1)).toMatchObject({ route: '/api/v1/cell-ticket', body: {}, proofValid: true });
    expect(seen.map((r) => r.proof !== undefined)).toEqual([false, true, true, true]);
    await client.request('POST', '/api/v1/grants/echo/ack', { keyId: 'k' });
    expect(seen.at(-1)).not.toHaveProperty('proof');
    expect(JSON.stringify(await journal())).not.toMatch(/tok|pkcs8|privateKey|"d"/);
    await client.stop();
    const again = await new DeviceClient({ origin, file: journalFile, identity }).initialize();
    expect(again.local.deviceId).toBe(DEVICE_ID);
    expect(again.token).toBe('tok');
    await again.stop();
  });

  it('refuses to prove without a device key or an identity, while plain requests still work', async () => {
    handler = registration;
    const keyless = await new DeviceClient({ origin, file: journalFile, identity }).initialize();
    await expect(keyless.ticket()).rejects.toMatchObject({ code: 'device_key_required' });
    await expect(keyless.register()).rejects.toMatchObject({ code: 'device_key_required' });
    expect(await keyless.request('GET', '/api/v1/device/state')).toEqual({ grants: [] });
    await keyless.stop();
    const anonymous = await new DeviceClient({ origin, file: journalFile, deviceKey: key }).initialize();
    await expect(anonymous.register()).rejects.toMatchObject({ code: 'installation_required' });
    expect(anonymous.token).toBeUndefined();
    await anonymous.stop();
    expect(seen.filter((r) => r.route !== '/api/v1/device/state')).toEqual([]);
    expect(seen[0].authorization).toBe('Bearer tok');
  });

  it('refuses a plaintext origin off loopback, and a journal from another portal', async () => {
    expect(() => new DeviceClient({ origin: 'http://portal.example.test', file: journalFile })).toThrow('HTTPS');
    expect(() => new DeviceClient({ origin: 'https://portal.example.test/path', file: journalFile })).toThrow('HTTPS');
    const client = await new DeviceClient({ origin, file: journalFile }).initialize();
    await client.stop();
    await expect(
      new DeviceClient({ origin: 'https://portal.example.test', file: journalFile }).initialize(),
    ).rejects.toThrow('different portal');
  });

  it('surfaces the portal error code and status, and does not create a journal when told to use an existing one', async () => {
    const client = await new DeviceClient({ origin, file: journalFile, identity }).initialize();
    handler = () => ({ status: 401, body: { error: 'invalid_token', message: 'Sign in again.' } });
    await expect(client.request('GET', '/api/v1/device/state')).rejects.toMatchObject({
      message: 'Sign in again.',
      code: 'invalid_token',
      status: 401,
    });
    await client.stop();
    await expect(
      new DeviceClient({ origin, file: path.join(root, 'data/none.json'), existingOnly: true }).initialize(),
    ).rejects.toMatchObject({ code: 'installation_required' });
  });

  it('drops the keys and account record a pre-cutover journal carried', async () => {
    await mkdir(path.dirname(journalFile), { recursive: true });
    await writeFile(
      journalFile,
      JSON.stringify({
        origin,
        installId: 'old',
        deviceId: DEVICE_ID,
        privateKey: { kty: 'EC', d: 'secret' },
        publicKey: { kty: 'EC' },
        wrappingPrivateKey: { kty: 'OKP', d: 'secret' },
        wrappingPublicKey: { kty: 'OKP' },
        registryAccount: { token: 'old-token' },
        credentials: { echo: { keyId: 'k', operationId: 'o', resource: { label: 'Echo' } } },
        operations: {},
        reminders: { slack: true },
      }),
      { mode: 0o600 },
    );
    const client = await new DeviceClient({ origin, file: journalFile }).initialize();
    await client.stop();
    expect(await journal()).toEqual({
      origin,
      deviceId: DEVICE_ID,
      credentials: { echo: { keyId: 'k', operationId: 'o', resource: { label: 'Echo' } } },
      operations: {},
      reminders: { slack: true },
    });
  });

  it('exclusive clients wait for the journal lock and give up with journal_busy at the deadline', async () => {
    const first = await new DeviceClient({ origin, file: journalFile, exclusive: true }).initialize();
    first.local.deviceId = DEVICE_ID;
    await first.save();
    const started = Date.now();
    await expect(
      new DeviceClient({ origin, file: journalFile, exclusive: true, waitForLockMs: 250 }).initialize(),
    ).rejects.toMatchObject({ code: 'journal_busy' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    const waiting = new DeviceClient({ origin, file: journalFile, exclusive: true, waitForLockMs: 5_000 }).initialize();
    setTimeout(() => void first.stop(), 100);
    const second = await waiting;
    expect(second.local.deviceId).toBe(DEVICE_ID);
    await second.stop();
  });

  it('redeems an active grant once, acknowledges it, and forgets credentials for grants that end', async () => {
    const client = await new DeviceClient({ origin, file: journalFile, identity }).initialize();
    client.local.deviceId = DEVICE_ID;
    let redemptions = 0;
    const grant = {
      id: 'g1',
      perk: 'echo',
      desired: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      redemptions: [] as { deviceId: string; state: string; keyId: string; operationId: string }[],
    };
    handler = ({ method, route, body }) => {
      if (route === '/api/v1/device/state') return { body: { grants: [grant] } };
      if (route === '/api/v1/grants/echo/redeem') {
        redemptions++;
        expect(body).toEqual({ idempotencyKey: expect.any(String) });
        return { body: { keyId: 'k1', operationId: 'op1', secret: 'shh', resource: { label: 'Echo image' } } };
      }
      if (method === 'POST' && route === '/api/v1/grants/echo/ack') return { body: { ok: true } };
      return { status: 404, body: { error: 'not_found' } };
    };
    await client.reconcile();
    expect(redemptions).toBe(1);
    expect(seen.map((r) => r.route)).toEqual([
      '/api/v1/device/state',
      '/api/v1/grants/echo/redeem',
      '/api/v1/grants/echo/ack',
    ]);
    expect(seen.every((r) => r.authorization === 'Bearer tok' && r.proof === undefined)).toBe(true);
    expect(seen.at(-1)?.body).toEqual({ operationId: 'op1', keyId: 'k1' });
    expect((await journal()).credentials.echo).toMatchObject({ keyId: 'k1', secret: 'shh' });
    // Delivered: nothing more to do. Same idempotency key would be reused otherwise.
    grant.redemptions = [{ deviceId: DEVICE_ID, state: 'DELIVERED', keyId: 'k1', operationId: 'op1' }];
    seen.length = 0;
    await client.reconcile();
    expect(seen.map((r) => r.route)).toEqual(['/api/v1/device/state']);
    grant.desired = 'revoked';
    await client.reconcile();
    expect((await journal()).credentials).toEqual({});
    expect(redemptions).toBe(1);
    await client.stop();
  });
});

describe('SetupClient', () => {
  it('runs a browser handoff for the registered device: start, wait for approval, complete', async () => {
    const client = await new SetupClient({
      origin,
      file: journalFile,
      identity,
      deviceKey: key,
      autoContinue: true,
      label: 'lab',
    }).initialize();
    let polls = 0;
    handler = (request) => {
      const { method, route, body } = request;
      if (route === '/api/v1/catalog')
        return {
          body: {
            items: [
              { id: 'echo', kind: 'account' },
              { id: 'sample', kind: 'partner', enabled: false },
            ],
          },
        };
      if (route === '/api/v1/setup/start') {
        expect(body).toEqual({ stage: 'echo', name: 'Nano', reuseEnabled: false, autoContinue: true, label: 'lab' });
        return {
          body: {
            id: 'flow-1',
            code: 'code-1',
            url: `${origin}/setup/code-1`,
            installId: identity.installId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      }
      if (route === '/api/v1/setup/code-1' && method === 'GET') {
        polls++;
        if (polls === 1) return { body: { id: 'flow-1', stage: 'echo', status: 'browsing', deviceId: DEVICE_ID } };
        return {
          body: {
            id: 'flow-1',
            stage: 'echo',
            status: 'approved',
            deviceId: DEVICE_ID,
            label: 'lab',
            name: 'Nano',
            choice: { imageSource: 'hardened', workspaceId: 'T1', name: 'Nano' },
          },
        };
      }
      if (route === '/api/v1/setup/code-1/complete') return { body: { ok: true } };
      return registration(request);
    };
    await client.register();
    expect(await client.available('echo')).toBe(true);
    expect(await client.available('sample')).toBe(false);
    expect(await client.available('missing')).toBe(false);
    const flow = await client.start('echo');
    expect(flow.url).toBe(`${origin}/setup/code-1`);
    expect((await journal()).setupFlow).toMatchObject({ code: 'code-1', stage: 'echo' });
    const states: string[] = [];
    const result = await client.wait({ pollMs: 5, onState: (state) => void states.push(state.status) });
    expect(states).toEqual(['browsing', 'approved']);
    expect(result).toEqual({
      id: 'flow-1',
      stage: 'echo',
      status: 'approved',
      deviceId: DEVICE_ID,
      label: 'lab',
      name: 'Nano',
      choice: { imageSource: 'hardened', workspaceId: 'T1', name: 'Nano' },
    });
    expect((await journal()).deviceId).toBe(DEVICE_ID);
    await client.complete('complete', { appId: 'A1' });
    expect(seen.at(-1)).toMatchObject({
      route: '/api/v1/setup/code-1/complete',
      body: { status: 'complete', appId: 'A1' },
      authorization: 'Bearer tok',
    });
    expect(seen.filter((r) => r.proof !== undefined).map((r) => r.route)).toEqual(['/api/v1/devices']);
    await client.stop();
  });

  it('starts a flow anonymously with the sign-in verification data, then claims it once signed in', async () => {
    const client = await new SetupClient({ origin, file: journalFile, label: 'lab' }).initialize();
    const verification = {
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.test/device?user_code=ABCD-EFGH',
    };
    handler = (request) => {
      const { method, route } = request;
      if (route === '/api/v1/setup/start')
        return {
          body: {
            id: 'flow-3',
            code: 'code-3',
            url: `${origin}/?setup=code-3`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      if (route === '/api/v1/setup/code-3/claim' && method === 'POST')
        return { body: { id: 'flow-3', stage: 'echo', status: 'pending', deviceId: DEVICE_ID, choice: {} } };
      if (route === '/api/v1/setup/code-3' && method === 'GET')
        return {
          body: {
            id: 'flow-3',
            stage: 'echo',
            status: 'approved',
            deviceId: DEVICE_ID,
            choice: { imageSource: 'hardened' },
          },
        };
      return registration(request);
    };
    const flow = await client.start('echo', 'Nano', { verification });
    expect(flow.url).toBe(`${origin}/?setup=code-3`);
    expect(seen.at(-1)).toEqual({
      method: 'POST',
      route: '/api/v1/setup/start',
      body: { stage: 'echo', name: 'Nano', autoContinue: false, label: 'lab', verification },
    });
    expect((await journal()).setupFlow).toMatchObject({ code: 'code-3', stage: 'echo' });
    // Sign-in happened in the browser; the wizard now has an identity and a key.
    client.identity = identity;
    client.deviceKey = key;
    await client.register();
    expect(await client.claim()).toMatchObject({ id: 'flow-3', status: 'pending', deviceId: DEVICE_ID });
    expect(seen.at(-1)).toMatchObject({ route: '/api/v1/setup/code-3/claim', body: {}, authorization: 'Bearer tok' });
    expect(seen.at(-1)).not.toHaveProperty('proof');
    expect(await client.wait({ pollMs: 5 })).toMatchObject({ status: 'approved' });
    await client.stop();
  });

  it('reports failed flows and treats a rejected token or a missing perk as "not enabled"', async () => {
    const client = await new SetupClient({ origin, file: journalFile, identity }).initialize();
    let status = 'failed';
    let start: ReturnType<Handler> = {
      body: {
        id: 'flow-2',
        code: 'code-2',
        url: `${origin}/setup/code-2`,
        installId: identity.installId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    handler = ({ route }) => {
      if (route === '/api/v1/setup/start') return start;
      if (route === '/api/v1/setup/code-2') return { body: { id: 'flow-2', status, deviceId: DEVICE_ID } };
      return { status: 404, body: { error: 'not_found' } };
    };
    await client.start('slack');
    await expect(client.wait({ pollMs: 5 })).rejects.toThrow('cancelled or failed');
    status = 'skipped';
    expect(await client.wait({ pollMs: 5 })).toMatchObject({ status: 'skipped' });
    start = { status: 401, body: { error: 'installation_revoked' } };
    expect(await client.resumeEnabled('slack')).toBe(false);
    start = { status: 403, body: { error: 'perk_not_enabled' } };
    expect(await client.resumeEnabled('slack')).toBe(false);
    start = { status: 500, body: { error: 'boom' } };
    await expect(client.resumeEnabled('slack')).rejects.toMatchObject({ status: 500 });
    expect(
      seen
        .filter((r) => r.route === '/api/v1/setup/start')
        .every((r) => r.body && !('publicKey' in (r.body as object))),
    ).toBe(true);
    await client.stop();
    const anonymous = await new SetupClient({ origin, file: journalFile }).initialize();
    expect(await anonymous.resumeEnabled('slack')).toBe(false);
    await anonymous.stop();
  });
});
