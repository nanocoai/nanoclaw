/**
 * Regression: nanocoai/nanoclaw#3730 — a Slack DM wiring with
 * session_mode='shared' / threads=NULL must still honor the platform thread
 * id for REPLY DELIVERY.
 *
 * Slack's "Agents & Assistants" DM surface materializes a thread per
 * conversation, and the incoming thread_ts IS that conversation's visible
 * identity. When dm.threads was false the router stripped the delivery
 * thread id, so every agent reply posted top-level and rendered as a fresh
 * History card even though the backend session was correctly shared. The fix
 * is a capability statement: dm.threads = true, so resolveThreadPolicy keeps
 * the thread id for delivery. Session identity is governed independently by
 * session_mode ('shared' still collapses to one session — resolveSession
 * ignores threadId under 'shared', and the router's per-thread promotion is
 * short-circuited for is_group=0).
 */
import { describe, it, expect } from 'vitest';

import { resolveThreadPolicy } from './channel-defaults.js';
import { SLACK_DEFAULTS } from './slack.js';

describe('Slack DM thread policy (#3730)', () => {
  it('declares dm.threads: true so the assistant thread_ts survives to delivery', () => {
    expect(SLACK_DEFAULTS.dm.threads).toBe(true);
  });

  it('a shared DM wiring (threads column NULL) inherits thread policy ON', () => {
    // wiringThreads NULL → inherit SLACK_DEFAULTS.dm.threads; Slack supports threads.
    expect(resolveThreadPolicy(null, SLACK_DEFAULTS, /* isGroup */ false, /* supportsThreads */ true)).toBe(true);
  });

  it('an explicit --threads false still opts a DM wiring out (flat top-level replies)', () => {
    expect(resolveThreadPolicy(0, SLACK_DEFAULTS, false, true)).toBe(false);
  });

  it('new DM wirings are unchanged: sessionMode per-thread still drives the threads=1 stamp', () => {
    // The derivation itself (sessionMode 'per-thread' → threads: 1) is covered
    // in channel-session-defaults.test.ts; here we pin the declaration it reads.
    expect(SLACK_DEFAULTS.dm.sessionMode).toBe('per-thread');
  });
});
