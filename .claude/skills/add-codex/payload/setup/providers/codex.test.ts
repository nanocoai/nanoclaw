import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

// The API-key path reads the key through clack's masked prompt; everything
// else in the module keeps the real clack rendering.
const mockPassword = vi.fn();
const mockConfirm = vi.fn();
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  password: (...args: unknown[]) => mockPassword(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

import { ASSIST_GUARDRAILS } from '../lib/assist-guardrails.js';
import * as setupLog from '../logs.js';
import {
  buildCodexFailurePrompt,
  offerCodexFailureAssist,
  runCodexApiKeyAuth,
  runCodexInstallCheck,
  runCodexLoginAuth,
  storeFailureMessage,
  verifyCodexInstall,
} from './codex.js';

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-complete-check-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'src/providers/codex-agents-md.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.writeFileSync(path.join(root, 'container/cli-tools.json'), JSON.stringify([{ name: '@openai/codex' }]));
      expect(verifyCodexInstall(root)).toEqual({ ok: true, problems: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks setup when the payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-check-'));
    try {
      await expect(runCodexInstallCheck(root)).rejects.toThrow(/Codex provider is not fully installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe('offerCodexFailureAssist', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    mockConfirm.mockReset();
  });

  it('launches Codex read-only with approval on request, and states the guardrails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-assist-home-'));
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
      vi.stubEnv('HOME', home);
      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'codex-cli 0.155.1' });
      mockConfirm.mockResolvedValue(true);
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 0));
        return child;
      });

      expect(await offerCodexFailureAssist({ stepName: 'gateway', msg: 'boom' }, '/repo')).toBe('launched');

      const [binary, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(binary).toBe('codex');
      // Explicit flags override the operator's own config.toml defaults.
      // approvals_reviewer=user keeps escalations with the operator even when
      // their config.toml routes approvals to an automatic reviewer.
      expect(args.slice(0, 6)).toEqual([
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'on-request',
        '-c',
        'approvals_reviewer="user"',
      ]);
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      for (const line of ASSIST_GUARDRAILS) expect(args[6]).toContain(line);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
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

    const save = vi.fn(async (_provider, credential) => {
      expect(fs.existsSync(credential.file)).toBe(true);
    });
    await runCodexLoginAuth('browser', { has: async () => false, save });

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = loginEnv?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    expect(save).toHaveBeenCalledWith('codex', { kind: 'oauth', file: path.join(codexHome!, 'auth.json') });

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);
  });
});

// A gateway store failure carries the adapter's own message beside the bare
// `gateway_store_failed` code, on both save paths, so the operator and
// logs/setup.log see the cause.
describe('gateway store failures name their cause', () => {
  const failure = new Error('Provider codex does not declare its subscription endpoint');

  function stopOnExit(): { exit: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn> } {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('setup stopped');
    }) as typeof process.exit);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return { exit, log };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(setupLog.step).mockClear();
  });

  it('after a ChatGPT login, logs the adapter message and prints it under the friendly line', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const { exit, log } = stopOnExit();

    const save = vi.fn(async () => {
      throw failure;
    });
    await expect(runCodexLoginAuth('device', { has: async () => false, save })).rejects.toThrow('setup stopped');

    expect(exit).toHaveBeenCalledWith(1);
    expect(setupLog.step).toHaveBeenCalledWith(
      'auth',
      'failed',
      expect.any(Number),
      expect.objectContaining({
        PROVIDER: 'codex',
        METHOD: 'device',
        ERROR: 'gateway_store_failed',
        MESSAGE: failure.message,
      }),
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes(failure.message))).toBe(true);
  });

  it('after an API key paste, logs the adapter message and prints it under the friendly line', async () => {
    mockPassword.mockResolvedValue('sk-test-not-a-real-key');
    const { exit, log } = stopOnExit();

    const save = vi.fn(async () => {
      throw failure;
    });
    await expect(runCodexApiKeyAuth({ has: async () => false, save })).rejects.toThrow('setup stopped');

    expect(save).toHaveBeenCalledWith('codex', { kind: 'api-key', value: 'sk-test-not-a-real-key' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(setupLog.step).toHaveBeenCalledWith(
      'auth',
      'failed',
      0,
      expect.objectContaining({
        PROVIDER: 'codex',
        METHOD: 'api',
        ERROR: 'gateway_store_failed',
        MESSAGE: failure.message,
      }),
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes(failure.message))).toBe(true);
  });
});

describe('storeFailureMessage', () => {
  it('masks standard base64 tokens containing plus, slash and padding', () => {
    const token = 'Qm9vdHN0cmFwVG9r+ZW5WYWx1ZUhlcmUx/MjM0NTY3ODkw==';
    expect(storeFailureMessage(new Error(`Store rejected ${token}`))).toBe('Store rejected [redacted]');
  });

  it('keeps a plain adapter message intact', () => {
    expect(storeFailureMessage(new Error('Provider codex does not declare its subscription endpoint'))).toBe(
      'Provider codex does not declare its subscription endpoint',
    );
    expect(storeFailureMessage('not an Error')).toBe('not an Error');
  });

  it('withholds the excerpt a real JSON parse error quotes from auth.json', () => {
    let parse: unknown;
    try {
      JSON.parse('{"tokens":{"refresh_token":rt_FAKE_SECRET_VALUE}}');
    } catch (err) {
      parse = err;
    }
    const message = storeFailureMessage(parse);
    expect(message).toContain('SyntaxError');
    expect(message).not.toContain('rt_FAKE');
    expect(message).not.toContain('refresh_token');
    expect(message).not.toContain('sh_token');
  });

  it('masks token-shaped runs in any other message, and keeps one line', () => {
    const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const parse = new Error(`Unexpected token 's', ..."refresh_token":${token}}... is not valid JSON\nstack line`);
    const message = storeFailureMessage(parse);
    expect(message).not.toContain(token);
    expect(message).not.toContain('eyJhbGci');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('masks a token that straddles the length cut', () => {
    const key = `sk-proj-${'A'.repeat(64)}`;
    const message = storeFailureMessage(new Error(`${'x '.repeat(146)}${key}`));
    expect(message).not.toContain('sk-proj-AAAA');
    expect(message).not.toContain('AAAAAAAA');
    expect(message.length).toBeLessThanOrEqual(300);
  });
});
