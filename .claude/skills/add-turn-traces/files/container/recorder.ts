/**
 * Per-turn trace recorder.
 *
 * Collects one trace per answered batch — the inbound rows, mid-turn text,
 * tool calls, the final result and timings — and hands it to the host as a
 * `turn_trace` system action when the turn ends. The host stores it in the
 * central `turn_traces` table.
 *
 * A turn is keyed by the batch's `inReplyTo` (its first message id). The
 * poll loop reports which turn it is answering on every provider event, so
 * a follow-up pushed into a live query opens its own trace and is closed by
 * its own result. A corrective retry reuses its turn's key after that turn
 * has closed; its events are not recorded.
 *
 * Tool calls arrive from provider hooks that know nothing about turns. They
 * land on the turn the poll loop last reported.
 *
 * Recording is per-group opt-in: a turn is traced only while the group
 * folder holds a `turn-traces.enabled` file. The check runs at every turn,
 * so adding or removing the file takes effect without a respawn.
 */
import fs from 'fs';

import { getConfig } from '../../config.js';
import type { MessageInRow } from '../../db/messages-in.js';
import { writeMessageOut } from '../../db/messages-out.js';
import type { RoutingContext } from '../../formatter.js';
import type { ProviderEvent } from '../../providers/types.js';

export const TEXT_MAX_CHARS = 8000;
export const TOOL_IO_MAX_CHARS = 2000;
export const MAX_STEPS = 200;
const MAX_OPEN_TURNS = 20;
const DEFAULT_MARKER = '/workspace/agent/turn-traces.enabled';

let markerPath = DEFAULT_MARKER;

export type TraceStep =
  | { type: 'text'; at: string; text: string }
  | {
      type: 'tool';
      at: string;
      tool_use_id: string | null;
      name: string;
      input: string;
      output: string | null;
      is_error: boolean;
      duration_ms: number | null;
    };

export type TurnStatus = 'ok' | 'error' | 'incomplete';

export interface TurnTracePayload {
  action: 'turn_trace';
  turn_id: string;
  message_ids: string[];
  provider: string | null;
  model: string | null;
  status: TurnStatus;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  input: string;
  output: string | null;
  error: string | null;
  steps: TraceStep[];
  steps_dropped: number;
}

interface OpenTurn {
  id: string;
  messageIds: string[];
  startedAt: number;
  input: string;
  steps: TraceStep[];
  stepsDropped: number;
  toolSteps: Map<string, Extract<TraceStep, { type: 'tool' }>>;
}

const open = new Map<string, OpenTurn>();
let currentTurnId: string | null = null;

export function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function runtimeIdentity(): { provider: string | null; model: string | null } {
  try {
    const config = getConfig();
    return { provider: config.provider, model: config.model ?? null };
  } catch {
    return { provider: null, model: null };
  }
}

function addStep(turn: OpenTurn, step: TraceStep): boolean {
  if (turn.steps.length >= MAX_STEPS) {
    turn.stepsDropped++;
    return false;
  }
  turn.steps.push(step);
  return true;
}

function turnKey(routing: RoutingContext, messages: MessageInRow[] = []): string | null {
  return routing.inReplyTo ?? messages[0]?.id ?? null;
}

function finish(turn: OpenTurn, status: TurnStatus, output: string | null, error: string | null): void {
  open.delete(turn.id);
  const endedAt = Date.now();
  const payload: TurnTracePayload = {
    action: 'turn_trace',
    turn_id: turn.id,
    message_ids: turn.messageIds,
    ...runtimeIdentity(),
    status,
    started_at: new Date(turn.startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    duration_ms: endedAt - turn.startedAt,
    input: turn.input,
    output: output === null ? null : cap(output, TEXT_MAX_CHARS),
    error: error === null ? null : cap(error, TEXT_MAX_CHARS),
    steps: turn.steps,
    steps_dropped: turn.stepsDropped,
  };
  // Tracing is observability, never control flow: a failed write is logged
  // and dropped so it can never break the turn it describes.
  void writeMessageOut({
    id: `trace-${endedAt}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    content: JSON.stringify(payload),
  }).catch((err: unknown) => {
    console.error(`[turn-traces] dropped trace for ${turn.id}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function flushOpen(status: TurnStatus, error: string | null): void {
  for (const turn of [...open.values()]) finish(turn, status, null, error);
  currentTurnId = null;
}

export function beginTurn(messages: MessageInRow[], routing: RoutingContext, followUp: boolean): void {
  // A fresh query means the previous one is gone; anything it left open
  // never got a result.
  if (!followUp) flushOpen('incomplete', null);
  const id = turnKey(routing, messages);
  if (!id || !fs.existsSync(markerPath)) return;
  if (open.size >= MAX_OPEN_TURNS) {
    const oldest = open.values().next().value as OpenTurn;
    finish(oldest, 'incomplete', null, null);
  }
  open.set(id, {
    id,
    messageIds: messages.map((m) => m.id),
    startedAt: Date.now(),
    input: cap(messages.map((m) => m.content).join('\n'), TEXT_MAX_CHARS),
    steps: [],
    stepsDropped: 0,
    toolSteps: new Map(),
  });
  if (!followUp) currentTurnId = id;
}

export function recordProviderEvent(event: ProviderEvent, routing: RoutingContext): void {
  const id = turnKey(routing);
  currentTurnId = id;
  const turn = id ? open.get(id) : undefined;
  if (!turn) return;
  if (event.type === 'text') {
    addStep(turn, { type: 'text', at: new Date().toISOString(), text: cap(event.text, TEXT_MAX_CHARS) });
  } else if (event.type === 'result') {
    finish(turn, event.isError ? 'error' : 'ok', event.text, event.error ?? null);
  }
}

export function failOpenTurns(err: unknown): void {
  flushOpen('error', err instanceof Error ? err.message : String(err));
}

export function recordToolStart(toolUseId: string | undefined, name: string, input: unknown): void {
  const turn = currentTurnId ? open.get(currentTurnId) : undefined;
  if (!turn) return;
  const step: Extract<TraceStep, { type: 'tool' }> = {
    type: 'tool',
    at: new Date().toISOString(),
    tool_use_id: toolUseId ?? null,
    name,
    input: cap(stringify(input), TOOL_IO_MAX_CHARS),
    output: null,
    is_error: false,
    duration_ms: null,
  };
  if (addStep(turn, step) && toolUseId) turn.toolSteps.set(toolUseId, step);
}

export function recordToolEnd(
  toolUseId: string | undefined,
  output: unknown,
  isError: boolean,
  durationMs: number | undefined,
): void {
  if (!toolUseId) return;
  for (const turn of open.values()) {
    const step = turn.toolSteps.get(toolUseId);
    if (!step) continue;
    turn.toolSteps.delete(toolUseId);
    step.output = cap(stringify(output), TOOL_IO_MAX_CHARS);
    step.is_error = isError;
    step.duration_ms = durationMs ?? Date.now() - Date.parse(step.at);
    return;
  }
}

/** Test-only: forget every open turn without emitting it, and point the opt-in check at `marker`. */
export function resetTurnTraces(marker = DEFAULT_MARKER): void {
  open.clear();
  currentTurnId = null;
  markerPath = marker;
}
