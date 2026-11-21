/**
 * `turn_trace` delivery action — stores one agent turn's trace.
 *
 * The container sends at most one trace per answered batch. Every field is
 * re-checked and bounded here: the payload comes from inside the sandbox.
 */
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { insertTurnTrace } from './db.js';
import { ensureTurnTraceRetention } from './retention.js';

export const TURN_STATUSES = ['ok', 'error', 'incomplete'] as const;

const TEXT_MAX_CHARS = 8000;
const MAX_STEPS = 200;
const STEPS_MAX_CHARS = 512 * 1024;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function capped(value: unknown): string | null {
  const s = str(value);
  if (s === null) return null;
  return s.length > TEXT_MAX_CHARS ? s.slice(0, TEXT_MAX_CHARS) + '…' : s;
}

function isoOr(value: unknown, fallback: string): string {
  const s = str(value);
  return s !== null && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : fallback;
}

export async function applyTurnTrace(payload: Record<string, unknown>, session: Session): Promise<void> {
  const turnId = str(payload.turn_id);
  const status = str(payload.status);
  if (!turnId || !status || !(TURN_STATUSES as readonly string[]).includes(status)) {
    log.warn('turn_trace dropped: missing turn_id or unknown status', { sessionId: session.id, status });
    return;
  }

  const now = new Date().toISOString();
  const rawSteps = Array.isArray(payload.steps)
    ? payload.steps.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    : [];
  let steps = rawSteps.slice(0, MAX_STEPS);
  let stepsDropped =
    rawSteps.length - steps.length + (typeof payload.steps_dropped === 'number' ? payload.steps_dropped : 0);
  let stepsJson = JSON.stringify(steps);
  if (stepsJson.length > STEPS_MAX_CHARS) {
    stepsDropped += steps.length;
    steps = [];
    stepsJson = '[]';
  }
  const messageIds = Array.isArray(payload.message_ids)
    ? payload.message_ids.filter((id) => typeof id === 'string')
    : [];
  const duration = typeof payload.duration_ms === 'number' && payload.duration_ms >= 0 ? payload.duration_ms : 0;

  await insertTurnTrace({
    id: randomUUID(),
    session_id: session.id,
    agent_group_id: session.agent_group_id,
    turn_id: turnId,
    message_ids: JSON.stringify(messageIds),
    provider: str(payload.provider),
    model: str(payload.model),
    status,
    started_at: isoOr(payload.started_at, now),
    ended_at: isoOr(payload.ended_at, now),
    duration_ms: Math.round(duration),
    input: capped(payload.input) ?? '',
    output: capped(payload.output),
    error: capped(payload.error),
    tool_call_count: steps.filter((s) => s.type === 'tool').length,
    steps: stepsJson,
    steps_dropped: stepsDropped,
    created_at: now,
  });
  await ensureTurnTraceRetention();
}
