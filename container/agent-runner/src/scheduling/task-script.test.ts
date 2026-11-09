/**
 * Container leg of the script-failure backoff chain, tested at unit level so
 * the e2e suite doesn't need a live multi-sweep scenario for it:
 *
 *   script error → applyPreTaskScripts skips with reason 'error'
 *   → markScriptSkipped acks `script-skip:error` in outbound.db
 *   (gated → plain 'completed': the monitor working as designed).
 *
 * The host leg (ack → FAILED run → streak backoff) is pinned in
 * the host SQLite driver tests and src/modules/scheduling/recurrence.test.ts —
 * both sides pin the literal 'script-skip:error'; if either renames it, its
 * own test goes red.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getPendingMessages, markScriptSkipped } from '../db/messages-in.js';
import { applyPreTaskScripts, runScript } from './task-script.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertTask(id: string, script: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'task', datetime('now'), 'pending', 1, ?)`,
    )
    .run(id, JSON.stringify({ prompt: 'monitor', script }));
}

const ackStatus = (id: string): string | undefined =>
  (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;

describe('script-skip ack chain (container leg)', () => {
  it('an erroring script skips with reason "error" and acks script-skip:error', async () => {
    insertTask('t-err', 'echo boom >&2; exit 1');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-err', reason: 'error' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-err')).toBe('script-skip:error');
  });

  it('a deliberate wakeAgent=false gate acks plain completed — never backs off', async () => {
    insertTask('t-gated', 'echo \'{"wakeAgent": false}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-gated', reason: 'gated' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-gated')).toBe('completed');
  });

  it('wakeAgent=true keeps the task and enriches the prompt with script data', async () => {
    insertTask('t-wake', 'echo \'{"wakeAgent": true, "data": {"alerts": 2}}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(skipped).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(JSON.parse(keep[0].content).scriptOutput).toEqual({ alerts: 2 });
  });
});

describe('a timed-out script is reported as a timeout', () => {
  /**
   * execFile kills on timeout, so the callback receives a generic
   * "Command failed" — the same shape a script that exited non-zero produces.
   * `killed` is the only thing that tells them apart. Without it the log said
   * `error: Command failed: bash /tmp/task-script-<id>.sh` for a script that
   * ran too long, which reads as a broken script and sends whoever is
   * debugging it looking for a bug that isn't there.
   */
  const captureLogs = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return lines;
  };

  it('names the timeout and the ceiling it hit, not a generic command failure', async () => {
    const lines = await captureLogs(() => runScript('sleep 5', 't-timeout', 150));
    const joined = lines.join('\n');
    expect(joined).toContain('[t-timeout] timed out after 150ms');
    expect(joined).not.toContain('error: Command failed');
  });

  it('still resolves null, so the task is skipped exactly as before', async () => {
    await captureLogs(async () => {
      expect(await runScript('sleep 5', 't-timeout-null', 150)).toBeNull();
    });
  });

  it('leaves a genuine non-zero exit reported as an error', async () => {
    const lines = await captureLogs(() => runScript('exit 3', 't-exit', 5000));
    const joined = lines.join('\n');
    expect(joined).toContain('error: Command failed');
    expect(joined).not.toContain('timed out');
  });
});

describe('a timed-out script takes its children down with it', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-script-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('kills the forked last command, so its side effect never lands', async () => {
    const marker = path.join(tmp, 'side-effect');
    const pidFile = path.join(tmp, 'grandchild.pid');
    // bash forks (not execs) this last command, so the grandchild outlives a bash-only kill.
    const script = `bash -c 'echo $$ > ${pidFile}; sleep 1; echo 1 > ${marker}'`;

    const original = console.error;
    console.error = () => {};
    try {
      expect(await runScript(script, 't-orphan', 300)).toBeNull();
    } finally {
      console.error = original;
    }

    // Wait past the grandchild's own sleep, which also gives init time to reap it.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(marker)).toBe(false);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('resolves after the kill grace even if a child escaped the group and holds the pipes', async () => {
    const started = Date.now();
    const original = console.error;
    console.error = () => {};
    try {
      // set -m puts the background job in its own process group.
      expect(await runScript('set -m; (sleep 6; echo escaped >&2) & wait', 't-escape', 200)).toBeNull();
    } finally {
      console.error = original;
    }
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('sends SIGTERM first, so a script can trap its timeout and clean up', async () => {
    const cleaned = path.join(tmp, 'cleaned');
    const original = console.error;
    console.error = () => {};
    try {
      const script = `trap 'echo 1 > ${cleaned}; exit 1' TERM; sleep 5 & wait`;
      const started = Date.now();
      expect(await runScript(script, 't-trap', 200)).toBeNull();
      // Exited on SIGTERM, so it resolves inside the grace instead of waiting for SIGKILL.
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      console.error = original;
    }
    expect(fs.existsSync(cleaned)).toBe(true);
  });

  it('SIGKILLs a child that ignores SIGTERM, and resolves only once it is dead', async () => {
    const marker = path.join(tmp, 'stubborn');
    const pidFile = path.join(tmp, 'stubborn.pid');
    const pgidFile = path.join(tmp, 'stubborn.pgid');
    const original = console.error;
    console.error = () => {};
    try {
      // An ignored signal stays ignored across exec, so sleep ignores SIGTERM too.
      // The script's own bash is the group leader, so its pid is the group id.
      const script = `echo $$ > ${pgidFile}; bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 3; echo 1 > ${marker}'`;
      const started = Date.now();
      expect(await runScript(script, 't-stubborn', 200)).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    } finally {
      console.error = original;
    }
    // Checked at resolution, not later: resolving early would let the next task's script overlap this one.
    const pgid = Number(fs.readFileSync(pgidFile, 'utf8'));
    expect(() => process.kill(-pgid, 0)).toThrow();
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    await new Promise((r) => setTimeout(r, 1200));
    expect(fs.existsSync(marker)).toBe(false);
  }, 10_000);

  it('enforces the output limit in bytes, not characters', async () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      // 400k three-byte chars: under 1 MiB of characters, over 1 MiB of bytes.
      const script = `printf '{"wakeAgent":true,"data":"'; head -c 400000 /dev/zero | tr '\\0' 'x' | sed 's/x/界/g'; printf '"}\\n'`;
      expect(await runScript(script, 't-bytes', 10_000)).toBeNull();
    } finally {
      console.error = original;
    }
    expect(lines.join('\n')).toContain('stdout maxBuffer length exceeded');
  });
});
