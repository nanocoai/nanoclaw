import { describe, it, expect } from 'vitest';

import { SEEKDB_DATABASE, SEEKDB_HOST, SEEKDB_PASSWORD, SEEKDB_PATH, SEEKDB_PORT, SEEKDB_USER } from '../config.js';
import { createAgentGroup, deleteAgentGroup, getAgentGroup } from './agent-groups.js';
import { createCentralDb } from './central/factory.js';
import { ensureSeekDbDatabase } from './central/seekdb.js';
import type { SeekDbCentralDbOptions } from './central/types.js';
import { closeDb, setCentralDbForTest } from './connection.js';
import { runMigrations } from './migrations/index.js';

/** Set SEEKDB_INTEGRATION=1 to run (requires @seekdb/js-bindings for embedded). Not run in CI by default. */
const runIntegration = process.env.SEEKDB_INTEGRATION === '1';
/** Set SEEKDB_SERVER=1 with SEEKDB_INTEGRATION=1 to also run server-mode test. */
const runServer = process.env.SEEKDB_SERVER === '1';

const embeddedOptions = (): SeekDbCentralDbOptions => ({
  mode: 'embedded',
  path: SEEKDB_PATH,
  database: SEEKDB_DATABASE,
});

const serverOptions = (): SeekDbCentralDbOptions => ({
  mode: 'server',
  host: SEEKDB_HOST,
  port: SEEKDB_PORT,
  user: SEEKDB_USER,
  password: SEEKDB_PASSWORD,
  database: SEEKDB_DATABASE,
});

function exerciseCentralDb(options: SeekDbCentralDbOptions, agentId: string, agentName: string): void {
  ensureSeekDbDatabase(options);
  const db = createCentralDb('seekdb', options);
  setCentralDbForTest(db);
  try {
    runMigrations(db);
    deleteAgentGroup(agentId);
    const now = new Date().toISOString();
    createAgentGroup({
      id: agentId,
      name: agentName,
      folder: `seekdb-it-${options.mode}`,
      agent_provider: null,
      created_at: now,
    });
    const row = getAgentGroup(agentId);
    expect(row?.name).toBe(agentName);
  } finally {
    try {
      deleteAgentGroup(agentId);
    } catch {
      // ignore cleanup errors
    }
    closeDb();
  }
}

describe.skipIf(!runIntegration)('seekdb central (embedded)', () => {
  it('runs migrations against real embedded seekdb.db and creates an agent group', () => {
    exerciseCentralDb(embeddedOptions(), 'ag-seekdb-embedded-it', 'SeekDB Embedded Test');
  }, 60_000);
});

describe.skipIf(!runIntegration || !runServer)('seekdb central (server)', () => {
  it('runs migrations against real server SeekDB and creates an agent group', () => {
    exerciseCentralDb(serverOptions(), 'ag-seekdb-server-it', 'SeekDB Server Test');
  }, 60_000);
});
