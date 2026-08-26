import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OpenCodeProvider,
  buildOpenCodeConfig,
  createCompactionReminder,
  createMemoryLifecycle,
  runMemorySessionHook,
  type OpenCodeMemorySessionHook,
} from './opencode.js';

/**
 * Memory reaches the OpenCode agent through the shared memory session hook —
 * the same command the Claude and Codex providers register — run at the two
 * moments OpenCode rebuilds a context window: a new session, and the first
 * prompt after an auto-compaction. Never on a resume, never on an ordinary
 * push, and never through the config `instructions` array (OpenCode rereads
 * those files raw on every model request, bypassing the shared renderer's
 * per-file caps and the whole lifecycle).
 *
 * Hermetic: the "hook" is a temp shell script that logs the stdin payload it
 * received and echoes a marker, so these exercise the real spawn/stdin path
 * without any of `src/memory/*` (absent on this providers branch).
 */

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

  it('fails closed on a non-zero exit, an unknown command, empty output, and no registration', () => {
    expect(runMemorySessionHook(fakeHook({ exitCode: 3 }), 'startup')).toBeUndefined();
    expect(runMemorySessionHook(fakeHook({ body: '' }), 'startup')).toBeUndefined();
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

describe('createMemoryLifecycle new context', () => {
  it('prepends one memory block to the opening prompt instructions', () => {
    const lifecycle = createMemoryLifecycle(fakeHook(), false);
    const instructions = lifecycle.openingInstructions('BASE INSTRUCTIONS');

    expect(instructions?.split(MARKER)).toHaveLength(2); // exactly one occurrence
    expect(instructions).toContain('BASE INSTRUCTIONS');
    expect(instructions?.indexOf(MARKER)).toBeLessThan(instructions!.indexOf('BASE INSTRUCTIONS'));
    expect(invocations()).toHaveLength(1);
  });

  it('carries memory even when the turn has no system instructions', () => {
    expect(createMemoryLifecycle(fakeHook(), false).openingInstructions(undefined)).toBe(MARKER);
  });

  it('does NOT re-inject on ordinary pushes after the opening prompt', () => {
    const lifecycle = createMemoryLifecycle(fakeHook(), false);
    lifecycle.openingInstructions('BASE');

    expect(lifecycle.pushPrefix(false)).toBe('');
    expect(lifecycle.pushPrefix(false)).toBe('');
    expect(invocations()).toHaveLength(1); // the opening prompt only
  });

  it('never runs the hook when the query resumes an existing session', () => {
    const lifecycle = createMemoryLifecycle(fakeHook(), true);

    expect(lifecycle.openingInstructions('BASE')).toBe('BASE');
    expect(lifecycle.pushPrefix(false)).toBe('');
    expect(invocations()).toEqual([]);
  });

  it('leaves the instructions untouched when the hook fails', () => {
    const lifecycle = createMemoryLifecycle(fakeHook({ exitCode: 1 }), false);
    expect(() => lifecycle.openingInstructions('BASE')).not.toThrow();
    expect(lifecycle.openingInstructions('BASE')).toBe('BASE');
  });
});

describe('createMemoryLifecycle after compaction', () => {
  it('injects memory once on the first push after a compaction', () => {
    const lifecycle = createMemoryLifecycle(fakeHook(), false);

    expect(lifecycle.pushPrefix(true)).toBe(`${MARKER}\n\n`);
    expect(invocations()).toEqual(['{"hook_event_name":"SessionStart","source":"compact"}']);
  });

  it('rides the compaction latch: memory, then the routing reminder, then the user text', () => {
    // Mirrors what OpenCodeProvider.push() composes, latch included.
    const lifecycle = createMemoryLifecycle(fakeHook(), false);
    const compaction = createCompactionReminder(() => '<<reminder>>');
    const compose = (message: string): string => {
      const justCompacted = compaction.isArmed;
      return lifecycle.pushPrefix(justCompacted) + compaction.apply(message);
    };

    compaction.note('ses_active', 'ses_active'); // session.compacted for this turn's session
    const first = compose('next user message');
    expect(first).toBe(`${MARKER}\n\n<<reminder>>\n\nnext user message`);

    // The push after that is clean — no memory, no reminder.
    const second = compose('another message');
    expect(second).toBe('another message');
    expect(invocations()).toHaveLength(1);
  });

  it('falls back to no injection when the compaction-time hook fails', () => {
    const lifecycle = createMemoryLifecycle(fakeHook({ exitCode: 1 }), false);
    expect(lifecycle.pushPrefix(true)).toBe('');
  });
});

describe('OpenCodeProvider memory registration', () => {
  it('refuses to start a query when the shared hook was never registered', () => {
    expect(() => new OpenCodeProvider().query({ prompt: 'hi', cwd: '/workspace' })).toThrow(
      /memory session hook was not registered/i,
    );
  });

  it('runs the registered hook when it opens a new session, not when it resumes one', () => {
    const provider = new OpenCodeProvider();
    provider.registerMemorySessionHook(fakeHook());

    // query() only composes the opening prompt; the generator is lazy, so no
    // OpenCode server is touched until `events` is iterated (it is not here).
    provider.query({ prompt: 'hi', cwd: '/workspace' });
    expect(invocations()).toEqual(['{"hook_event_name":"SessionStart","source":"startup"}']);

    provider.query({ prompt: 'hi again', cwd: '/workspace', continuation: 'ses_existing' });
    expect(invocations()).toHaveLength(1);
  });
});

describe('OpenCode built-in tool policy', () => {
  it('fails closed instead of ignoring MCP-only mode', () => {
    expect(() => new OpenCodeProvider({ builtinToolMode: 'mcp-only' })).toThrow(/does not support builtinToolMode/);
  });
});

describe('buildOpenCodeConfig instructions', () => {
  it('does NOT load memory files raw through the instructions pipeline', () => {
    // OpenCode calls instruction.system() on every model request and rereads
    // each listed file raw. Memory listed here would bypass the shared
    // renderer's caps and be re-read every request instead of once per context
    // window; it goes through the memory session hook instead.
    const config = buildOpenCodeConfig({});
    expect(config.instructions).not.toContain('/workspace/agent/memory/index.md');
    expect(config.instructions).not.toContain('/workspace/agent/memory/system/definition.md');
  });

  // The array named `/app/CLAUDE.md` and `.claude-fragments/*.md` until the
  // host stopped mounting either and inlined every instruction source into the
  // composed project document instead. OpenCode reads no other file at
  // startup, so a stale entry here fails silently: the agent spawns with no
  // capability instructions and nothing logs it.
  it('loads the composed project document and the group memory file, and nothing that no longer exists', () => {
    const config = buildOpenCodeConfig({});
    expect(config.instructions).toEqual(['/workspace/agent/CLAUDE.md', '/workspace/agent/CLAUDE.local.md']);
  });
});
