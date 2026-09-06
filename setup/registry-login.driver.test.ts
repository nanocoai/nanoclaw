import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DriverCancelled } from './lib/setup-driver.js';
import type {
  DriverDisplay,
  DriverPrompt,
  ExternalAction,
  ExternalActionResult,
  SetupDriver,
} from './lib/setup-driver.js';

vi.mock('./install-cred-helper.js', () => ({
  installCredentialHelper: () => ({ helperPath: '/tmp/docker-credential-nanoclaw', onPath: true }),
}));
vi.mock('./lib/registry-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/registry-state.js')>()),
  writeImageSource: vi.fn(),
}));

const ENV_KEYS = [
  'NANOCLAW_REGISTRY_API',
  'NANOCLAW_REGISTRY_TOKEN',
  'NANOCLAW_REGISTRY_ENROLL_CODE',
  'NANOCLAW_WORKOS_CLIENT_ID',
  'NANOCLAW_WORKOS_DEVICE_ENDPOINT',
  'NANOCLAW_WORKOS_TOKEN_ENDPOINT',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-registry-driver-'));
const configDir = path.join(testHome, '.config', 'nanoclaw');
const accountFile = path.join(configDir, 'account.json');
const registryAuthFile = path.join(configDir, 'registry-auth.json');

let runRegistryLoginWithDriver: typeof import('./registry-login.js').runRegistryLoginWithDriver;
const servers: Server[] = [];

beforeAll(async () => {
  process.env.HOME = testHome;
  ({ runRegistryLoginWithDriver } = await import('./registry-login.js'));
});

beforeEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface DriverHarness extends SetupDriver {
  actions: ExternalAction[];
  cleared: string[];
  displays: DriverDisplay[];
  logs: string[];
  notes: string[];
  progresses: Array<{ stepId: string; state: string; label?: string }>;
  prompts: DriverPrompt[];
}

function driver(
  answers: Array<boolean | string>,
  controller = new AbortController(),
  externalResult: ExternalActionResult = 'attempted',
): DriverHarness {
  const prompts: DriverPrompt[] = [];
  const displays: DriverDisplay[] = [];
  const actions: ExternalAction[] = [];
  const cleared: string[] = [];
  const logs: string[] = [];
  const notes: string[] = [];
  const progresses: DriverHarness['progresses'] = [];
  return {
    mode: 'ndjson',
    operation: 'setup',
    cancellationSignal: controller.signal,
    prompts,
    displays,
    actions,
    cleared,
    logs,
    notes,
    progresses,
    async prompt(spec) {
      prompts.push(spec);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`No answer for ${spec.id}`);
      return answer;
    },
    async externalAction(action, verify): Promise<ExternalActionResult> {
      actions.push(action);
      if (externalResult !== 'attempted') return externalResult;
      return (await verify()) ? 'attempted' : 'unsupported';
    },
    display(value) {
      displays.push(value);
    },
    clearDisplay(id) {
      cleared.push(id);
    },
    note(content) {
      notes.push(content);
    },
    log(_level, message) {
      logs.push(message);
    },
    progress(stepId, state, label) {
      progresses.push({ stepId, state, ...(label ? { label } : {}) });
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new DriverCancelled('test');
    },
  } as unknown as DriverHarness;
}

interface FixtureOptions {
  idp?: boolean;
  device?: Record<string, unknown>;
  tokens?: Array<{ status: number; body: Record<string, unknown> }>;
  enroll?: Record<string, unknown>;
  probe?: { status: number; body: Record<string, unknown> };
  onTokenRequest?: (res: ServerResponse) => boolean;
}

