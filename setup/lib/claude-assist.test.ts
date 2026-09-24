import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `claude` is absent on this fake machine: every `command -v claude` and
// `claude auth status` throws. The confirm queue records the install offer.
const state = vi.hoisted(() => ({
  claudeInstalled: false,
  claudeSignedIn: false,
  confirmMessages: [] as string[],
  warnings: [] as string[],
}));

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn((command: string) => {
      if (command.startsWith('command -v claude') && state.claudeInstalled) return '';
      if (command.startsWith('claude auth status') && state.claudeSignedIn) return '';
      throw new Error(`not available: ${command}`);
    }),
    spawnSync: vi.fn(() => ({ status: 1 })),
  };
});

vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async (options: { message: string }) => {
      state.confirmMessages.push(options.message);
      return false;
    }),
    log: { ...actual.log, warn: vi.fn((message: string) => state.warnings.push(message)), error: vi.fn() },
  };
});

vi.mock('./runner.js', () => ({ ensureAnswer: (value: unknown) => value }));

import { ensureClaudeReady } from './claude-assist.js';
import { setPickedProvider } from './picked-provider.js';

const roots: string[] = [];
function projectRoot(env = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-assist-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.env'), env);
  return root;
}

beforeEach(() => {
  state.claudeInstalled = false;
  state.claudeSignedIn = false;
  state.confirmMessages.length = 0;
  state.warnings.length = 0;
});

afterEach(() => {
  setPickedProvider(undefined);
  delete process.env.NANOCLAW_AGENT_PROVIDER;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureClaudeReady on a non-claude install', () => {
  it('never offers to install the Claude CLI when the run serves another runtime', async () => {
    setPickedProvider('opencode');
    expect(await ensureClaudeReady(projectRoot())).toBe(false);
    expect(state.confirmMessages).toEqual([]);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain('opencode');
  });

  it('reads the preset and the stamped default, not only the run-scoped pick', async () => {
    process.env.NANOCLAW_AGENT_PROVIDER = 'codex';
    expect(await ensureClaudeReady(projectRoot())).toBe(false);
    delete process.env.NANOCLAW_AGENT_PROVIDER;
    expect(await ensureClaudeReady(projectRoot('DEFAULT_AGENT_PROVIDER=opencode\n'))).toBe(false);
    expect(state.confirmMessages).toEqual([]);
    expect(state.warnings).toHaveLength(2);
  });

  it('still says yes when Claude is already installed and signed in', async () => {
    setPickedProvider('opencode');
    state.claudeInstalled = true;
    state.claudeSignedIn = true;
    expect(await ensureClaudeReady(projectRoot())).toBe(true);
    expect(state.confirmMessages).toEqual([]);
    expect(state.warnings).toEqual([]);
  });

  it('keeps the install offer for a claude install', async () => {
    expect(await ensureClaudeReady(projectRoot('DEFAULT_AGENT_PROVIDER=claude\n'))).toBe(false);
    expect(state.confirmMessages).toEqual(['Claude CLI is needed to diagnose this. Install it now?']);
  });

  it('keeps the install offer when claude was picked this run over a stamped non-claude default', async () => {
    setPickedProvider('claude');
    expect(await ensureClaudeReady(projectRoot('DEFAULT_AGENT_PROVIDER=opencode\n'))).toBe(false);
    expect(state.confirmMessages).toEqual(['Claude CLI is needed to diagnose this. Install it now?']);
    expect(state.warnings).toEqual([]);
  });
});
