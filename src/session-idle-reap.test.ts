import fs from 'fs';
import { describe, expect, it } from 'vitest';

import { IDLE_REAP_MS, TASK_FINISH_QUIET_MS, decideIdleReap } from './session-idle-reap.js';

const NOW = 1_000_000_000;
const base = { now: NOW, dueCount: 0, claimCount: 0 };

describe('idle reap decision', () => {
  it('a drained task session reaps after the quiet grace — the canonical finish point', () => {
    expect(decideIdleReap({ ...base, isTask: true, lastAliveMs: NOW - TASK_FINISH_QUIET_MS - 1 })).toBe('reap-task-finished');
    expect(decideIdleReap({ ...base, isTask: true, lastAliveMs: NOW - TASK_FINISH_QUIET_MS + 1000 })).toBe('keep');
  });

  it('a conversation reaps only past the five-minute idle window', () => {
    expect(decideIdleReap({ ...base, isTask: false, lastAliveMs: NOW - IDLE_REAP_MS - 1 })).toBe('reap-idle');
    expect(decideIdleReap({ ...base, isTask: false, lastAliveMs: NOW - IDLE_REAP_MS + 1000 })).toBe('keep');
  });

  it('outstanding work always keeps the container — stuck handling stays with decideStuckAction', () => {
    expect(decideIdleReap({ ...base, isTask: true, claimCount: 1, lastAliveMs: 1 })).toBe('keep');
    expect(decideIdleReap({ ...base, isTask: false, dueCount: 2, lastAliveMs: 1 })).toBe('keep');
    expect(decideIdleReap({ ...base, isTask: false, lastAliveMs: 0 })).toBe('keep');
  });
});

describe('idle reap wiring', () => {
  it('the per-session sweep calls the reaper (red when the seam edit is deleted)', () => {
    const sweep = fs.readFileSync('src/reconcile-session.ts', 'utf8');
    expect(sweep).toContain('MODULE-HOOK:session-idle-reap:start');
    expect(sweep).toContain("import('./session-idle-reap.js')");
    expect(sweep).toContain('reapIdleSession(mailbox, session, agentGroupId)');
  });
});
