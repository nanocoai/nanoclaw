import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  runInteractiveProcess: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mocks.execFileSync(...args),
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

vi.mock('../lib/interactive-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/interactive-process.js')>();
  return {
    ...actual,
    runInteractiveProcess: (...args: unknown[]) => mocks.runInteractiveProcess(...args),
  };
});

vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

import {
  buildCodexFailurePrompt,
  runCodexAuthStep,
  runCodexInstallCheck,
  runCodexLoginAuth,
  verifyCodexInstall,
} from './codex.js';
import { clearSensitiveValuesForTest, redactSensitiveValues } from '../lib/redaction.js';
import {
  DriverCancelled,
  type Artifact,
  type DriverDisplay,
  type DriverPrompt,
  type ExternalAction,
  type ExternalActionResult,
  type ProgressState,
  type Recovery,
  type SetupDriver,
  type SetupReceipt,
  type UninstallActionResult,
  type UninstallChoice,
  type UninstallGroup,
  type UninstallPlan,
  type UninstallReceipt,
} from '../lib/setup-driver.js';

type ProcessOptions = {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  onOutput?: (
    chunk: string,
    stream: 'stdout' | 'stderr',
    input: { write(value: string): void; end(): void },
  ) => void | Promise<void>;
};

const browserUrl = 'https://auth.openai.com/oauth/authorize?client_id=test&state=browser-state';
const deviceUrl = 'https://auth.openai.com/codex/device';
const deviceCode = 'ABCD-EFGH';
const authToken = 'test-access-token';

let authFile: 'valid' | 'missing' | 'public' = 'valid';
let codexOutput: string[] = [];
let codexResult: { reason: 'exited'; exitCode: number } = { reason: 'exited', exitCode: 0 };
let codexStatusResult: { reason: 'exited'; exitCode: number } = { reason: 'exited', exitCode: 0 };
let vaultedFileMode: number | undefined;
let vaultedFileContents: string | undefined;
let vaultedEnvironment: Record<string, string | undefined> | undefined;

function writeAuthFile(codexHome: string): void {
  if (authFile === 'missing') return;
  fs.mkdirSync(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: authToken } }), { mode: 0o600 });
  fs.chmodSync(authPath, authFile === 'public' ? 0o644 : 0o600);
}

function createCodexInstallTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-install-check-'));
  for (const file of [
    'src/providers/codex.ts',
    'src/providers/codex-agents-md.ts',
    'container/agent-runner/src/providers/codex.ts',
    'container/agent-runner/src/providers/codex-app-server.ts',
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  for (const barrel of ['src/providers/index.ts', 'container/agent-runner/src/providers/index.ts']) {
    fs.writeFileSync(path.join(root, barrel), "import './codex.js';\n");
  }
  fs.writeFileSync(
    path.join(root, 'container', 'cli-tools.json'),
    JSON.stringify([{ name: '@openai/codex', version: '0.138.0' }]),
  );
  return root;
}

class FakeDriver implements SetupDriver {
  readonly operation = 'setup' as const;
  readonly cancellationSignal: AbortSignal;
  readonly prompts: DriverPrompt[] = [];
  readonly displays: DriverDisplay[] = [];
  readonly cleared: string[] = [];
  readonly actions: ExternalAction[] = [];
  readonly progressEvents: Array<{ stepId: string; state: ProgressState; label?: string }> = [];
  readonly logs: Array<{ level: string; message: string }> = [];
  actionResult: ExternalActionResult = 'attempted';
  private readonly abortController = new AbortController();

  constructor(
    readonly mode: 'terminal' | 'ndjson',
    private readonly answers: Array<boolean | string> = [],
  ) {
    this.cancellationSignal = this.abortController.signal;
  }

  cancel(reason = 'test cancellation'): void {
    this.abortController.abort(reason);
  }

  async prompt(spec: DriverPrompt): Promise<boolean | string> {
    this.prompts.push(spec);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`No answer for ${spec.id}`);
    return answer;
  }

  progress(stepId: string, state: ProgressState, label?: string): void {
    this.progressEvents.push({ stepId, state, ...(label ? { label } : {}) });
  }

  display(display: DriverDisplay): void {
    this.displays.push(display);
  }

  clearDisplay(displayId: string): void {
    this.cleared.push(displayId);
  }

  note(): void {}

  log(level: 'info' | 'success' | 'warn' | 'error' | 'step' | 'message', message: string): void {
    this.logs.push({ level, message });
  }

  intro(): void {}
  outro(): void {}

  async externalAction(
    action: ExternalAction,
    verify: () => boolean | Promise<boolean>,
  ): Promise<ExternalActionResult> {
    this.actions.push(action);
    if (this.actionResult === 'attempted' && !(await verify())) throw new Error('postcondition failed');
    return this.actionResult;
  }

  async waitForUninstall(
    _plan: UninstallPlan,
    _validate: (choices: Map<UninstallGroup, UninstallChoice>) => string | undefined,
  ): Promise<Map<UninstallGroup, UninstallChoice>> {
    return new Map();
  }

  uninstallAction(_result: UninstallActionResult): void {}

  throwIfCancelled(): void {
    if (this.cancellationSignal.aborted) throw new DriverCancelled(String(this.cancellationSignal.reason));
  }

  error(code: string, _message: string, _recovery: Recovery[] = [], _stepId?: string): never {
    throw new Error(`driver error: ${code}`);
  }

  completeSetup(_receipt: SetupReceipt): void {}
  completeUninstall(_receipt: UninstallReceipt): void {}
  cancelled(_details?: { lastStepId?: string; results?: UninstallActionResult[]; remaining?: Artifact[] }): void {}
  handoff(): void {}
  close(): void {}
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSensitiveValuesForTest();
  authFile = 'valid';
  codexOutput = [
    `Starting local login server on http://localhost:1455\nIf your browser did not open, navigate to this URL to authenticate:\n${browserUrl}\n`,
  ];
  codexResult = { reason: 'exited', exitCode: 0 };
  codexStatusResult = { reason: 'exited', exitCode: 0 };
  vaultedFileMode = undefined;
  vaultedFileContents = undefined;
  vaultedEnvironment = undefined;
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  mocks.execFileSync.mockImplementation((command: unknown, args: unknown) => {
    if (command === 'onecli' && Array.isArray(args) && args[0] === 'secrets' && args[1] === 'list') {
      return JSON.stringify({ data: [] });
    }
    return '';
  });
  mocks.runInteractiveProcess.mockImplementation(
    async (_driver: SetupDriver, command: string, args: string[], options: ProcessOptions = {}) => {
      if (command === 'onecli' && args[0] === 'secrets' && args[1] === 'list') {
        await options.onOutput?.('{"data":[]}\n', 'stdout', { write() {}, end() {} });
        return { reason: 'exited' as const, exitCode: 0 };
      }
      if (command === 'codex') {
        if (args[0] === 'login' && args[1] === 'status') return codexStatusResult;
        const codexHome = options.env?.CODEX_HOME;
        if (!codexHome) throw new Error('missing CODEX_HOME');
        for (const chunk of codexOutput) {
          await options.onOutput?.(chunk, 'stdout', { write() {}, end() {} });
        }
        writeAuthFile(codexHome);
        return codexResult;
      }
      const fileIndex = args.indexOf('--file');
      if (fileIndex >= 0) {
        const filePath = args[fileIndex + 1];
        vaultedFileMode = fs.statSync(filePath).mode & 0o777;
        vaultedFileContents = fs.readFileSync(filePath, 'utf8');
        vaultedEnvironment = options.env;
      }
      return { reason: 'exited' as const, exitCode: 0 };
    },
  );
});

describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const { ok, problems } = verifyCodexInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe('runCodexInstallCheck', () => {
  it('emits only semantic progress for NDJSON success', async () => {
    const root = createCodexInstallTree();
    const previousCwd = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const driver = new FakeDriver('ndjson');
    try {
      process.chdir(root);
      await runCodexInstallCheck(driver);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
      stdout.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(driver.progressEvents).toEqual([
      { stepId: 'codex-install', state: 'running', label: 'Checking the Codex provider install' },
      { stepId: 'codex-install', state: 'succeeded' },
    ]);
    expect(driver.logs).toEqual([]);
  });

  it('warns and continues in NDJSON when the Codex payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-install-check-'));
    const previousCwd = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const driver = new FakeDriver('ndjson');
    try {
      process.chdir(root);
      await runCodexInstallCheck(driver);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
      stdout.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(driver.progressEvents).toEqual([
      { stepId: 'codex-install', state: 'running', label: 'Checking the Codex provider install' },
      { stepId: 'codex-install', state: 'failed' },
    ]);
    expect(driver.logs).toHaveLength(1);
    expect(driver.logs[0]).toMatchObject({ level: 'warn' });
    expect(driver.logs[0]?.message).toContain('The Codex provider is not fully installed');
    expect(driver.logs[0]?.message).toContain('Setup will continue');
  });
});

describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      '/repo',
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md');
    expect(prompt).toContain('setup/verify.ts');
    expect(prompt).toContain('logs/setup-steps/verify.log');
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

