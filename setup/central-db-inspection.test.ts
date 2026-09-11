import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb } from '../src/db/connection.js';
import { inspectCentralDb } from './central-db-inspection.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await closeDb();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-setup-inspection-'));
  tempDirs.push(root);
  return root;
}

describe('setup central-DB inspection', () => {
  it('returns empty state without creating a missing SQLite database', async () => {
    const projectRoot = tempRoot();
    await expect(inspectCentralDb(projectRoot)).resolves.toEqual({
      displayName: null,
      registeredGroups: 0,
      derivedGroups: 0,
    });
    expect(fs.existsSync(path.join(projectRoot, 'data', 'v2.db'))).toBe(false);
  });

  it('reads setup state without changing the SQLite journal mode', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const dbPath = path.join(projectRoot, 'data', 'v2.db');
    const raw = new Database(dbPath);
    raw.pragma('journal_mode = DELETE');
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT);
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL);
      CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, image_tag TEXT);
      INSERT INTO users (id, display_name) VALUES ('cli:local', 'Operator');
      INSERT INTO agent_groups (id) VALUES ('ag-1');
      INSERT INTO messaging_group_agents (id, agent_group_id) VALUES ('mga-1', 'ag-1');
      INSERT INTO container_configs (agent_group_id, image_tag) VALUES ('ag-1', 'derived:test');
    `);
    raw.close();

    await expect(inspectCentralDb(projectRoot)).resolves.toEqual({
      displayName: 'Operator',
      registeredGroups: 1,
      derivedGroups: 1,
    });

    const inspected = new Database(dbPath, { readonly: true });
    expect(inspected.pragma('journal_mode', { simple: true })).toBe('delete');
    inspected.close();
  });
});
