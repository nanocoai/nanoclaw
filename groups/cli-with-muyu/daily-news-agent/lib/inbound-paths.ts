import path from 'node:path';

export const AGENT_GROUP_ID = 'ag-1782743582785-mmzfdy';
export const SESSION_ID = 'sess-1782743663552-teovqi';
export const RECURRENCE = '0 9 * * *';

export function inboundDbPath(nanoclawRoot: string): string {
  return path.join(
    nanoclawRoot,
    'data',
    'v2-sessions',
    AGENT_GROUP_ID,
    SESSION_ID,
    'inbound.db',
  );
}
