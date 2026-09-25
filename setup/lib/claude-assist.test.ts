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

import { ASSIST_GUARDRAILS, DESTRUCTIVE_COMMANDS, GATEWAY_REPAIR_COMMAND } from './assist-guardrails.js';
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
    expect(args).not.toContain('bypassPermissions');
    // dontAsk turns every unapproved call into a denial: nobody is at the
    // terminal to answer a prompt while the spinner runs.
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
    expect(args).toContain('Bash(docker ps *)');
    expect(args).not.toContain('Bash(docker inspect *)');
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    for (const command of DESTRUCTIVE_COMMANDS) expect(denied).toContain(`Bash(${command})`);
    expect(denied).toContain('Read(./.env)');
  });

  it('tells Claude the guardrails and the supported gateway repair', async () => {
    ca.confirms.push(true, false);
    await offerClaudeAssist({ stepName: 'gateway', msg: 'boom' }, '/tmp/nanoclaw');
    for (const line of ASSIST_GUARDRAILS) expect(ca.stdin).toContain(line);
  });
});

it('the debug skill documents the gateway repair the guardrails name', () => {
  // actual fs: only child_process is mocked in this file.
  const skill = fs.readFileSync('.claude/skills/debug/SKILL.md', 'utf8');
  expect(skill).toContain('## Repairing the gateway');
  expect(skill).toContain(GATEWAY_REPAIR_COMMAND);
});
