/**
 * Host-sweep hooks for the fallback module — dynamically imported from
 * host-sweep.ts (MODULE-HOOK convention) so core has no static dependency on
 * this optional module.
 */
import type Database from 'better-sqlite3';
import { killContainer } from '../../container-runner.js';
import { getContainerState } from '../../db/session-db.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { parseSqliteUtc } from '../../host-sweep.js';
import { openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  enterFallback,
  exitFallback,
  handleDoubleFaultTimeout,
  handleProbeTimeout,
  startReturnProbe,
} from './controller.js';
import { getFallbackState } from './db.js';
import {
  decideFallbackSweep,
  RESPONSE_GUARANTEE_MS,
  type OverdueTriggerMessage,
  type ProbeRowStatus,
} from './decide.js';

function declaredBashMs(outDb: Database.Database | null): number {
  if (!outDb) return 0;
  const state = getContainerState(outDb);
  if (!state || state.current_tool !== 'Bash') return 0;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : 0;
}

function overdueTriggerMessages(inDb: Database.Database, nowMs: number): OverdueTriggerMessage[] {
  const rows = inDb
    .prepare("SELECT id, timestamp FROM messages_in WHERE trigger = 1 AND status IN ('pending', 'processing')")
    .all() as Array<{ id: string; timestamp: string }>;
  return rows
    .map((r) => ({ id: r.id, ageMs: nowMs - parseSqliteUtc(r.timestamp) }))
    .filter((m) => !Number.isNaN(m.ageMs));
}

/**
 * Per-session hook, called once per sweep tick for every active session,
 * before the generic SLA/retry steps in sweepSession — fallback takes
 * precedence over the generic retry-with-backoff path so an overdue row is
 * handled once, by whichever mechanism notices it first.
 */
export async function sweepFallbackSession(
  inDb: Database.Database,
  outDb: Database.Database | null,
  session: Session,
): Promise<void> {
  const nowMs = Date.now();
  const overdue = overdueTriggerMessages(inDb, nowMs);
  if (overdue.length === 0) return;

  const state = getFallbackState();

  if (state.active) {
    // The backup provider itself breached the guarantee — there's no third
    // provider to fall back to. Fail these messages and notify once; the
    // regular retry machinery is bypassed so this can't turn into a loop.
    const threshold = Math.max(RESPONSE_GUARANTEE_MS, declaredBashMs(outDb) + 60_000);
    const breached = overdue.filter((m) => m.ageMs > threshold).map((m) => m.id);
    if (breached.length === 0) return;
    killContainer(session.id, 'fallback-double-fault');
    handleDoubleFaultTimeout(session, inDb, breached);
    return;
  }

  const decision = decideFallbackSweep({
    nowMs,
    state,
    probeRowStatus: null,
    overdueTriggerMessages: overdue,
    declaredBashMs: declaredBashMs(outDb),
  });

  if (decision.type !== 'guarantee-breach') return;

  log.warn('Response guarantee breached — entering fallback', {
    sessionId: session.id,
    messageIds: decision.messageIds,
  });
  await enterFallback({
    mode: 'auto',
    classification: 'timeout',
    reason: 'response-guarantee-breach',
    resetAt: null,
    originSessionId: session.id,
    originGroupId: session.agent_group_id,
    messageIds: decision.messageIds,
  });
}

function readProbeRowStatus(agentGroupId: string, sessionId: string, messageId: string): ProbeRowStatus {
  const inDb = openInboundDb(agentGroupId, sessionId);
  try {
    const row = inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(messageId) as
      | { status: string }
      | undefined;
    if (!row) return null;
    if (row.status === 'completed') return 'completed';
    if (row.status === 'failed') return 'failed';
    return 'pending';
  } finally {
    inDb.close();
  }
}

/**
 * Once-per-tick hook (not per session) — drives the auto-return probe state
 * machine off the global fallback_state row.
 */
export async function sweepFallbackReturn(): Promise<void> {
  const state = getFallbackState();
  if (!state.active) return;

  let probeRowStatus: ProbeRowStatus = null;
  if (state.probing && state.probeSessionId && state.probeMessageId) {
    const probeSession = getSession(state.probeSessionId);
    if (probeSession) {
      probeRowStatus = readProbeRowStatus(probeSession.agent_group_id, probeSession.id, state.probeMessageId);
    }
  }

  const decision = decideFallbackSweep({
    nowMs: Date.now(),
    state,
    probeRowStatus,
    overdueTriggerMessages: [],
  });

  switch (decision.type) {
    case 'start-probe':
      startReturnProbe(Date.now());
      break;
    case 'probe-success':
      exitFallback({ via: 'probe' });
      break;
    case 'probe-timeout':
      handleProbeTimeout();
      break;
    default:
      break;
  }
}
