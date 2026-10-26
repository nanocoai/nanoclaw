import type { ModuleMigration } from '../../db/migrations/index.js';

export const turnTracesTable: ModuleMigration = {
  version: 1,
  name: 'module:turn-traces:create-table',
  async up(db) {
    await db.exec(`
      CREATE TABLE turn_traces (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        turn_id         TEXT NOT NULL,
        message_ids     TEXT NOT NULL,
        provider        TEXT,
        model           TEXT,
        status          TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        ended_at        TEXT NOT NULL,
        duration_ms     INTEGER NOT NULL,
        input           TEXT NOT NULL,
        output          TEXT,
        error           TEXT,
        tool_call_count INTEGER NOT NULL,
        steps           TEXT NOT NULL,
        steps_dropped   INTEGER NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_turn_traces_created_at ON turn_traces(created_at);
      CREATE INDEX idx_turn_traces_group ON turn_traces(agent_group_id, started_at);
      CREATE INDEX idx_turn_traces_session ON turn_traces(session_id, started_at);
    `);
  },
};
