import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_PROOF_HEADER, verifyDeviceProof, type DevicePublicJwk } from '../src/community-portal/index.js';

/**
 * The single-visit enrollment path end to end, against loopback stand-ins for
 * the portal, the registry broker and the WorkOS device endpoints. The real
 * sign-in driver functions, the real portal client and the real files under a
 * temporary HOME are exercised; only the browser opener, the docker credential
 * helper installer and the prompts are doubles. Nothing here touches the network.
 */
const mock = vi.hoisted(() => ({ open: vi.fn(), confirm: vi.fn(), logs: vi.fn(), helper: vi.fn() }));
vi.mock('./lib/browser.js', () => ({ openUrl: mock.open }));
vi.mock('./install-cred-helper.js', () => ({ installCredentialHelper: mock.helper }));
vi.mock('@clack/prompts', () => ({
  confirm: mock.confirm,
  isCancel: (v: unknown) => typeof v === 'symbol',
  log: { info: mock.logs, success: mock.logs, warn: mock.logs, step: mock.logs, message: mock.logs },
}));

// The sign-in driver resolves ~/.config/nanoclaw when it loads, so HOME is set first.
const home = mkdtempSync(path.join(os.tmpdir(), 'nc-portal-e2e-home-'));
process.env.HOME = home;
const { runImagePortal } = await import('./portal.js');

