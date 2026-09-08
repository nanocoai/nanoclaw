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
import memoryPlugin from './opencode-memory-plugin.js';
import { prepareOpenCodeMemory, readOpenCodeMemory } from './opencode-memory.js';

/**
 * Memory reaches the OpenCode agent through the shared memory session hook —
 * the same command the Claude and Codex providers register — run at the two
 * moments OpenCode rebuilds a context window: a new session, and the awaited
 * compaction hook before native continuation. Never on a resume, never on an ordinary
 * push, and never through the config `instructions` array (OpenCode rereads
 * those files raw on every model request, bypassing the shared renderer's
 * per-file caps and the whole lifecycle).
 *
 * Hermetic: the "hook" is a temp shell script that logs the stdin payload it
 * received and echoes a marker, so these exercise the real spawn/stdin path
 * without invoking the real shared memory renderer.
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

describe('native memory hooks', () => {
  async function plugin() {
    return memoryPlugin({}, { directory: dir });
  }
  async function system(hooks: Awaited<ReturnType<typeof plugin>>, sessionID = 'ses_test') {
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']({ sessionID }, output);
    return output.system.join('\n');
  }

  it('seeds startup once and makes cached memory available to every native model request', async () => {
    prepareOpenCodeMemory('ses_test', fakeHook(), 'CORE', 'ROUTING', true, dir);
    const hooks = await plugin();
    expect(await system(hooks)).toBe(`${MARKER}\n\nCORE\n\nROUTING`);
    expect(await system(hooks)).toBe(`${MARKER}\n\nCORE\n\nROUTING`);
    expect(invocations()).toEqual(['{"hook_event_name":"SessionStart","source":"startup"}']);
  });

  it('reuses persisted memory on a cold resume and refreshes current core instructions', async () => {
    const hook = fakeHook();
    prepareOpenCodeMemory('ses_test', hook, 'OLD', 'ROUTING', true, dir);
    prepareOpenCodeMemory('ses_test', hook, 'CURRENT', 'ROUTING', false, dir);
    const cold = await plugin();
    expect(await system(cold)).toBe(`${MARKER}\n\nCURRENT\n\nROUTING`);
    expect(invocations()).toHaveLength(1);
  });

  it('refreshes in the awaited compaction hook before native continuation, without another external push', async () => {
    prepareOpenCodeMemory('ses_test', fakeHook(), 'CORE', 'ROUTING', true, dir);
    prepareOpenCodeMemory('ses_test', fakeHook({ body: 'FRESH' }), 'CORE', 'ROUTING', false, dir);
    const hooks = await plugin();
    await hooks['experimental.session.compacting']({ sessionID: 'ses_test' }, { context: [] });
    expect(await system(hooks)).toBe('FRESH\n\nCORE\n\nROUTING');
    expect(invocations()).toEqual([
      '{"hook_event_name":"SessionStart","source":"startup"}',
      '{"hook_event_name":"SessionStart","source":"compact"}',
    ]);
  });

  it('retains the last snapshot on renderer failure but clears successfully emptied memory', async () => {
    prepareOpenCodeMemory('ses_test', fakeHook(), 'CORE', '', true, dir);
    const hooks = await plugin();
    prepareOpenCodeMemory('ses_test', fakeHook({ exitCode: 1 }), 'CORE', '', false, dir);
    await hooks['experimental.session.compacting']({ sessionID: 'ses_test' }, { context: [] });
    expect(await system(hooks)).toContain(MARKER);
    prepareOpenCodeMemory('ses_test', fakeHook({ body: '' }), 'CORE', '', false, dir);
    await hooks['experimental.session.compacting']({ sessionID: 'ses_test' }, { context: [] });
    expect(await system(hooks)).toBe('CORE');
  });

  it('inherits parent memory for task children and persists child compaction separately', async () => {
    prepareOpenCodeMemory('ses_test', fakeHook(), 'CORE', 'ROUTING', true, dir);
    prepareOpenCodeMemory('ses_test', fakeHook({ body: 'CHILD FRESH' }), 'CORE', 'ROUTING', false, dir);
    const hooks = await memoryPlugin(
      {
        client: {
          session: {
            get: async ({ path }) => ({ data: { parentID: path.id === 'ses_child' ? 'ses_test' : undefined } }),
          },
        },
      },
      { directory: dir },
    );
    expect(await system(hooks, 'ses_child')).toBe(`${MARKER}\n\nCORE\n\nROUTING`);
    expect(await system(hooks, 'ses_unrelated')).toBe('');
    await hooks['experimental.session.compacting']({ sessionID: 'ses_child' }, { context: [] });
    expect(await system(hooks, 'ses_child')).toContain('CHILD FRESH');
    expect(readOpenCodeMemory('ses_test', dir)?.memory).toBe(MARKER);
    expect(invocations()).toHaveLength(2);
  });

  it('does not attach session memory to unscoped requests or execute startup on a legacy resume', async () => {
    prepareOpenCodeMemory('ses_legacy', fakeHook(), 'CORE', '', false, dir);
    const hooks = await plugin();
    expect(await system(hooks, 'ses_legacy')).toBe('CORE');
    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform']({}, output);
    expect(output.system).toEqual([]);
    expect(invocations()).toEqual([]);
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
  it('does NOT load memory files raw through the instructions pipeline', () => {
    // OpenCode calls instruction.system() on every model request and rereads
    // each listed file raw. Memory listed here would bypass the shared
    // renderer's caps and be re-read every request instead of once per context
    // window; it goes through the memory session hook instead.
    const config = buildOpenCodeConfig({});
    expect(config.instructions).not.toContain('/workspace/agent/memory/index.md');
    expect(config.instructions).not.toContain('/workspace/agent/memory/system/definition.md');
  });

  it('loads the composed group instructions from the agent directory', () => {
    const config = buildOpenCodeConfig({});
    expect(config.instructions).toContain('/workspace/agent/CLAUDE.md');
    expect(config.instructions).toContain('/workspace/agent/CLAUDE.local.md');
  });
});
