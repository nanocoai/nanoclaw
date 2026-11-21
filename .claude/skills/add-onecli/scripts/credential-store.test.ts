import { getProviderHostContract, registerProviderHostContract } from '../../../../src/provider-contracts/index.js';
if (!getProviderHostContract('codex'))
  registerProviderHostContract('codex', {
    ...getProviderHostContract('claude')!,
    modelDomains: ['openai.com', 'chatgpt.com'],
    modelEndpoints: {
      api: 'https://api.openai.com',
      subscription: 'https://chatgpt.com',
      token: 'https://auth.openai.com/oauth/token',
    },
  });
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));
import { createCredentialStore } from './credential-store.js';
afterEach(() => vi.resetAllMocks());
it('passes API credentials in a private temporary file, never in argv, and removes it', async () => {
  let file = '';
  exec.mockImplementation((_bin, args) => {
    file = args[args.indexOf('--file') + 1];
    expect(fs.readFileSync(file, 'utf8')).toBe('fixture-key');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(args).not.toContain('fixture-key');
  });
  // Never this checkout: a live install's record would send the save to its real vault.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-argv-'));
  try {
    await createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-key' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(fs.existsSync(file)).toBe(false);
});
it('counts only credentials Codex groups will be granted, records them, and fails explicitly without a vault', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-has-'));
  const record = () =>
    JSON.parse(fs.readFileSync(path.join(root, 'data', 'onecli', 'provider-credentials.json'), 'utf8')).providers;
  try {
    // OpenCode's credentials are not Codex's: Codex setup must still sign in.
    exec.mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'sec-oc', name: 'OpenCode openai', type: 'generic' },
          { id: 'sec-chatgpt', name: 'OpenCode ChatGPT', type: 'openai' },
        ],
      }),
    );
    expect(await createCredentialStore(root).has('codex')).toBe(false);
    // A credential Codex setup saved is counted and recorded, so a retried login repairs the record.
    exec.mockReturnValueOnce(JSON.stringify({ hint: 'h', data: [{ id: 'sec-codex', name: 'Codex', type: 'openai' }] }));
    expect(await createCredentialStore(root).has('codex')).toBe(true);
    expect(record()).toEqual({ codex: ['sec-codex'] });
    expect(exec.mock.calls.every(([, args]) => args.join(' ') === 'secrets list --max 0')).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  exec.mockImplementation(() => {
    throw new Error('fixture-private-error');
  });
  await expect(createCredentialStore().has('codex')).rejects.toThrow('Cannot read the selected OneCLI vault');
});
it('records the created Codex secret id so Codex groups are granted it, and only after a successful save', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-record-'));
  const file = path.join(root, 'data', 'onecli', 'provider-credentials.json');
  try {
    exec.mockReturnValueOnce('{\n  "hint": "attach it",\n  "id": "sec-codex"\n}');
    await createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-key' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers).toEqual({ codex: ['sec-codex'] });
    fs.rmSync(path.join(root, 'data'), { recursive: true });
    exec.mockReturnValueOnce('not json');
    await createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-key' });
    exec.mockImplementationOnce(() => {
      throw new Error('fixture-private-error');
    });
    await expect(createCredentialStore(root).save('codex', { kind: 'api-key', value: 'k' })).rejects.toThrow(
      'Cannot save Codex credentials',
    );
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('Codex: a recorded id counts as connected; duplicate names without one do not, and nothing is recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dupes-'));
  const file = path.join(root, 'data', 'onecli', 'provider-credentials.json');
  try {
    exec.mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'c1', name: 'Codex' },
          { id: 'c2', name: 'Codex' },
        ],
      }),
    );
    expect(await createCredentialStore(root).has('codex')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers: { codex: ['c1'] }, matched: [] }));
    exec.mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'c1', name: 'Codex' },
          { id: 'c2', name: 'Codex' },
        ],
      }),
    );
    expect(await createCredentialStore(root).has('codex')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers).toEqual({ codex: ['c1'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('Codex: a recorded id that left the vault is not replaced by another install’s same-named key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gone-'));
  const file = path.join(root, 'data', 'onecli', 'provider-credentials.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers: { codex: ['c-gone'] }, matched: ['codex'] }));
    exec.mockReturnValueOnce(JSON.stringify({ data: [{ id: 'c-other', name: 'Codex' }] }));
    expect(await createCredentialStore(root).has('codex')).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers).toEqual({ codex: ['c-gone'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('Codex: after the one-time match found nothing, a later same-named key is not adopted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-matched-'));
  const file = path.join(root, 'data', 'onecli', 'provider-credentials.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers: { codex: [] }, matched: ['codex'] }));
    exec.mockReturnValueOnce(JSON.stringify({ data: [{ id: 'c-other', name: 'Codex' }] }));
    expect(await createCredentialStore(root).has('codex')).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers).toEqual({ codex: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Codex: signing in again', () => {
  const login = '{"tokens":{"access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"acct"}}';
  let root: string;
  let record: string;
  let calls: Array<{ url: string; method: string; body?: unknown }>;
  let listed: unknown[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-replace-'));
    record = path.join(root, 'data', 'onecli', 'provider-credentials.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ providers: { codex: ['sec-codex'] }, matched: ['codex'] }));
    calls = [];
    listed = [{ id: 'sec-codex', name: 'Codex', type: 'openai', hostPattern: 'chatgpt.com', valueSource: 'inline' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(init.method === 'GET' ? listed : { success: true }), { status: 200 });
      }),
    );
    vi.stubEnv('ONECLI_URL', 'http://onecli.test:10254');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const save = (credential: Parameters<ReturnType<typeof createCredentialStore>['save']>[1]) =>
    createCredentialStore(root).save('codex', credential);
  const loginFile = (content: string) => {
    const file = path.join(root, 'auth.json');
    fs.writeFileSync(file, `${content}\n`);
    return file;
  };

  it('updates the recorded secret in place, so no second Codex secret is created', async () => {
    await save({ kind: 'oauth', file: loginFile(login) });

    expect(exec).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { url: 'http://onecli.test:10254/v1/secrets', method: 'GET', body: undefined },
      { url: 'http://onecli.test:10254/v1/secrets/sec-codex', method: 'PATCH', body: { value: login } },
    ]);
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).providers).toEqual({ codex: ['sec-codex'] });
  });

  it('replaces the only recorded secret with an API key, through the same connection', async () => {
    await save({ kind: 'api-key', value: 'fixture-key' });

    expect(exec).not.toHaveBeenCalled();
    expect(calls[1]).toEqual({
      url: 'http://onecli.test:10254/v1/secrets/sec-codex',
      method: 'PATCH',
      body: { value: 'fixture-key' },
    });
  });

  it('refuses two recorded logins on one host instead of filling both or adding a third', async () => {
    fs.writeFileSync(record, JSON.stringify({ providers: { codex: ['sec-a', 'sec-b'] }, matched: ['codex'] }));
    listed = ['sec-a', 'sec-b'].map((id) => ({ id, name: 'Codex', type: 'openai', hostPattern: 'chatgpt.com' }));

    await expect(save({ kind: 'oauth', file: loginFile(login) })).rejects.toThrow(
      'Several recorded Codex secrets use chatgpt.com (sec-a, sec-b)',
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    '{"tokens":{"refresh_token":"fixture-refresh"}}',
    '{"tokens":{"access_token":"","refresh_token":"","account_id":"acct"}}',
    '{"tokens":{"access_token":"fixture-access","refresh_token":"fixture-refresh"}}',
  ])('never replaces a login with a ChatGPT session missing a token: %s', async (partial) => {
    await expect(save({ kind: 'oauth', file: loginFile(partial) })).rejects.toThrow(
      'Codex login did not produce a complete ChatGPT session.',
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('counts every recorded secret on the host as competing, whatever its type', async () => {
    fs.writeFileSync(record, JSON.stringify({ providers: { codex: ['sec-a', 'sec-b'] }, matched: ['codex'] }));
    listed = [
      { id: 'sec-a', name: 'Codex', type: 'openai', hostPattern: 'chatgpt.com', valueSource: 'inline' },
      { id: 'sec-b', name: 'OpenAI', type: 'generic', hostPattern: 'chatgpt.com' },
    ];

    await expect(save({ kind: 'oauth', file: loginFile(login) })).rejects.toThrow(
      'Several recorded Codex secrets use chatgpt.com (sec-a, sec-b)',
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses to add a second secret beside a recorded one on the host it cannot replace', async () => {
    listed = [
      { id: 'sec-codex', name: 'Codex', type: 'openai', hostPattern: 'api.openai.com', valueSource: 'onepassword' },
    ];

    await expect(save({ kind: 'api-key', value: 'fixture-key' })).rejects.toThrow(
      'The recorded Codex secret sec-codex on api.openai.com is not an inline OpenAI login',
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(exec).not.toHaveBeenCalled();
  });

  it('creates a secret as before when the recorded one is not an inline OpenAI login', async () => {
    listed = [{ id: 'sec-codex', name: 'Codex', type: 'generic', hostPattern: 'chatgpt.com' }];
    exec.mockReturnValueOnce('{"id":"sec-new"}');

    await save({ kind: 'api-key', value: 'fixture-key' });

    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(['secrets', 'create']);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).providers).toEqual({ codex: ['sec-codex', 'sec-new'] });
  });
});
