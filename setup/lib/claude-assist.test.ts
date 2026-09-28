import { EventEmitter } from 'events';
import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ca = vi.hoisted(() => ({
  confirms: [] as boolean[],
  spawn: vi.fn(),
  stdin: '',
}));

// Claude counts as installed and signed in; no test ever runs a real CLI.
vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  spawn: ca.spawn,
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async () => ca.confirms.shift() ?? false),
    log: { ...actual.log, warn: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn() },
  };
});

vi.mock('./runner.js', () => ({ ensureAnswer: (v: unknown) => v }));
vi.mock('./theme.js', async (importActual) => ({
  ...(await importActual<typeof import('./theme.js')>()),
  note: vi.fn(),
}));

import { offerClaudeAssist } from './claude-assist.js';

beforeEach(() => {
  ca.confirms.length = 0;
  ca.stdin = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  ca.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { end: (prompt: string) => (ca.stdin = prompt) },
    });
    queueMicrotask(() => {
      const text = 'REASON: the gateway is down\nCOMMAND: pnpm exec tsx setup/index.ts --step gateway';
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'),
      );
      child.emit('close', 0);
    });
    return child;
  });
});

describe('non-interactive Claude assist', () => {
  it('diagnoses with read-only tools instead of bypassing permissions', async () => {
    // Accept the diagnosis, decline running the suggested command.
    ca.confirms.push(true, false);
    expect(await offerClaudeAssist({ stepName: 'gateway', msg: 'boom' }, '/tmp/nanoclaw')).toBe(false);

    const [binary, args] = ca.spawn.mock.calls[0] as [string, string[]];
    expect(binary).toBe('claude');
    // dontAsk turns every unapproved call into a denial: nobody is at the
    // terminal to answer a prompt while the spinner runs. Bash and MCP
    // servers are left out, so an operator's own allow rules (for example
    // Bash(pnpm *)) have nothing to apply to.
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--strict-mcp-config',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
    ]);
  });
});

it('the debug skill documents the supported gateway repair', () => {
  // actual fs: only child_process is mocked in this file.
  const skill = fs.readFileSync('.claude/skills/debug/SKILL.md', 'utf8');
  expect(skill).toContain('## Repairing the gateway');
  expect(skill).toContain('pnpm exec tsx setup/index.ts --step gateway');
});
