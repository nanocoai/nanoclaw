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
