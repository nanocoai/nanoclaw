import { getDb } from '../../db/connection.js';

export interface TurnTraceRow {
  id: string;
  session_id: string;
  agent_group_id: string;
  turn_id: string;
  message_ids: string;
  provider: string | null;
  model: string | null;
  status: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  input: string;
  output: string | null;
  error: string | null;
  tool_call_count: number;
  steps: string;
  steps_dropped: number;
  created_at: string;
}

export interface TurnTraceFilter {
  agentGroupId?: string;
  sessionId?: string;
  status?: string;
  limit: number;
}

const COLUMNS = [
  'id',
  'session_id',
  'agent_group_id',
  'turn_id',
  'message_ids',
  'provider',
  'model',
  'status',
  'started_at',
  'ended_at',
  'duration_ms',
  'input',
  'output',
  'error',
  'tool_call_count',
  'steps',
  'steps_dropped',
  'created_at',
] as const;

export async function insertTurnTrace(row: TurnTraceRow): Promise<void> {
  await getDb().run(
    `INSERT INTO turn_traces (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    ...COLUMNS.map((column) => row[column]),
  );
}

export async function listTurnTraces(filter: TurnTraceFilter): Promise<TurnTraceRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.agentGroupId) {
    where.push('agent_group_id = ?');
    params.push(filter.agentGroupId);
  }
  if (filter.sessionId) {
    where.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  return getDb().all<TurnTraceRow>(
    `SELECT * FROM turn_traces${clause} ORDER BY started_at DESC, id LIMIT ?`,
    ...params,
    filter.limit,
  );
}

export async function getTurnTrace(id: string): Promise<TurnTraceRow | undefined> {
  return getDb().get<TurnTraceRow>('SELECT * FROM turn_traces WHERE id = ?', id);
}

/** Delete traces recorded before `cutoff` (ISO-8601). Returns the number removed. */
export async function pruneTurnTraces(cutoff: string): Promise<number> {
  const result = await getDb().run('DELETE FROM turn_traces WHERE created_at < ?', cutoff);
  return result.changes;
}