interface Fixture {
  api: string;
  requests: Array<{ method: string; path: string; body: string }>;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  let api = '';
  let tokenIndex = 0;
  const server = createServer(async (req, res) => {
    const body = await requestBody(req);
    const pathname = new URL(req.url ?? '/', 'http://fixture').pathname;
    requests.push({ method: req.method ?? 'GET', path: pathname, body });
    if (pathname === '/v1/auth-config') {
      send(
        res,
        options.idp === false ? 503 : 200,
        options.idp === false
          ? { device_flow_available: false }
          : {
              device_flow_available: true,
              client_id: 'fixture-client',
              device_authorization_endpoint: `${api}/device`,
              token_endpoint: `${api}/token`,
            },
      );
      return;
    }
    if (pathname === '/device') {
      send(
        res,
        200,
        options.device ?? {
          device_code: 'device-secret',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://idp.example/verify',
          verification_uri_complete: 'https://idp.example/verify?user_code=ABCD-EFGH',
          expires_in: 60,
          interval: 1,
        },
      );
      return;
    }
    if (pathname === '/token') {
      if (options.onTokenRequest?.(res)) return;
      const responses = options.tokens ?? [{ status: 200, body: { access_token: 'idp-secret' } }];
      const response = responses[Math.min(tokenIndex++, responses.length - 1)];
      send(res, response.status, response.body);
      return;
    }
    if (pathname === '/v1/enroll') {
      send(
        res,
        201,
        options.enroll ?? {
          token: 'registry-secret',
          account_id: 'acct-1',
          email: 'owner@example.com',
          registry: 'registry.example.com',
          entitlements: ['hardened-image'],
          email_updates: false,
        },
      );
      return;
    }
    if (pathname === '/v1/session/probe') {
      const response = options.probe ?? { status: 401, body: {} };
      send(res, response.status, response.body);
      return;
    }
    if (pathname === '/v1/account/preferences') {
      send(res, 200, {});
      return;
    }
    send(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  api = `http://127.0.0.1:${address.port}`;
  return { api, requests };
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function requestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function expectNoCredential(): void {
  expect(fs.existsSync(accountFile)).toBe(false);
  expect(fs.existsSync(registryAuthFile)).toBe(false);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached');
}

describe('runRegistryLoginWithDriver', () => {
  it('completes pending device auth, emits sensitive semantics, records consent, and writes owner-only credentials', async () => {
    const local = await fixture({
      tokens: [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: { access_token: 'idp-secret' } },
      ],
      enroll: {
        token: 'registry-secret',
        account_id: 'acct-1',
        registry: 'registry.example.com',
        entitlements: [],
        email_updates: null,
      },
    });
    fs.mkdirSync(configDir, { recursive: true });
    for (const file of [`${accountFile}.tmp`, `${registryAuthFile}.tmp`]) {
      fs.writeFileSync(file, 'stale', { mode: 0o644 });
      fs.chmodSync(file, 0o644);
    }
    const harness = driver(['', false]);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'device',
    });

    expect(local.requests.filter((request) => request.path === '/token')).toHaveLength(2);
    expect(local.requests.find((request) => request.path === '/v1/account/preferences')?.body).toContain(
      '"email_updates":false',
    );
    expect(harness.displays).toEqual([
      expect.objectContaining({ kind: 'url', sensitive: true, url: expect.stringMatching(/^https:/) }),
      expect.objectContaining({ kind: 'code', sensitive: true, content: 'ABCD-EFGH' }),
    ]);
    expect(harness.actions).toEqual([expect.objectContaining({ kind: 'openURL', url: 'https://idp.example/verify' })]);
    expect(harness.cleared).toEqual(['registry-verification-url', 'registry-user-code']);
    expect(harness.progresses).toEqual([
      { stepId: 'registry-login', state: 'running', label: 'Authenticating with NanoClaw' },
      { stepId: 'registry-login', state: 'running', label: 'Waiting for browser approval' },
      { stepId: 'registry-login', state: 'succeeded' },
    ]);
    for (const file of [accountFile, registryAuthFile, path.join(configDir, 'host-id')]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(`${accountFile}.tmp`)).toBe(false);
    expect(fs.existsSync(`${registryAuthFile}.tmp`)).toBe(false);
    expect(JSON.stringify(harness)).not.toContain('registry-secret');
    expect(JSON.parse(fs.readFileSync(registryAuthFile, 'utf8'))).toMatchObject({
      broker_url: local.api,
      registry: 'registry.example.com',
      token: 'registry-secret',
    });
  }, 5_000);

  it('honors slow_down before accepting the next token response', async () => {
    const local = await fixture({
      tokens: [
        { status: 400, body: { error: 'slow_down' } },
        { status: 200, body: { access_token: 'idp-secret' } },
      ],
    });

    await expect(runRegistryLoginWithDriver(driver(['', 'browser']), { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'device',
    });
    expect(local.requests.filter((request) => request.path === '/token')).toHaveLength(2);
  }, 9_000);

  it.each([
    ['declined', { tokens: [{ status: 400, body: { error: 'access_denied' } }] }],
    [
      'expired',
      {
        device: {
          device_code: 'd',
          user_code: 'u',
          verification_uri: 'https://idp.example/verify',
          expires_in: 0,
          interval: 1,
        },
      },
    ],
    ['malformed device response', { device: { device_code: 'd', verification_uri: 'https://idp.example/verify' } }],
    ['malformed token response', { tokens: [{ status: 200, body: {} }] }],
    [
      'unsafe browser URL',
      {
        device: {
          device_code: 'd',
          user_code: 'u',
          verification_uri: 'http://idp.example/verify',
          expires_in: 60,
          interval: 1,
        },
      },
    ],
  ] satisfies Array<[string, FixtureOptions]>)(
    'fails closed for a %s',
    async (_name, options) => {
      const local = await fixture(options);
      const harness = driver(['', 'browser']);

      await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
        kind: 'failed',
        reason: 'sign-in-failed',
      });
      expect(harness.progresses.at(-1)).toEqual({ stepId: 'registry-login', state: 'failed' });
      expectNoCredential();
    },
    3_000,
  );

  it.each([
    ['unsupported', { kind: 'ready', method: 'device' }],
    ['declined', { kind: 'skipped', reason: 'declined' }],
  ] as const)(
    'handles an %s browser action and clears its sensitive displays',
    async (action, expected) => {
      const local = await fixture();
      const harness = driver(['', 'browser'], new AbortController(), action);

      await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual(expected);
      expect(harness.cleared).toEqual(['registry-verification-url', 'registry-user-code']);
      expect(local.requests.filter((request) => request.path === '/token')).toHaveLength(action === 'declined' ? 0 : 1);
      expect(harness.progresses.at(-1)).toEqual({
        stepId: 'registry-login',
        state: 'succeeded',
      });
    },
    3_000,
  );

  it('cancels promptly during the polling wait and clears sensitive displays', async () => {
    const controller = new AbortController();
    const local = await fixture();
    const harness = driver(['', 'browser'], controller);
    const running = runRegistryLoginWithDriver(harness, { api: local.api });
    await waitUntil(() => harness.actions.length === 1);
    controller.abort('operator_cancelled');

    await expect(running).rejects.toBeInstanceOf(DriverCancelled);
    expect(harness.cleared).toEqual(['registry-verification-url', 'registry-user-code']);
    expectNoCredential();
  });

  it('aborts an in-flight token request without persisting a partial credential', async () => {
    const controller = new AbortController();
    const local = await fixture({
      onTokenRequest() {
        controller.abort('operator_cancelled');
        return true;
      },
    });

    await expect(
      runRegistryLoginWithDriver(driver(['', 'browser'], controller), { api: local.api }),
    ).rejects.toBeInstanceOf(DriverCancelled);
    expectNoCredential();
  }, 3_000);

  it('uses a secret enrollment prompt when the broker has no identity provider', async () => {
    const local = await fixture({ idp: false });
    const harness = driver(['enroll-secret']);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'code',
    });
    expect(harness.prompts).toEqual([
      expect.objectContaining({ id: 'registry-enrollment-code', kind: 'secret', sensitive: true }),
    ]);
    expect(local.requests.find((request) => request.path === '/v1/enroll')?.body).toContain('enroll-secret');
    expect(JSON.stringify({ logs: harness.logs, notes: harness.notes, prompts: harness.prompts })).not.toContain(
      'enroll-secret',
    );
  });

  it('accepts an enrollment code when browser authentication is available', async () => {
    const local = await fixture();
    const harness = driver(['enroll-secret']);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'code',
    });
    expect(harness.prompts).toEqual([
      expect.objectContaining({ id: 'registry-enrollment-code', kind: 'secret', sensitive: true }),
    ]);
    expect(local.requests.some((request) => request.path === '/device')).toBe(false);
    expect(local.requests.find((request) => request.path === '/v1/enroll')?.body).toContain('enroll-secret');
  });

  it('keeps a valid existing credential without prompting again', async () => {
    const local = await fixture({
      probe: {
        status: 200,
        body: { account_id: 'acct-1', email: 'fresh@example.com', registry: 'registry.example.com', entitlements: [] },
      },
    });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      accountFile,
      JSON.stringify({
        version: 1,
        api: local.api,
        account_id: 'acct-1',
        token: 'existing-secret',
        entitlements: [],
        created_at: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );
    const harness = driver([]);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'existing',
    });
    expect(harness.prompts).toHaveLength(0);
    expect(harness.progresses.at(-1)).toEqual({ stepId: 'registry-login', state: 'succeeded' });
    expect(JSON.parse(fs.readFileSync(accountFile, 'utf8'))).toMatchObject({ email: 'fresh@example.com' });
  });

  it('returns a skip result when the enrollment code is left blank', async () => {
    const local = await fixture({ idp: false });
    const harness = driver(['']);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'skipped',
      reason: 'declined',
    });
    expect(harness.progresses.at(-1)).toEqual({ stepId: 'registry-login', state: 'succeeded' });
    expectNoCredential();
  });

  it('fails without buffering an oversized registry response', async () => {
    const local = await fixture({ idp: false, enroll: { padding: 'x'.repeat(300_000) } });
    const harness = driver(['enroll-secret']);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'failed',
      reason: 'sign-in-failed',
    });
    expect(harness.progresses.at(-1)).toEqual({ stepId: 'registry-login', state: 'failed' });
    expectNoCredential();
  });

  it('adopts a preset account token from the environment without prompting', async () => {
    const local = await fixture({
      probe: {
        status: 200,
        body: { account_id: 'acct-1', email: 'ci@example.com', registry: 'registry.example.com', entitlements: [] },
      },
    });
    process.env.NANOCLAW_REGISTRY_TOKEN = 'preset-token-secret';
    const harness = driver([]);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'existing',
    });
    // A scripted or CI install has nobody at the keyboard, so a single prompt
    // is the whole regression: the run stalls on a masked enrollment code.
    expect(harness.prompts).toEqual([]);
    expect(local.requests.some((request) => request.path === '/device')).toBe(false);
    expect(harness.progresses.at(-1)).toEqual({ stepId: 'registry-login', state: 'succeeded' });
    expect(JSON.parse(fs.readFileSync(registryAuthFile, 'utf8'))).toMatchObject({
      broker_url: local.api,
      registry: 'registry.example.com',
      token: 'preset-token-secret',
    });
  });

  it('enrolls with a preset enrollment code from the environment without prompting', async () => {
    const local = await fixture();
    process.env.NANOCLAW_REGISTRY_ENROLL_CODE = 'preset-code-secret';
    const harness = driver([]);

    await expect(runRegistryLoginWithDriver(harness, { api: local.api })).resolves.toEqual({
      kind: 'ready',
      method: 'code',
    });
    expect(harness.prompts).toEqual([]);
    expect(local.requests.some((request) => request.path === '/device')).toBe(false);
    expect(local.requests.find((request) => request.path === '/v1/enroll')?.body).toContain('preset-code-secret');
    expect(JSON.parse(fs.readFileSync(registryAuthFile, 'utf8'))).toMatchObject({ token: 'registry-secret' });
  });
});
