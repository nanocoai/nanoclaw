import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so runCodexLoginAuth never spawns a real codex CLI; the
// spawn stand-in plays `codex login` writing auth.json into whatever
// CODEX_HOME it was handed.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

// Drive both prompts in runCodexAuthStep — the keep/reconnect choice and the
// auth-method picker — without an interactive session.
const mockBrightSelect = vi.fn();
vi.mock('../lib/bright-select.js', () => ({
  brightSelect: (...args: unknown[]) => mockBrightSelect(...args),
}));

// Stub p.password for the API-key path; leave everything else (p.log,
// p.isCancel, p.confirm, p.cancel) real so the existing runCodexLoginAuth
// tests keep working unchanged.
const mockPassword = vi.fn();
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    password: (...args: unknown[]) => mockPassword(...args),
  };
});

import { buildCodexFailurePrompt, runCodexAuthStep, runCodexLoginAuth, verifyCodexInstall } from './codex.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const { ok, problems } = verifyCodexInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });
});

// Pure prompt builder for the failure-assist hook — no spawning involved.
describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const projectRoot = '/repo';
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      projectRoot,
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md'); // BIG_PICTURE_FILES
    expect(prompt).toContain('setup/verify.ts'); // STEP_FILES['verify']
    expect(prompt).toContain('logs/setup.log');
    expect(prompt).toContain('logs/setup-steps/verify.log'); // relativized rawLogPath
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

// Session-isolation invariant: the ChatGPT session vaulted for the gateway
// must never be the user's personal ~/.codex session — sharing one OAuth
// session across two consumers gets the whole family invalidated server-side
// when refresh tokens rotate (see the header of codex.ts).
describe('runCodexLoginAuth', () => {
  it('logs in under an isolated CODEX_HOME, vaults from it, and deletes it', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockExecFileSync.mockReturnValue('');

    let loginEnv: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      loginEnv = opts.env;
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCodexLoginAuth('browser');

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = loginEnv?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    const vaultCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'onecli');
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs[vaultArgs.indexOf('--file') + 1]).toBe(path.join(codexHome!, 'auth.json'));

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);
  });

  it('updates an existing vault secret when reconnecting', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockExecFileSync.mockReturnValue('');

    let loginEnv: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      loginEnv = opts.env;
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{"access":"fresh"}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCodexLoginAuth('browser', {
      id: 'secret-123',
      name: 'OpenAI',
      type: 'openai',
      hostPattern: 'chatgpt.com',
    });

    const vaultCall = mockExecFileSync.mock.calls.find((c) => {
      const args = c[1] as string[];
      return c[0] === 'onecli' && args[0] === 'secrets' && args[1] === 'update';
    });
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs).toContain('--id');
    expect(vaultArgs[vaultArgs.indexOf('--id') + 1]).toBe('secret-123');
    expect(vaultArgs[vaultArgs.indexOf('--value') + 1]).toBe('{"tokens":{"access":"fresh"}}');
    expect(fs.existsSync(loginEnv!.CODEX_HOME!)).toBe(false);
  });
});

// Recovery-flow coverage: when an OpenAI/Codex secret already exists in the
// vault, runCodexAuthStep must surface a keep/reconnect choice rather than
// short-circuit as success. Stale credentials would otherwise leave the only
// documented recovery path (re-run the auth step) unreachable.
describe('runCodexAuthStep', () => {
  // Stub `onecli secrets list` to return one matching OpenAI secret. Other
  // onecli calls (secrets create/update) return empty on success.
  function withExistingSecret(
    secret = { id: 'secret-123', name: 'OpenAI', type: 'openai', hostPattern: 'chatgpt.com' },
  ): void {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (cmd === 'onecli' && cmdArgs[0] === 'secrets' && cmdArgs[1] === 'list') {
        return JSON.stringify({ data: [secret] });
      }
      return '';
    });
  }

  it('offers keep/reconnect when a secret already exists and skips when user picks keep', async () => {
    withExistingSecret();
    mockBrightSelect.mockResolvedValueOnce('keep');

    await runCodexAuthStep();

    // The user saw the keep/reconnect prompt.
    expect(mockBrightSelect).toHaveBeenCalledTimes(1);
    const promptArgs = mockBrightSelect.mock.calls[0][0] as { message: string };
    expect(promptArgs.message).toContain('already exists in OneCLI');

    // No login spawned, no vault mutation.
    expect(mockSpawn).not.toHaveBeenCalled();
    const vaultWrite = mockExecFileSync.mock.calls.find((c) => {
      const cmdArgs = c[1] as string[];
      return c[0] === 'onecli' && cmdArgs[0] === 'secrets' && (cmdArgs[1] === 'create' || cmdArgs[1] === 'update');
    });
    expect(vaultWrite).toBeUndefined();
  });

  it('routes reconnect + browser through runCodexLoginAuth(existing) and writes secrets update --id', async () => {
    withExistingSecret();
    mockBrightSelect
      .mockResolvedValueOnce('reconnect') // keep/reconnect prompt
      .mockResolvedValueOnce('browser'); // method picker
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{"access":"fresh"}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCodexAuthStep();

    const vaultCall = mockExecFileSync.mock.calls.find((c) => {
      const cmdArgs = c[1] as string[];
      return c[0] === 'onecli' && cmdArgs[0] === 'secrets' && cmdArgs[1] === 'update';
    });
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs[vaultArgs.indexOf('--id') + 1]).toBe('secret-123');
    expect(vaultArgs[vaultArgs.indexOf('--value') + 1]).toBe('{"tokens":{"access":"fresh"}}');
  });

  it('routes reconnect + api through runCodexApiKeyAuth(existing) and writes secrets update --id with the new key', async () => {
    withExistingSecret();
    mockBrightSelect
      .mockResolvedValueOnce('reconnect')
      .mockResolvedValueOnce('api');
    mockPassword.mockResolvedValueOnce('sk-fresh-key');

    await runCodexAuthStep();

    const vaultCall = mockExecFileSync.mock.calls.find((c) => {
      const cmdArgs = c[1] as string[];
      return c[0] === 'onecli' && cmdArgs[0] === 'secrets' && cmdArgs[1] === 'update';
    });
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs[vaultArgs.indexOf('--id') + 1]).toBe('secret-123');
    expect(vaultArgs[vaultArgs.indexOf('--value') + 1]).toBe('sk-fresh-key');

    // The login flow never spawned a real codex CLI on the API-key path.
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
