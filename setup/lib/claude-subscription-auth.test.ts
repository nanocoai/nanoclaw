import fs from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DriverCancelled, type SetupDriver } from './setup-driver.js';

const mockRunInteractiveProcess = vi.fn();

vi.mock('./interactive-process.js', () => ({
  machineChildEnvironment: () => ({ PATH: process.env.PATH }),
  runInteractiveProcess: (...args: unknown[]) => mockRunInteractiveProcess(...args),
}));
import { runClaudeSubscriptionMachineAuth } from './claude-subscription-auth.js';

const TOKEN = `sk-ant-oat${'A'.repeat(90)}AA`;
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=test-state';

function driver(): SetupDriver & {
  actions: unknown[];
  displays: unknown[];
  cleared: string[];
  progresses: Array<{ stepId: string; state: string; label?: string }>;
} {
  const actions: unknown[] = [];
  const displays: unknown[] = [];
  const cleared: string[] = [];
  const progresses: Array<{ stepId: string; state: string; label?: string }> = [];
  return {
    mode: 'ndjson',
    operation: 'setup',
    actions,
    displays,
    cleared,
    progresses,
    prompt: vi.fn().mockResolvedValue('authorization-code'),
    externalAction: vi.fn(async (action) => {
      actions.push(action);
      return 'attempted';
    }),
    display(value) {
      displays.push(value);
    },
    clearDisplay(id) {
      cleared.push(id);
    },
    progress(stepId, state, label) {
      progresses.push({ stepId, state, ...(label ? { label } : {}) });
    },
    log: vi.fn(),
    throwIfCancelled: vi.fn(),
  } as unknown as SetupDriver & {
    actions: unknown[];
    displays: unknown[];
    cleared: string[];
    progresses: Array<{ stepId: string; state: string; label?: string }>;
  };
}

describe('runClaudeSubscriptionMachineAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the provider URL, sends the code on stdin, and vaults through a private file', async () => {
    let isolatedEnv: Record<string, string> | undefined;
    const writes: string[] = [];
    mockRunInteractiveProcess.mockImplementation(async (...args: unknown[]) => {
      const command = args[1] as string;
      const childArgs = args[2] as string[];
      const options = args[3] as {
        env: Record<string, string>;
        timeoutMs: number;
        onOutput: (
          chunk: string,
          stream: 'stdout' | 'stderr',
          input: { write(value: string): void; end(): void },
        ) => Promise<void>;
      };
      if (command === 'onecli') {
        const filePath = childArgs[childArgs.indexOf('--file') + 1];
        expect(childArgs).not.toContain('--value');
        expect(fs.readFileSync(filePath, 'utf8')).toBe(TOKEN);
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        expect(options.timeoutMs).toBe(2 * 60 * 1000);
        return { reason: 'exited', exitCode: 0 };
      }
      isolatedEnv = options.env;
      const input = {
        write(value: string) {
          writes.push(value);
        },
        end: vi.fn(),
      };
      await options.onOutput(`Open this URL:\n${URL}\n`, 'stdout', input);
      await options.onOutput(`Your OAuth token:\n${TOKEN}\n`, 'stdout', input);
      return { reason: 'exited', exitCode: 0 };
    });

    const fake = driver();
    await expect(runClaudeSubscriptionMachineAuth(fake)).resolves.toEqual({ ok: true });

    expect(fake.actions).toEqual([]);
    expect(fake.displays).toEqual([expect.objectContaining({ kind: 'url', url: URL, sensitive: true })]);
    expect(fake.cleared).toEqual(['claude-subscription-url']);
    expect(writes).toEqual(['authorization-code\n']);
    expect(fake.progresses).toEqual([
      { stepId: 'claude-login', state: 'running', label: 'Waiting for Claude sign-in' },
      { stepId: 'claude-login', state: 'succeeded' },
      { stepId: 'auth', state: 'running', label: 'Saving your Claude credentials to your OneCLI vault' },
      { stepId: 'auth', state: 'succeeded' },
    ]);
    expect(mockRunInteractiveProcess.mock.calls.map((call) => call[1])).toEqual(['claude', 'onecli']);
    expect(isolatedEnv).toBeDefined();
    for (const location of Object.values(isolatedEnv!)) expect(fs.existsSync(location)).toBe(false);
  });

  it('fails closed when provider output has no allowlisted login URL', async () => {
    mockRunInteractiveProcess.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as {
        onOutput: (
          chunk: string,
          stream: 'stdout' | 'stderr',
          input: { write(value: string): void; end(): void },
        ) => Promise<void>;
      };
      await options.onOutput(`https://evil.example/oauth/authorize\n${TOKEN}\n`, 'stdout', {
        write: vi.fn(),
        end: vi.fn(),
      });
      return { reason: 'exited', exitCode: 0 };
    });

    const fake = driver();
    await expect(runClaudeSubscriptionMachineAuth(fake)).resolves.toEqual({
      ok: false,
      reason: 'login_url_missing',
    });
    expect(fake.progresses.at(-1)).toEqual({ stepId: 'claude-login', state: 'failed' });
    expect(mockRunInteractiveProcess).toHaveBeenCalledOnce();
  });

  it('waits for a complete URL line and ignores interleaved stderr', async () => {
    const fake = driver();
    mockRunInteractiveProcess.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'onecli') return { reason: 'exited', exitCode: 0 };
      const options = args[3] as {
        onOutput: (
          chunk: string,
          stream: 'stdout' | 'stderr',
          input: { write(value: string): void; end(): void },
        ) => Promise<void>;
      };
      const input = { write: vi.fn(), end: vi.fn() };
      await options.onOutput('https://claude.com/cai/oauth/authorize?code=true&sta', 'stdout', input);
      await options.onOutput('opening browser…\n', 'stderr', input);
      expect(fake.actions).toEqual([]);
      await options.onOutput(`te=split\n${TOKEN}\n`, 'stdout', input);
      return { reason: 'exited', exitCode: 0 };
    });

    await expect(runClaudeSubscriptionMachineAuth(fake)).resolves.toEqual({ ok: true });

    expect(fake.actions).toEqual([]);
    expect(fake.displays).toEqual([
      expect.objectContaining({
        url: 'https://claude.com/cai/oauth/authorize?code=true&state=split',
        sensitive: true,
      }),
    ]);
  });

  it('removes the isolated home when the driver cancels', async () => {
    let isolatedRoot = '';
    mockRunInteractiveProcess.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as { env: Record<string, string> };
      isolatedRoot = options.env.HOME.replace(/\/home$/, '');
      throw new DriverCancelled('test');
    });

    await expect(runClaudeSubscriptionMachineAuth(driver())).rejects.toBeInstanceOf(DriverCancelled);
    expect(fs.existsSync(isolatedRoot)).toBe(false);
  });

  it('removes both credential files when cancellation happens during vaulting', async () => {
    let isolatedRoot = '';
    let secretFile = '';
    mockRunInteractiveProcess.mockImplementation(async (...args: unknown[]) => {
      const command = args[1] as string;
      const childArgs = args[2] as string[];
      const options = args[3] as {
        env: Record<string, string>;
        onOutput?: (
          chunk: string,
          stream: 'stdout' | 'stderr',
          input: { write(value: string): void; end(): void },
        ) => Promise<void>;
      };
      if (command === 'onecli') {
        secretFile = childArgs[childArgs.indexOf('--file') + 1];
        throw new DriverCancelled('test');
      }
      isolatedRoot = options.env.HOME.replace(/\/home$/, '');
      await options.onOutput?.(`Open this URL:\n${URL}\n${TOKEN}\n`, 'stdout', {
        write: vi.fn(),
        end: vi.fn(),
      });
      return { reason: 'exited', exitCode: 0 };
    });

    await expect(runClaudeSubscriptionMachineAuth(driver())).rejects.toBeInstanceOf(DriverCancelled);

    expect(fs.existsSync(isolatedRoot)).toBe(false);
    expect(secretFile).not.toBe('');
    expect(fs.existsSync(secretFile)).toBe(false);
  });
});
