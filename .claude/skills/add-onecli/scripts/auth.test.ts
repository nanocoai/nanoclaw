import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: child.exec, spawnSync: child.spawn }));
const prompts = vi.hoisted(() => ({ select: vi.fn(), password: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  select: prompts.select,
  password: prompts.password,
  isCancel: () => false,
  log: { success: vi.fn(), warn: vi.fn() },
}));

import { run } from './auth.js';

let root: string;
const record = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'data', 'onecli', 'provider-credentials.json'), 'utf8')).providers;
// The sign-in script writes the captured token to the path it is given.
const signIn = () =>
  child.spawn.mockImplementationOnce((_cmd: string, args: string[]) => {
    fs.writeFileSync(args[1], 'sk-ant-oat01-fixture');
    return { status: 0 };
  });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-auth-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('records the id of a Claude key saved for a custom endpoint', async () => {
  vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', 'https://llm.example.test');
  vi.stubEnv('NANOCLAW_ANTHROPIC_AUTH_TOKEN', 'fixture-token');
  child.exec.mockReturnValueOnce('{"id":"sec-claude","name":"Anthropic"}');
  await run();
  expect(child.exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['secrets', 'create', '--name', 'Anthropic']));
  expect(record()).toEqual({ claude: ['sec-claude'] });
});

it('records the Anthropic secret a subscription sign-in saved', async () => {
  child.exec
    .mockReturnValueOnce(JSON.stringify({ data: [{ id: 'sec-vercel', name: 'Vercel', type: 'generic' }] }))
    .mockReturnValueOnce(JSON.stringify({ data: [{ id: 'sec-vercel', name: 'Vercel', type: 'generic' }] }))
    .mockReturnValueOnce('') // secrets create, no id in its output
    .mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'sec-vercel', name: 'Vercel', type: 'generic' },
          { id: 'sec-sub', name: 'Anthropic', type: 'anthropic' },
        ],
      }),
    );
  prompts.select.mockResolvedValueOnce('subscription');
  signIn();
  await run();
  const calls = child.exec.mock.calls.map(([, args]) => args as string[]);
  expect(calls.filter((a) => a[1] === 'list').every((a) => a.includes('--max') && a.includes('0'))).toBe(true);
  expect(calls.find((a) => a[1] === 'create')).toEqual(expect.arrayContaining(['--type', 'anthropic', '--file']));
  expect(record()).toEqual({ claude: ['sec-sub'] });
});

it('an already saved Anthropic key is recorded; a differently named or OpenCode key does not count as connected', async () => {
  child.exec.mockReturnValueOnce(JSON.stringify({ data: [{ id: 'sec-a', name: 'Anthropic', type: 'anthropic' }] }));
  await run();
  expect(record()).toEqual({ claude: ['sec-a'] });
  expect(prompts.select).not.toHaveBeenCalled();
  fs.rmSync(path.join(root, 'data'), { recursive: true });
  child.exec.mockReturnValueOnce(
    JSON.stringify({
      data: [
        { id: 'sec-oc', name: 'OpenCode anthropic', type: 'generic' },
        { id: 'sec-bob', name: 'Anthropic (Bob)', type: 'anthropic' },
      ],
    }),
  );
  prompts.select.mockResolvedValueOnce('skip');
  await run();
  expect(prompts.select).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
});

it('with duplicate Anthropic secrets and none recorded, asks to sign in and records only the new one', async () => {
  const dupes = [
    { id: 'sec-a', name: 'Anthropic', type: 'anthropic' },
    { id: 'sec-b', name: 'Anthropic', type: 'anthropic' },
  ];
  child.exec
    .mockReturnValueOnce(JSON.stringify({ data: dupes }))
    .mockReturnValueOnce(JSON.stringify({ data: dupes }))
    .mockReturnValueOnce('')
    .mockReturnValueOnce(JSON.stringify({ data: [...dupes, { id: 'sec-new', name: 'Anthropic', type: 'anthropic' }] }));
  prompts.select.mockResolvedValueOnce('subscription');
  signIn();
  await run();
  expect(prompts.select).toHaveBeenCalledOnce();
  expect(record()).toEqual({ claude: ['sec-new'] });
});

it('a recorded Claude key counts as connected and another same-named key is not added', async () => {
  fs.mkdirSync(path.join(root, 'data', 'onecli'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'onecli', 'provider-credentials.json'),
    JSON.stringify({ providers: { claude: ['sec-own'] }, matched: [] }),
  );
  child.exec.mockReturnValueOnce(
    JSON.stringify({
      data: [
        { id: 'sec-own', name: 'Anthropic' },
        { id: 'sec-other', name: 'Anthropic' },
      ],
    }),
  );
  await run();
  expect(prompts.select).not.toHaveBeenCalled();
  expect(record()).toEqual({ claude: ['sec-own'] });
});

