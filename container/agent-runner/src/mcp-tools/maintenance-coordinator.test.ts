/**
 * Regression tests for the 2026-08-15/16 "agent narrated a result that
 * contradicted the actual tool answer" incident during live behavioral
 * testing of the Maintenance Coordinator wake.
 *
 * Root cause: every read/query tool here is fire-and-forget -- the tool
 * call's own synchronous return is only an acknowledgment; the real answer
 * always arrives a moment later as a separate message. That ack used to be
 * a bare "Checking..." string, which the agent misread as if it WERE the
 * (empty/negative) answer -- it narrated "no data" / "unconfirmed" even
 * though the real follow-up (already delivered) said otherwise.
 *
 * These tests lock down the structural fix: the ack text itself must be
 * explicit that it is not the answer and that a real result is coming.
 * They cannot exercise the LLM's own reasoning (that's a live-behavior
 * property, not a unit-testable one) -- see the live re-test procedure in
 * the Milestone 1 test notes for that half of the regression coverage.
 *
 * Ported from old commit 824318ff. initTestSessionDb/closeSessionDb moved
 * to ../mailbox/sqlite/connection.js since this commit was authored
 * (was ../db/connection.js) -- import path updated, no other change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import { getWorkerInfo, getKeyBinderStatus, getWorkdayStatus, queryMaintenanceStatus } from './maintenance-coordinator.js';

function ackText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('read/query tool acknowledgments never look like an answer', () => {
  it('get_worker_info ack explicitly says this is not the answer and a real result follows', async () => {
    const result = await getWorkerInfo.handler({});
    const text = ackText(result);
    expect(text).not.toBe('Checking...');
    expect(text.toLowerCase()).toContain('not the answer');
    expect(text.toLowerCase()).toMatch(/wait|separate message|arrives/);
  });

  it('get_key_binder_status ack explicitly says this is not the answer and a real result follows', async () => {
    const result = await getKeyBinderStatus.handler({});
    const text = ackText(result);
    expect(text).not.toBe('Checking...');
    expect(text.toLowerCase()).toContain('not the answer');
  });

  it('get_workday_status ack explicitly says this is not the answer and a real result follows', async () => {
    const result = await getWorkdayStatus.handler({});
    const text = ackText(result);
    expect(text).not.toBe('Checking...');
    expect(text.toLowerCase()).toContain('not the answer');
  });

  it('query_maintenance_status ack explicitly says this is not the answer and a real result follows', async () => {
    const result = await queryMaintenanceStatus.handler();
    const text = ackText(result);
    expect(text).not.toBe('Checking...');
    expect(text.toLowerCase()).toContain('not the answer');
  });

  it('all four read/query tools share the exact same ack wording -- one fix point, not four to drift apart', async () => {
    const [worker, binder, workday, status] = await Promise.all([
      getWorkerInfo.handler({}),
      getKeyBinderStatus.handler({}),
      getWorkdayStatus.handler({}),
      queryMaintenanceStatus.handler(),
    ]);
    const texts = [worker, binder, workday, status].map(ackText);
    expect(new Set(texts).size).toBe(1);
  });
});
