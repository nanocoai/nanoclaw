/**
 * Regression test for #2465 — approval-path `ncl destinations add/remove`
 * must hydrate every active session's `inbound.db` `destinations` table,
 * not just the central `agent_destinations` row.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so this test invokes dispatch
 * with the host caller — same code path as a real approval payload.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-destinations' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-destinations';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `destinations-add` / `destinations-remove` commands.
import './destinations.js';

function now(): string {
  return new Date().toISOString();
}

function readSessionDestinations(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db.prepare('SELECT name, type, agent_group_id FROM destinations ORDER BY name').all() as Array<{
    name: string;
    type: string;
    agent_group_id: string | null;
  }>;
  db.close();
  return rows;
}

describe('destinations CLI custom ops project to inbound.db (#2465)', () => {
  const SOURCE = 'ag-source';
  const TARGET = 'ag-target';
  const SESSION_A = 'sess-source-1';
  const SESSION_B = 'sess-source-2';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: SOURCE, name: 'source', folder: 'source', agent_provider: null, created_at: now() });
    createAgentGroup({ id: TARGET, name: 'target', folder: 'target', agent_provider: null, created_at: now() });

    // Two active sessions for the source agent — both must receive the
    // projected destination row. Fixing only the "newest" session is a
    // common regression shape, so the second session catches that.
    for (const sid of [SESSION_A, SESSION_B]) {
      createSession({
        id: sid,
        agent_group_id: SOURCE,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now(),
      });
      initSessionFolder(SOURCE, sid);
    }
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('add: projects the new destination into every active session inbound.db', async () => {
    // Sanity: inbound.db starts with no destinations.
    expect(readSessionDestinations(SOURCE, SESSION_A)).toEqual([]);
    expect(readSessionDestinations(SOURCE, SESSION_B)).toEqual([]);

    // caller: 'host' is what the cli_command approval handler in dispatch.ts
    // uses when it re-enters dispatch after admin approval.
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'destinations-add',
        args: {
          agent_group_id: SOURCE,
          local_name: 'helper',
          target_type: 'agent',
          target_id: TARGET,
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);

    for (const sid of [SESSION_A, SESSION_B]) {
      const rows = readSessionDestinations(SOURCE, sid);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'helper', type: 'agent', agent_group_id: TARGET });
    }
  });

  it('remove: clears the destination from every active session inbound.db', async () => {
    await dispatch(
      {
        id: 'req-add',
        command: 'destinations-add',
        args: { agent_group_id: SOURCE, local_name: 'helper', target_type: 'agent', target_id: TARGET },
      },
      { caller: 'host' },
    );

    // Precondition: add succeeded and projected to both sessions.
    expect(readSessionDestinations(SOURCE, SESSION_A)).toHaveLength(1);
    expect(readSessionDestinations(SOURCE, SESSION_B)).toHaveLength(1);

    const resp = await dispatch(
      {
        id: 'req-remove',
        command: 'destinations-remove',
        args: { agent_group_id: SOURCE, local_name: 'helper' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(readSessionDestinations(SOURCE, SESSION_A)).toEqual([]);
    expect(readSessionDestinations(SOURCE, SESSION_B)).toEqual([]);
  });
});