const writeFile = (value: object) => {
  fs.mkdirSync(path.join(root, 'data', 'onecli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'onecli', 'provider-credentials.json'), JSON.stringify(value));
};

it('a recorded Claude key that left the vault is not replaced by a same-named key', async () => {
  writeFile({ providers: { claude: ['sec-gone'] }, matched: ['claude'] });
  child.exec.mockReturnValueOnce(JSON.stringify({ data: [{ id: 'sec-other', name: 'Anthropic' }] }));
  prompts.select.mockResolvedValueOnce('skip');
  await run();
  expect(prompts.select).toHaveBeenCalledOnce();
  expect(record()).toEqual({ claude: ['sec-gone'] });
});

it('a login recorded while setup reads the vault is not widened by the name match', async () => {
  child.exec.mockImplementationOnce(() => {
    writeFile({ providers: { claude: ['sec-own'] }, matched: [] });
    return JSON.stringify({ data: [{ id: 'sec-legacy', name: 'Anthropic' }] });
  });
  prompts.select.mockResolvedValueOnce('skip');
  await run();
  expect(record()).toEqual({ claude: ['sec-own'] });
});

it('a subscription sign-in that sees two new Anthropic secrets records neither and says so', async () => {
  child.exec
    .mockReturnValueOnce(JSON.stringify({ data: [] }))
    .mockReturnValueOnce(JSON.stringify({ data: [] }))
    .mockReturnValueOnce('')
    .mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'sec-x', name: 'Anthropic' },
          { id: 'sec-y', name: 'Anthropic' },
        ],
      }),
    );
  prompts.select.mockResolvedValueOnce('subscription');
  signIn();
  await expect(run()).rejects.toThrow(/more than one/);
  expect(fs.existsSync(path.join(root, 'data', 'onecli', 'provider-credentials.json'))).toBe(false);
});

it('saves a subscription token only under the name setup records', async () => {
  // A custom name would be saved but never recorded, so the group gets no key.
  const script = fs.readFileSync(path.join(__dirname, 'register-claude-token.sh'), 'utf8');
  expect(script).not.toMatch(/SECRET_NAME|onecli secrets/);
  child.exec.mockImplementation((_cmd: string, args: string[]) =>
    args[1] === 'list' ? '{"data":[]}' : '{"id":"sec-sub","name":"Anthropic"}',
  );
  prompts.select.mockResolvedValueOnce('subscription');
  signIn();
  await run();
  const create = child.exec.mock.calls.find(([, args]) => args[1] === 'create')?.[1];
  expect(create).toEqual(expect.arrayContaining(['--name', 'Anthropic']));
  expect(record()).toEqual({ claude: ['sec-sub'] });
});

describe('pasted Claude keys', () => {
  const argv = process.argv;
  // What `secrets create` read from its --file; the key itself never goes on argv.
  let saved: string | undefined;
  beforeEach(() => {
    // No .env and no saved secret, so run() goes straight to the prompt.
    process.argv = [argv[0], argv[1], 'claude'];
    vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', '');
    saved = undefined;
    child.exec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return '{"data":[]}';
      saved = fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8');
      return '{"id":"sec-new","name":"Anthropic"}';
    });
  });
  afterEach(() => {
    process.argv = argv;
  });

  it('saves a pasted service-account API key, and the API-key prompt accepts every API key type', async () => {
    prompts.select.mockResolvedValueOnce('api');
    prompts.password.mockResolvedValueOnce(' sk-ant-svc01-\nfixture ');
    await run();
    expect(child.exec).toHaveBeenCalledWith(
      'onecli',
      expect.arrayContaining(['create', '--type', 'anthropic', '--file']),
      expect.anything(),
    );
    expect(saved).toBe('sk-ant-svc01-fixture');
    expect(child.exec.mock.calls.flatMap(([, args]) => args)).not.toContain('sk-ant-svc01-fixture');
    expect(record()).toEqual({ claude: ['sec-new'] });
    const { message, validate } = prompts.password.mock.calls[0][0];
    expect(message).toMatch(/one workspace/);
    for (const key of ['sk-ant-api03-x', 'sk-ant-usr01-x', 'sk-ant-svc01-x']) expect(validate?.(key)).toBeUndefined();
    expect(validate?.('')).toBe('Required');
  });

  it('saves an OAuth token pasted into the API-key prompt the same way as the OAuth path', async () => {
    // OneCLI reads the auth mode from the value, so both paths make the same call.
    prompts.select.mockResolvedValueOnce('api');
    prompts.password.mockResolvedValueOnce(' sk-ant-oat01-\nfixture ');
    await run();
    expect(child.exec).toHaveBeenCalledWith(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'Anthropic',
        '--type',
        'anthropic',
        '--host-pattern',
        'api.anthropic.com',
        '--file',
        expect.any(String),
      ],
      expect.anything(),
    );
    expect(saved).toBe('sk-ant-oat01-fixture');
    expect(prompts.password.mock.calls[0][0].validate?.('sk-ant-oat01-x')).toBeUndefined();
  });

  it('rejects an API key in the OAuth-token prompt', async () => {
    prompts.select.mockResolvedValueOnce('oauth');
    prompts.password.mockResolvedValueOnce('sk-ant-oat01-fixture');
    await run();
    const { validate } = prompts.password.mock.calls[0][0];
    expect(validate?.('sk-ant-oat01-x')).toBeUndefined();
    expect(validate?.('sk-ant-svc01-x')).toMatch(/sk-ant-oat/);
  });
});
