/**
 * The mailbox hook script, exercised the way claude runs it: a subprocess
 * with the event payload on stdin. State transitions, the PostToolUse
 * new-mail notify (with seq high-water dedupe), and the always-exit-0
 * contract (a broken hook must never block the agent).
 *
 * The notify's input is the delivery loop's stamp, not a store: the hook
 * runs on every tool call and holds no transport knowledge, so the fixture
 * here is one local file — which is exactly the shape that keeps working
 * when the registered mailbox is not a pair of SQLite files.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

// NEVER import from mailbox-hook.ts here: the script runs main() on import,
// which reads the (absent) container.json, self-heals, and process.exit(0)s
// THE TEST RUN — bun then reports success for tests that never executed.
// Measured live: a canary `expect(1).toBe(2)` appended to this file exited 0.
import { PERMISSION_PROMPT_HOLD_MS, readAgentState, writeMailNotice } from './agent-state.js';

const SCRIPT = path.join(import.meta.dir, 'mailbox-hook.ts');

let dir: string;
let statePath: string;
let noticePath: string;

function runHook(payload: unknown, envExtra: Record<string, string> = {}): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(['bun', SCRIPT, statePath], {
    stdin: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NANOCLAW_MAIL_NOTICE: noticePath,
      NANOCLAW_CONTAINER_JSON: path.join(dir, 'container.json'),
      ...envExtra,
    },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
}

/** What the delivery loop publishes: the sequences of mail still waiting. */
function stampWaiting(...seqs: number[]): void {
  writeMailNotice({ seqs }, noticePath);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-hook-'));
  statePath = path.join(dir, 'state.json');
  noticePath = path.join(dir, 'mail-notice.json');
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({ codeMode: true }));
});

describe('state transitions', () => {
  it('SessionStart and Stop write idle; UserPromptSubmit and PreToolUse write busy', () => {
    for (const [event, expected] of [
      ['SessionStart', 'idle'],
      ['UserPromptSubmit', 'busy'],
      ['Stop', 'idle'],
      ['PreToolUse', 'busy'],
    ] as const) {
      const res = runHook({ hook_event_name: event });
      expect(res.exitCode).toBe(0);
      expect(readAgentState(statePath)?.state).toBe(expected);
    }
  });

  it('malformed stdin and unknown events exit 0 without touching state', () => {
    expect(runHook('not json').exitCode).toBe(0);
    expect(runHook({ hook_event_name: 'SomethingNew' }).exitCode).toBe(0);
    expect(readAgentState(statePath)).toBeNull();
  });

  it('in a non-code-mode container it self-heals: deregisters its hooks and exits 0', () => {
    // The group flipped back to chat mode; settings.json still carries our
    // entries, and the chat runner executes hooks too. First firing removes them.
    fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({})); // codeMode off
    const configDir = path.join(dir, 'claude-config');
    fs.mkdirSync(configDir, { recursive: true });
    const settingsPath = path.join(configDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'bun /app/src/other-hook.ts' }] },
            { hooks: [{ type: 'command', command: 'bun /app/src/code-runner/mailbox-hook.ts' }] },
          ],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'bun /app/src/code-runner/mailbox-hook.ts' }] }],
        },
      }),
    );

    const res = runHook({ hook_event_name: 'Stop' }, { CLAUDE_CONFIG_DIR: configDir });
    expect(res.exitCode).toBe(0);
    expect(readAgentState(statePath)).toBeNull(); // no state written in chat mode
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.Stop.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h) => h.command))).toEqual([
      'bun /app/src/other-hook.ts',
    ]);
    expect(settings.hooks.PreToolUse).toBeUndefined(); // emptied event key dropped
  });
});

describe('Notification permission-prompt hold', () => {
  it('permission_prompt stamps busy with a bounded busyUntil — never immortality', () => {
    const before = Date.now();
    const res = runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(res.exitCode).toBe(0);
    const state = readAgentState(statePath)!;
    expect(state.state).toBe('busy');
    const busyUntil = Date.parse(state.busyUntil!);
    expect(busyUntil).toBeGreaterThan(before);
    // Bounded: exactly one hold's width from the stamp, no more. The CLI
    // fires this once per dialog, so the cap is the whole story.
    expect(busyUntil).toBeLessThanOrEqual(Date.now() + PERMISSION_PROMPT_HOLD_MS);
  });

  it("idle_prompt and unknown types do NOT hold — waiting for input IS the reapable state", () => {
    for (const type of ['idle_prompt', 'auth_success', undefined]) {
      const res = runHook({ hook_event_name: 'Notification', notification_type: type });
      expect(res.exitCode).toBe(0);
      expect(readAgentState(statePath)).toBeNull();
    }
  });

  it('the hold preserves the notify high-water mark', () => {
    stampWaiting(2);
    runHook({ hook_event_name: 'PostToolUse' });
    runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(readAgentState(statePath)?.notifiedSeq).toBe(2);
  });
});

describe('PostToolUse busy-notify', () => {
  it('emits additionalContext once per arrival wave, deduped by seq high-water', () => {
    stampWaiting(2);
    const first = runHook({ hook_event_name: 'PostToolUse' });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('additionalContext');
    expect(first.stdout).toContain('1 new message');
    expect(first.stdout).toContain('ncl inbox read');
    expect(readAgentState(statePath)?.notifiedSeq).toBe(2);

    // Same mail, next tool call: silence.
    const second = runHook({ hook_event_name: 'PostToolUse' });
    expect(second.stdout).toBe('');

    // New arrival above the high-water mark: notify again.
    stampWaiting(2, 4);
    const third = runHook({ hook_event_name: 'PostToolUse' });
    expect(third.stdout).toContain('1 new message');
    expect(readAgentState(statePath)?.notifiedSeq).toBe(4);
  });

  it('stays silent once the loop reports the mail claimed, and when there is no stamp at all', () => {
    // The loop publishes only unclaimed mail: a claimed/acked message simply
    // leaves the stamp, and the hook has nothing to say.
    stampWaiting(2);
    expect(runHook({ hook_event_name: 'PostToolUse' }).stdout).toContain('1 new message');
    stampWaiting();
    expect(runHook({ hook_event_name: 'PostToolUse' }).stdout).toBe('');

    // No stamp at all (a loop that has not ticked yet, or a torn write):
    // fail closed — silence, exit 0, and the loop still injects at turn end.
    fs.rmSync(noticePath);
    const res = runHook({ hook_event_name: 'PostToolUse' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');

    fs.writeFileSync(noticePath, 'not json');
    expect(runHook({ hook_event_name: 'PostToolUse' }).stdout).toBe('');
  });

  it('busy/idle transitions preserve the notify high-water mark', () => {
    stampWaiting(2);
    runHook({ hook_event_name: 'PostToolUse' });
    runHook({ hook_event_name: 'Stop' });
    expect(readAgentState(statePath)?.state).toBe('idle');
    expect(readAgentState(statePath)?.notifiedSeq).toBe(2);
  });
});