describe('structured Codex authentication', () => {
  it('checks existing vault metadata with a minimal machine environment and skips when connected', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-leak';
    try {
      mocks.runInteractiveProcess.mockImplementation(
        async (_driver: SetupDriver, command: string, args: string[], options: ProcessOptions = {}) => {
          expect(command).toBe('onecli');
          expect(args).toEqual(['secrets', 'list']);
          expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
          await options.onOutput?.(
            JSON.stringify({ data: [{ id: 'secret-1', name: 'Codex', type: 'openai', hostPattern: 'chatgpt.com' }] }),
            'stdout',
            { write() {}, end() {} },
          );
          return { reason: 'exited' as const, exitCode: 0 };
        },
      );
      const driver = new FakeDriver('ndjson');

      await runCodexAuthStep(driver);

      expect(driver.prompts).toHaveLength(0);
      expect(driver.logs.at(-1)?.message).toContain('already connected');
      expect(mocks.runInteractiveProcess).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('preserves terminal choice order and copy', async () => {
    const driver = new FakeDriver('terminal', ['skip', true]);

    await runCodexAuthStep(driver);

    expect(driver.prompts[0]).toMatchObject({
      id: 'codex-auth-method',
      kind: 'singleChoice',
      message: 'How would you like to connect Codex?',
      choices: [
        { id: 'browser', label: 'Sign in with my ChatGPT subscription' },
        { id: 'device', label: 'ChatGPT device pairing' },
        { id: 'api', label: 'Paste an OpenAI API key' },
        { id: 'skip', label: "Skip — I'll connect later" },
      ],
    });
  });

  it('keeps terminal login on the inherited-stdio process path', async () => {
    const driver = new FakeDriver('terminal');
    let loginRoot = '';
    mocks.runInteractiveProcess.mockImplementationOnce(
      async (receivedDriver: SetupDriver, command: string, args: string[], options: ProcessOptions) => {
        expect(receivedDriver).toBe(driver);
        expect(command).toBe('codex');
        expect(args).toEqual(['login']);
        expect(options.onOutput).toBeUndefined();
        loginRoot = options.env?.CODEX_HOME ?? '';
        writeAuthFile(loginRoot);
        return { reason: 'exited' as const, exitCode: 0 };
      },
    );

    await runCodexLoginAuth(driver, 'browser');

    expect(mocks.spawnSync).toHaveBeenCalledWith('codex', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(loginRoot).not.toBe(path.join(os.homedir(), '.codex'));
    expect(fs.existsSync(loginRoot)).toBe(false);
  });

  it('explains a failed terminal status check before exiting', async () => {
    mocks.spawnSync.mockImplementation((_command: unknown, args: unknown) => ({
      status: Array.isArray(args) && args[0] === 'login' && args[1] === 'status' ? 1 : 0,
      stdout: '',
      stderr: '',
    }));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit 1');
    }) as never);
    const driver = new FakeDriver('terminal');

    try {
      await expect(runCodexLoginAuth(driver, 'browser')).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
    }

    expect(driver.logs.at(-1)).toMatchObject({
      level: 'error',
      message: expect.stringContaining('did not confirm that the isolated session is authenticated'),
    });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('surfaces the browser URL and vaults only a verified isolated auth file', async () => {
    const driver = new FakeDriver('ndjson');

    await runCodexLoginAuth(driver, 'browser');

    expect(driver.displays).toContainEqual({
      id: 'codex-auth-url',
      kind: 'url',
      url: browserUrl,
      label: 'Codex sign-in',
      sensitive: true,
    });
    expect(driver.actions).toEqual([]);
    expect(driver.progressEvents.map(({ state }) => state)).toEqual(['running', 'succeeded']);
    expect(redactSensitiveValues(browserUrl)).toBe('[REDACTED]');
    expect(redactSensitiveValues(authToken)).toBe('[REDACTED]');

    const loginCall = mocks.runInteractiveProcess.mock.calls.find((call) => call[1] === 'codex');
    const loginOptions = loginCall?.[3] as ProcessOptions;
    const loginEnv = loginOptions.env;
    expect(loginEnv?.HOME).not.toBe(os.homedir());
    expect(loginEnv?.CODEX_HOME).not.toBe(path.join(os.homedir(), '.codex'));
    expect(loginEnv?.XDG_CONFIG_HOME).toContain('codex-vault-login-');
    expect(loginEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(loginOptions.timeoutMs).toBe(15 * 60 * 1000);
    const statusCall = mocks.runInteractiveProcess.mock.calls.find(
      (call) => call[1] === 'codex' && (call[2] as string[]).join(' ') === 'login status',
    );
    expect(statusCall?.[3]).toMatchObject({ env: loginEnv, timeoutMs: 30 * 1000 });

    const vaultCall = mocks.runInteractiveProcess.mock.calls.find((call) => call[1] === 'onecli');
    const vaultArgs = vaultCall?.[2] as string[];
    expect(vaultArgs).toEqual([
      'secrets',
      'create',
      '--name',
      'Codex',
      '--type',
      'openai',
      '--file',
      expect.any(String),
      '--host-pattern',
      'chatgpt.com',
    ]);
    expect(vaultArgs.join(' ')).not.toContain(authToken);
    expect(vaultedFileMode).toBe(0o600);
    expect(fs.existsSync(loginEnv?.CODEX_HOME ?? '')).toBe(false);
  });

  it('surfaces a bounded device URL and pairing code after split output', async () => {
    codexOutput = [
      'Open this link in your browser:\nhttps://auth.openai.com/codex/',
      `device\nEnter this one-time code:\n${deviceCode}\n`,
    ];
    const driver = new FakeDriver('ndjson');

    await runCodexLoginAuth(driver, 'device');

    const loginCall = mocks.runInteractiveProcess.mock.calls.find((call) => call[1] === 'codex');
    expect(loginCall?.[2]).toEqual(['login', '--device-auth']);
    expect(driver.displays).toEqual(
      expect.arrayContaining([
        { id: 'codex-auth-url', kind: 'url', url: deviceUrl, label: 'Codex sign-in', sensitive: true },
        { id: 'codex-device-code', kind: 'code', content: deviceCode, label: 'Codex pairing code', sensitive: true },
      ]),
    );
    expect(redactSensitiveValues(deviceCode)).toBe('[REDACTED]');
  });

  it('passes an API key through a private temporary file in machine mode', async () => {
    const secret = 'sk-test-machine-secret';
    const driver = new FakeDriver('ndjson', ['api', secret]);

    await runCodexAuthStep(driver);

    const vaultCall = mocks.runInteractiveProcess.mock.calls.find(
      (call) => call[1] === 'onecli' && (call[2] as string[]).includes('--file'),
    );
    const vaultArgs = vaultCall?.[2] as string[];
    const secretFile = vaultArgs[vaultArgs.indexOf('--file') + 1];
    expect(vaultArgs).not.toContain('--value');
    expect(vaultArgs.join(' ')).not.toContain(secret);
    expect(Object.values(vaultedEnvironment ?? {})).not.toContain(secret);
    expect(vaultedFileContents).toBe(secret);
    expect(vaultedFileMode).toBe(0o600);
    expect(fs.existsSync(secretFile)).toBe(false);
    expect(redactSensitiveValues(secret)).toBe('[REDACTED]');
    expect(driver.progressEvents.map(({ state }) => state)).toEqual(['running', 'succeeded']);
  });

  it('keeps the terminal API-key vault command off argv too', async () => {
    const secret = 'sk-test-terminal-secret';
    const driver = new FakeDriver('terminal', ['api', secret]);

    await runCodexAuthStep(driver);

    const vaultCall = mocks.execFileSync.mock.calls.find(
      (call) => call[0] === 'onecli' && Array.isArray(call[1]) && call[1][1] === 'create',
    );
    const vaultArgs = vaultCall?.[1] as string[];
    expect(vaultArgs.slice(0, 6)).toEqual(['secrets', 'create', '--name', 'Codex', '--type', 'openai']);
    expect(vaultArgs.slice(-2)).toEqual(['--host-pattern', 'api.openai.com']);
    expect(vaultArgs).toContain('--file');
    expect(vaultArgs).not.toContain('--value');
    expect(vaultArgs.join(' ')).not.toContain(secret);
    expect(fs.existsSync(vaultArgs[vaultArgs.indexOf('--file') + 1])).toBe(false);
    expect(mocks.runInteractiveProcess).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []],
    ['malformed', ['Visit https://example.com/not-codex and enter SOMETHING']],
    ['ambiguous', [`${browserUrl}\nhttps://auth.openai.com/oauth/authorize?state=other\n`]],
  ])('fails closed on %s provider output', async (_name, output) => {
    codexOutput = output;
    const driver = new FakeDriver('ndjson');

    await expect(runCodexLoginAuth(driver, 'browser')).rejects.toThrow('codex_login_failed');

    expect(mocks.runInteractiveProcess.mock.calls.some((call) => call[1] === 'onecli')).toBe(false);
  });

  it('waits for a complete browser URL line and ignores interleaved stderr', async () => {
    const driver = new FakeDriver('ndjson');
    mocks.runInteractiveProcess.mockImplementation(
      async (_driver: SetupDriver, command: string, args: string[], options: ProcessOptions = {}) => {
        if (command === 'onecli' && args[1] === 'list') {
          await options.onOutput?.('{"data":[]}\n', 'stdout', { write() {}, end() {} });
          return { reason: 'exited' as const, exitCode: 0 };
        }
        if (command === 'codex') {
          if (args[0] === 'login' && args[1] === 'status') return codexStatusResult;
          await options.onOutput?.('https://auth.openai.com/oauth/authorize?clie', 'stdout', { write() {}, end() {} });
          await options.onOutput?.('opening browser…\n', 'stderr', { write() {}, end() {} });
          expect(driver.actions).toEqual([]);
          await options.onOutput?.('nt_id=test&state=split\n', 'stdout', { write() {}, end() {} });
          writeAuthFile(options.env?.CODEX_HOME ?? '');
          return { reason: 'exited' as const, exitCode: 0 };
        }
        return { reason: 'exited' as const, exitCode: 0 };
      },
    );

    await runCodexLoginAuth(driver, 'browser');

    expect(driver.actions).toEqual([]);
    expect(driver.displays).toContainEqual(
      expect.objectContaining({
        url: 'https://auth.openai.com/oauth/authorize?client_id=test&state=split',
        sensitive: true,
      }),
    );
  });

  it('keeps the sensitive browser URL only in the display channel', async () => {
    const driver = new FakeDriver('ndjson');

    await runCodexLoginAuth(driver, 'browser');

    expect(driver.displays).toContainEqual(expect.objectContaining({ kind: 'url', sensitive: true }));
    expect(driver.actions).toEqual([]);
    expect(driver.progressEvents.at(-1)?.state).toBe('succeeded');
  });

  it('fails without vaulting when Codex does not confirm the isolated session', async () => {
    const driver = new FakeDriver('ndjson');
    codexStatusResult = { reason: 'exited', exitCode: 1 };

    await expect(runCodexLoginAuth(driver, 'browser')).rejects.toThrow('codex_login_status_failed');

    expect(
      mocks.runInteractiveProcess.mock.calls.some(
        (call) => call[1] === 'onecli' && (call[2] as string[]).includes('--file'),
      ),
    ).toBe(false);
  });

  it('propagates child failure and removes the isolated login tree', async () => {
    codexOutput = [];
    codexResult = { reason: 'exited', exitCode: 7 };
    let loginRoot = '';
    mocks.runInteractiveProcess.mockImplementation(
      async (_driver: SetupDriver, command: string, args: string[], options: ProcessOptions) => {
        if (command === 'onecli' && args[1] === 'list') {
          await options.onOutput?.('{"data":[]}\n', 'stdout', { write() {}, end() {} });
          return { reason: 'exited' as const, exitCode: 0 };
        }
        const codexHome = options.env?.CODEX_HOME ?? '';
        loginRoot = path.dirname(codexHome);
        return codexResult;
      },
    );
    const driver = new FakeDriver('ndjson');

    await expect(runCodexLoginAuth(driver, 'browser')).rejects.toThrow('codex_login_failed');

    expect(fs.existsSync(loginRoot)).toBe(false);
  });

  it('propagates cancellation and removes the isolated login tree', async () => {
    let loginRoot = '';
    const driver = new FakeDriver('ndjson');
    mocks.runInteractiveProcess.mockImplementation(
      async (_driver: SetupDriver, command: string, args: string[], options: ProcessOptions) => {
        if (command === 'onecli' && args[1] === 'list') {
          await options.onOutput?.('{"data":[]}\n', 'stdout', { write() {}, end() {} });
          return { reason: 'exited' as const, exitCode: 0 };
        }
        loginRoot = path.dirname(options.env?.CODEX_HOME ?? '');
        driver.cancel();
        throw new DriverCancelled('test cancellation');
      },
    );

    await expect(runCodexLoginAuth(driver, 'browser')).rejects.toBeInstanceOf(DriverCancelled);

    expect(fs.existsSync(loginRoot)).toBe(false);
    expect(mocks.runInteractiveProcess.mock.calls.some((call) => call[1] === 'onecli')).toBe(false);
  });

  it('propagates cancellation during vaulting and removes the isolated login tree', async () => {
    let loginRoot = '';
    const driver = new FakeDriver('ndjson');
    mocks.runInteractiveProcess.mockImplementation(
      async (_driver: SetupDriver, command: string, args: string[], options: ProcessOptions = {}) => {
        if (command === 'onecli' && args[1] === 'list') {
          await options.onOutput?.('{"data":[]}\n', 'stdout', { write() {}, end() {} });
          return { reason: 'exited' as const, exitCode: 0 };
        }
        if (command === 'codex') {
          loginRoot = path.dirname(options.env?.CODEX_HOME ?? '');
          for (const chunk of codexOutput) {
            await options.onOutput?.(chunk, 'stdout', { write() {}, end() {} });
          }
          writeAuthFile(options.env?.CODEX_HOME ?? '');
          return { reason: 'exited' as const, exitCode: 0 };
        }
        driver.cancel();
        throw new DriverCancelled('test cancellation');
      },
    );

    await expect(runCodexLoginAuth(driver, 'browser')).rejects.toBeInstanceOf(DriverCancelled);

    expect(fs.existsSync(loginRoot)).toBe(false);
    expect(driver.progressEvents.some(({ state }) => state === 'succeeded')).toBe(false);
  });

  it.each([
    ['missing', 'missing' as const],
    ['non-private', 'public' as const],
  ])('rejects a %s auth.json before vaulting it', async (_name, fileState) => {
    authFile = fileState;
    const driver = new FakeDriver('ndjson');

    await expect(runCodexLoginAuth(driver, 'browser')).rejects.toThrow('codex_auth_file_invalid');

    expect(mocks.runInteractiveProcess.mock.calls.some((call) => call[1] === 'onecli')).toBe(false);
  });

  it('runs the browser subscription journey through the real NDJSON driver', async () => {
    const { spawn: spawnChild } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-driver-'));
    try {
      const bin = path.join(root, 'bin');
      const marker = path.join(root, 'vaulted');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'codex'),
        `#!/usr/bin/env bash
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  test -s "$CODEX_HOME/auth.json"
  exit $?
fi
printf 'private codex noise\\n%s\\n' '${browserUrl}'
mkdir -p "$CODEX_HOME"
printf '%s' '{"tokens":{"access_token":"synthetic-access-token"}}' > "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(bin, 'onecli'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'secrets' && args[1] === 'list') {
  process.stdout.write('{"data":[]}\\n');
  process.exit(0);
}
const index = args.indexOf('--file');
if (index < 0 || args.includes('--value')) process.exit(7);
const file = args[index + 1];
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
if (parsed.tokens?.access_token !== 'synthetic-access-token') process.exit(8);
if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(9);
fs.writeFileSync(${JSON.stringify(marker)}, 'ok');
`,
        { mode: 0o755 },
      );

      const fixture = path.join(root, 'fixture.mts');
      const codexModule = pathToFileURL(path.resolve('setup/providers/codex.ts')).href;
      const driverModule = pathToFileURL(path.resolve('setup/lib/setup-driver.ts')).href;
      const receiptModule = pathToFileURL(path.resolve('setup/lib/fixtures/setup-receipt.ts')).href;
      fs.writeFileSync(
        fixture,
        `
import { runCodexAuthStep } from ${JSON.stringify(codexModule)};
import { DriverTerminalError, NdjsonSetupDriver } from ${JSON.stringify(driverModule)};
import { fixtureSetupReceipt } from ${JSON.stringify(receiptModule)};
const driver = new NdjsonSetupDriver('setup');
try {
  await runCodexAuthStep(driver);
  driver.completeSetup(fixtureSetupReceipt());
} catch (error) {
  if (!(error instanceof DriverTerminalError)) throw error;
  process.exitCode = error.exitCode;
}
`,
      );
      const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
      const child = spawnChild(process.execPath, [tsx, fixture], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const events: Array<Record<string, unknown>> = [];
      let stdout = '';
      let stderr = '';
      let buffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        buffer += text;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as Record<string, unknown>;
          events.push(event);
          if (event.type === 'prompt') {
            const prompt = event.prompt as { id: string };
            child.stdin.write(
              `${JSON.stringify({
                protocol: 'nanoclaw.driver.v1',
                operation: 'setup',
                type: 'answer',
                promptId: prompt.id,
                value: 'browser',
              })}\n`,
            );
          }
          if (event.type === 'externalAction') {
            const action = event.action as { id: string };
            child.stdin.write(
              `${JSON.stringify({
                protocol: 'nanoclaw.driver.v1',
                operation: 'setup',
                type: 'externalActionCompleted',
                actionId: action.id,
                result: 'attempted',
              })}\n`,
            );
          }
        }
      });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });

      expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
      expect(events[0]?.type).toBe('hello');
      expect(events.at(-1)?.type).toBe('complete');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'display',
          display: expect.objectContaining({ kind: 'url', url: browserUrl, sensitive: true }),
        }),
      );
      expect(events.some((event) => event.type === 'externalAction')).toBe(false);
      expect(events.filter((event) => event.type === 'progress').map((event) => event.state)).toEqual([
        'running',
        'succeeded',
      ]);
      expect(stdout).not.toContain('synthetic-access-token');
      expect(stdout).not.toContain('private codex noise');
      expect(stderr).not.toContain('synthetic-access-token');
      expect(fs.readFileSync(marker, 'utf8')).toBe('ok');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
