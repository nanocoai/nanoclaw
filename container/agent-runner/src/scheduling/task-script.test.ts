/**
 * Regression tests for the pre-task-script wake gate:
 *   - wakeAgent=false / script errors never wake the agent (existing gate);
 *   - a recurring watcher returning the SAME data that already woke the
 *     agent is deduped and cannot wake again (quota-burn fix);
 *   - new data re-arms the wake.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import type { MessageInRow } from '../db/messages-in.js';
import { applyPreTaskScripts } from './task-script.js';

function taskRow(id: string, script: string, seriesId: string | null = 'series-1'): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'task',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: '*/10 * * * *',
    series_id: seriesId,
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ prompt: 'check the thing', script }),
  };
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('pre-task script gate', () => {
  it('skips tasks whose script says wakeAgent=false', async () => {
    const out = await applyPreTaskScripts([taskRow('t1', `echo '{"wakeAgent":false}'`)]);
    expect(out.keep).toHaveLength(0);
    expect(out.skipped).toEqual(['t1']);
  });

  it('skips tasks whose script errors or emits invalid output', async () => {
    const out = await applyPreTaskScripts([taskRow('t2', 'echo not-json')]);
    expect(out.keep).toHaveLength(0);
    expect(out.skipped).toEqual(['t2']);
  });

  it('dedupes a recurring watcher that re-reports identical data', async () => {
    const script = `echo '{"wakeAgent":true,"data":{"match":"job-42"}}'`;

    const first = await applyPreTaskScripts([taskRow('t3', script)]);
    expect(first.keep).toHaveLength(1);

    // Next occurrence, same series, same data → suppressed.
    const second = await applyPreTaskScripts([taskRow('t4', script)]);
    expect(second.keep).toHaveLength(0);
    expect(second.skipped).toEqual(['t4']);

    // New data → wakes again.
    const third = await applyPreTaskScripts([
      taskRow('t5', `echo '{"wakeAgent":true,"data":{"match":"job-43"}}'`),
    ]);
    expect(third.keep).toHaveLength(1);
  });

  it('does not dedupe data-less wakes (plain reminders)', async () => {
    const script = `echo '{"wakeAgent":true}'`;
    const first = await applyPreTaskScripts([taskRow('r1', script, 'series-r')]);
    const second = await applyPreTaskScripts([taskRow('r2', script, 'series-r')]);
    expect(first.keep).toHaveLength(1);
    expect(second.keep).toHaveLength(1);
  });
});
