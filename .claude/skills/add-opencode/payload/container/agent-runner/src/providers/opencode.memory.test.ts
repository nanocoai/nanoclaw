import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OpenCodeProvider,
  buildOpenCodeConfig,
  runMemorySessionHook,
  type OpenCodeMemorySessionHook,
} from './opencode.js';
import { prepareOpenCodeMemory, openCodeInstructionsPath } from './opencode-memory.js';

// The same registered renderer used by other providers supplies a turn-start
// snapshot. Native OpenCode rereads its output file during that turn.

const MARKER = '<<memory-block>>';

let dir: string;
let scriptSeq = 0;

function logPath(): string {
  return path.join(dir, 'stdin.log');
}

/** Payloads the hook command received, one per invocation, in order. */
function invocations(): string[] {
  if (!fs.existsSync(logPath())) return [];
  return fs
    .readFileSync(logPath(), 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * A stand-in for `bun /app/src/memory/hook.ts`: appends its stdin to the log,
 * prints `body` on stdout, exits with `exitCode`.
 */
function fakeHook(opts: { body?: string; exitCode?: number } = {}): OpenCodeMemorySessionHook {
  const body = opts.body ?? MARKER;
  const script = path.join(dir, `hook-${scriptSeq++}.sh`);
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `cat >> "${logPath()}"`,
      `echo "" >> "${logPath()}"`,
      `cat <<'EOF'`,
      body,
      'EOF',
      `exit ${opts.exitCode ?? 0}`,
    ].join('\n') + '\n',
  );
  return { command: `sh ${script}`, legacyCommands: [], sources: ['startup', 'clear', 'compact'] };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-'));
  scriptSeq = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runMemorySessionHook', () => {
  it('feeds the hook the SessionStart lifecycle payload for the source it runs', () => {
    const hook = fakeHook();
    expect(runMemorySessionHook(hook, 'startup')).toBe(MARKER);
    expect(runMemorySessionHook(hook, 'compact')).toBe(MARKER);
    expect(invocations()).toEqual([
      '{"hook_event_name":"SessionStart","source":"startup"}',
      '{"hook_event_name":"SessionStart","source":"compact"}',
    ]);
  });

  it('injects the command output verbatim — truncation belongs to the shared renderer', () => {
    // Far past the shared renderer's 16k-per-file budget: whatever the command
    // decided to print is what gets injected, uncut, so the caps live in one
    // place instead of being re-implemented (and double-applied) here.
    const big = 'x'.repeat(40_000);
    const out = runMemorySessionHook(fakeHook({ body: big }), 'startup');
    expect(out).toBe(big);
    expect(out).toHaveLength(40_000);
  });

  it('distinguishes renderer failure from successfully empty output', () => {
    expect(runMemorySessionHook(fakeHook({ exitCode: 3 }), 'startup')).toBeUndefined();
    expect(runMemorySessionHook(fakeHook({ body: '' }), 'startup')).toBe('');
    expect(runMemorySessionHook(undefined, 'startup')).toBeUndefined();
    expect(
      runMemorySessionHook(
        { command: path.join(dir, 'does-not-exist.sh'), legacyCommands: [], sources: ['startup'] },
        'startup',
      ),
    ).toBeUndefined();
  });

  it('skips a source the registration does not declare', () => {
    const hook = { ...fakeHook(), sources: ['startup'] as const };
    expect(runMemorySessionHook(hook, 'compact')).toBeUndefined();
    expect(invocations()).toEqual([]);
  });
});

describe('rendered turn instructions', () => {
  it('writes rendered memory, core instructions and delivery wording into one private file', () => {
    const file = path.join(dir, 'turn.md');
    prepareOpenCodeMemory(fakeHook(), 'CORE', 'ROUTING', file);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${MARKER}\n\nCORE\n\nROUTING`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(invocations()).toEqual(['{"hook_event_name":"SessionStart","source":"startup"}']);
  });

  it('refreshes the same file on each external turn, including a resumed session', () => {
    const file = path.join(dir, 'turn.md');
    prepareOpenCodeMemory(fakeHook(), 'OLD', 'OLD ROUTING', file);
    prepareOpenCodeMemory(fakeHook({ body: 'FRESH' }), 'CURRENT', 'ROUTING', file);
    expect(fs.readFileSync(file, 'utf8')).toBe('FRESH\n\nCURRENT\n\nROUTING');
    expect(invocations()).toHaveLength(2);
  });

  it('keeps current instructions when rendering fails and does not resurrect stale memory', () => {
    const file = path.join(dir, 'turn.md');
    prepareOpenCodeMemory(fakeHook(), 'OLD', '', file);
    prepareOpenCodeMemory(fakeHook({ exitCode: 1 }), 'CURRENT', 'ROUTING', file);
    expect(fs.readFileSync(file, 'utf8')).toBe('CURRENT\n\nROUTING');
    prepareOpenCodeMemory(fakeHook({ body: '' }), 'NEW', '', file);
    expect(fs.readFileSync(file, 'utf8')).toBe('NEW');
  });
});

describe('OpenCodeProvider memory registration', () => {
  it('refuses to start a query when the shared hook was never registered', () => {
    expect(() => new OpenCodeProvider().query({ prompt: 'hi', cwd: '/workspace' })).toThrow(
      /memory session hook was not registered/i,
    );
  });

  it('does not run startup before the lazy query actually creates a session', () => {
    const provider = new OpenCodeProvider();
    provider.registerMemorySessionHook(fakeHook());
    provider.query({ prompt: 'hi', cwd: '/workspace' });
    provider.query({ prompt: 'hi again', cwd: '/workspace', continuation: 'ses_existing' });
    expect(invocations()).toEqual([]);
  });
});

describe('buildOpenCodeConfig instructions', () => {
  it('loads the rendered turn file, preserving the shared renderer caps on raw memory', () => {
    const config = buildOpenCodeConfig({});
    expect(config.instructions).toContain(openCodeInstructionsPath());
    expect(config).not.toHaveProperty('plugin');
    expect(config.instructions).not.toContain('/workspace/agent/memory/index.md');
    expect(config.instructions).not.toContain('/workspace/agent/memory/system/definition.md');
  });

  it('loads the composed group instructions from the agent directory', () => {
    const config = buildOpenCodeConfig({});
    expect(config.instructions).toContain('/workspace/agent/CLAUDE.md');
    expect(config.instructions).toContain('/workspace/agent/CLAUDE.local.md');
  });
});