const DEVICE_ID = 'dev_0123456789abcdef01234567';
const USER_CODE = 'ABCD-EFGH';
const ACTIVATE = 'https://auth.example.test/activate';
interface Seen {
  method: string;
  route: string;
  body?: unknown;
  bearer?: string;
  proofValid?: boolean;
}
let server: Server;
let origin: string;
let root: string;
let stdout: string[];
const seen: Seen[] = [];
const fake = {
  tokenPolls: 0,
  tokenOutcome: 'approve' as 'approve' | 'deny',
  flowStatus: undefined as string | undefined,
  pinned: undefined as DevicePublicJwk | undefined,
  statusPolls: 0,
};
const hostId = () => readFile(path.join(home, '.config/nanoclaw/host-id'), 'utf8').then((s) => s.trim());

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const route = new URL(req.url ?? '/', origin).pathname;
  const method = req.method ?? '';
  const form = req.headers['content-type']?.includes('x-www-form-urlencoded');
  const body: unknown = raw ? (form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined;
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const record: Seen = { method, route, body, ...(bearer ? { bearer } : {}) };
  seen.push(record);
  const reply = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const proofAgainst = (key: DevicePublicJwk | undefined): boolean => {
    const proof = req.headers[DEVICE_PROOF_HEADER];
    record.proofValid = typeof proof === 'string' && key !== undefined && verifyDeviceProof(proof, key).valid;
    return record.proofValid;
  };
  const signedIn = bearer === 'install-token-test';

  // WorkOS (device authorization grant, form-encoded, RFC 8628)
  if (route === '/workos/device') {
    expect(body).toEqual({ client_id: 'client-test' });
    return reply(200, {
      device_code: 'device-code-secret',
      user_code: USER_CODE,
      verification_uri: ACTIVATE,
      verification_uri_complete: `${ACTIVATE}?user_code=${USER_CODE}`,
      expires_in: 300,
      interval: 1,
    });
  }
  if (route === '/workos/token') {
    expect(body).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-code-secret',
      client_id: 'client-test',
    });
    fake.tokenPolls++;
    if (fake.tokenOutcome === 'deny') return reply(400, { error: 'access_denied' });
    if (fake.tokenPolls < 3) return reply(400, { error: 'authorization_pending' });
    return reply(200, { access_token: 'idp-access-token' });
  }
  // Registry broker
  if (route === '/v1/auth-config')
    return reply(200, {
      device_flow_available: true,
      client_id: 'client-test',
      device_authorization_endpoint: `${origin}/workos/device`,
      token_endpoint: `${origin}/workos/token`,
    });
  if (route === '/v1/enroll') {
    expect(body).toMatchObject({
      method: 'idp',
      provider: 'workos',
      workos_token: 'idp-access-token',
      install_id: await hostId(),
    });
    return reply(201, {
      account_id: 'acct-e2e',
      token: 'install-token-test',
      registry: 'images.example.test',
      entitlements: ['echo'],
      email: 'e2e@example.test',
    });
  }
  // Portal
  if (route === '/api/v1/catalog') return reply(200, { items: [{ id: 'echo', kind: 'account' }] });
  if (route === '/api/v1/setup/start') {
    if (bearer) return reply(400, { error: 'expected_anonymous' });
    fake.flowStatus = 'awaiting_installation';
    return reply(200, {
      code: 'code-1',
      id: 'flow-1',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      url: `${origin}/?setup=code-1`,
    });
  }
  if (route === '/api/v1/devices') {
    const publicKey = (body as { publicKey?: DevicePublicJwk }).publicKey;
    if (!signedIn) return reply(401, { error: 'invalid_token' });
    if (!proofAgainst(publicKey)) return reply(401, { error: 'invalid_proof' });
    fake.pinned = publicKey;
    return reply(200, { deviceId: DEVICE_ID, accountId: 'acct-e2e', installId: await hostId() });
  }
  if (!signedIn) return reply(401, { error: 'invalid_token' });
  if (!fake.pinned) return reply(403, { error: 'installation_required' });
  const state = () => ({
    id: 'flow-1',
    stage: 'echo',
    deviceId: DEVICE_ID,
    status: fake.flowStatus,
    choice: fake.flowStatus === 'approved' ? { imageSource: 'hardened', workspaceId: 'T1', name: 'Nano' } : undefined,
  });
  if (route === '/api/v1/setup/code-1/claim') {
    if (fake.flowStatus !== 'awaiting_installation') return reply(409, { error: 'setup_claimed' });
    fake.flowStatus = 'pending';
    return reply(200, state());
  }
  if (route === '/api/v1/setup/code-1' && method === 'GET') {
    if (++fake.statusPolls >= 2 && fake.flowStatus === 'pending') fake.flowStatus = 'approved';
    return reply(200, state());
  }
  if (route === '/api/v1/setup/code-1/complete') return reply(200, { ok: true });
  if (route === '/api/v1/device/state') return reply(200, { grants: [] });
  return reply(404, { error: 'not_found' });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-e2e-root-'));
  await mkdir(path.join(root, 'data'));
  seen.length = 0;
  stdout = [];
  Object.assign(fake, {
    tokenPolls: 0,
    tokenOutcome: 'approve',
    flowStatus: undefined,
    pinned: undefined,
    statusPolls: 0,
  });
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
  process.env.NANOCLAW_PORTAL_ORIGIN = origin;
  process.env.NANOCLAW_REGISTRY_API = origin;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  mock.confirm.mockResolvedValue(true);
  mock.helper.mockReturnValue({ onPath: true, helperPath: '/tmp/helper' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.NANOCLAW_PORTAL_ORIGIN;
  delete process.env.NANOCLAW_REGISTRY_API;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  await rm(path.join(home, '.config'), { recursive: true, force: true });
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
const mkdtemp = (prefix: string): Promise<string> => Promise.resolve(mkdtempSync(prefix));
const mode = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

describe('single-visit enrollment', () => {
  it('signs in, registers, claims and finishes the stage with one portal link and no WorkOS page', async () => {
    await runImagePortal();

    const routes = seen.map((r) => r.route);
    expect(routes).toEqual([
      '/api/v1/catalog',
      '/v1/auth-config',
      '/workos/device',
      '/api/v1/setup/start',
      '/workos/token',
      '/workos/token',
      '/workos/token',
      '/v1/enroll',
      '/api/v1/devices',
      '/api/v1/setup/code-1/claim',
      '/api/v1/setup/code-1',
      '/api/v1/setup/code-1',
      '/api/v1/device/state',
      '/api/v1/setup/code-1/complete',
    ]);
    const start = seen.find((r) => r.route === '/api/v1/setup/start');
    expect(start?.bearer).toBeUndefined();
    expect(start?.body).toEqual({
      stage: 'echo',
      name: 'Nano',
      autoContinue: true,
      label: expect.stringContaining(path.basename(root)),
      verification: { userCode: USER_CODE, verificationUri: `${ACTIVATE}?user_code=${USER_CODE}` },
    });
    expect(seen.find((r) => r.route === '/api/v1/devices')).toMatchObject({
      bearer: 'install-token-test',
      proofValid: true,
      body: { publicKey: { kty: 'EC', crv: 'P-256' } },
    });
    for (const route of ['/api/v1/setup/code-1/claim', '/api/v1/setup/code-1', '/api/v1/device/state'])
      expect(seen.find((r) => r.route === route)?.bearer).toBe('install-token-test');

    // One link, opened once, before the token polling; the code and the sign-in page on their own lines.
    expect(mock.open).toHaveBeenCalledExactlyOnceWith(`${origin}/?setup=code-1`);
    const out = stdout.join('');
    expect(out).toContain(`\n${origin}/?setup=code-1\n`);
    expect(out).toContain(`Code: ${USER_CODE}\n${ACTIVATE}?user_code=${USER_CODE}\n`);
    expect(out).not.toContain('device-code-secret');

    // Persisted exactly as the standalone sign-in does.
    const account = JSON.parse(await readFile(path.join(home, '.config/nanoclaw/account.json'), 'utf8'));
    expect(account).toMatchObject({
      version: 1,
      api: origin,
      account_id: 'acct-e2e',
      token: 'install-token-test',
      registry: 'images.example.test',
      entitlements: ['echo'],
    });
    expect(JSON.parse(await readFile(path.join(home, '.config/nanoclaw/registry-auth.json'), 'utf8'))).toEqual({
      version: 1,
      broker_url: origin,
      registry: 'images.example.test',
      token: 'install-token-test',
    });
    expect(mock.helper).toHaveBeenCalledWith({ registryHost: 'images.example.test' });
    expect(await mode(path.join(home, '.config/nanoclaw/account.json'))).toBe(0o600);
    expect(await mode(path.join(home, '.config/nanoclaw/device-key.json'))).toBe(0o600);
    const journal = JSON.parse(await readFile(path.join(root, 'data/community-portal.json'), 'utf8'));
    expect(journal).toMatchObject({ origin, deviceId: DEVICE_ID, credentials: {}, operations: {} });
    expect(JSON.stringify(journal)).not.toMatch(/install-token-test|pkcs8|privateKey/);
    expect(await readFile(path.join(root, '.env'), 'utf8')).toContain('NANOCLAW_HARDENED_IMAGE=true');
  }, 20_000);

  it('skips the stage when the sign-in is declined in the browser: nothing registered, nothing claimed', async () => {
    fake.tokenOutcome = 'deny';
    await runImagePortal();
    const routes = seen.map((r) => r.route);
    expect(routes).toEqual([
      '/api/v1/catalog',
      '/v1/auth-config',
      '/workos/device',
      '/api/v1/setup/start',
      '/workos/token',
    ]);
    expect(mock.open).toHaveBeenCalledOnce();
    expect(mock.logs.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('declined'));
    await expect(readFile(path.join(home, '.config/nanoclaw/account.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(home, '.config/nanoclaw/device-key.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(root, '.env'), 'utf8')).toContain('NANOCLAW_HARDENED_IMAGE=false');
  }, 20_000);
});
