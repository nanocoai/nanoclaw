import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb } from '../src/db/connection.js';
import { inspectAgentSession, inspectCentralDb } from './central-db-inspection.js';

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
      lastWiredAt: {},
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
      lastWiredAt: {},
    });

    const inspected = new Database(dbPath, { readonly: true });
    expect(inspected.pragma('journal_mode', { simple: true })).toBe('delete');
    inspected.close();
  });

  it('reports when each channel was last wired, without cli', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const raw = new Database(path.join(projectRoot, 'data', 'v2.db'));
    raw.exec(`
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY, messaging_group_id TEXT, agent_group_id TEXT, created_at TEXT);
      INSERT INTO messaging_groups VALUES ('mg-cli', 'cli'), ('mg-tg', 'telegram'), ('mg-slack', 'slack'), ('mg-tg2', 'telegram');
      INSERT INTO messaging_group_agents VALUES ('w1', 'mg-cli', 'ag-1', '2026-11-03T00:00:00.000Z'),
        ('w2', 'mg-tg', 'ag-1', '2026-11-01T00:00:00.000Z'), ('w3', 'mg-tg2', 'ag-1', '2026-11-02T00:00:00.000Z');
    `);
    raw.close();
    await expect(inspectCentralDb(projectRoot)).resolves.toMatchObject({
      lastWiredAt: { telegram: '2026-11-02T00:00:00.000Z' },
    });
  });

  it('counts only the default adapter instance as wired', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const raw = new Database(path.join(projectRoot, 'data', 'v2.db'));
    raw.exec(`
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT, instance TEXT NOT NULL);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY, messaging_group_id TEXT, agent_group_id TEXT, created_at TEXT);
      INSERT INTO messaging_groups VALUES ('mg-slack-ops', 'slack', 'slack-ops'), ('mg-tg', 'telegram', 'telegram');
      INSERT INTO messaging_group_agents VALUES ('w1', 'mg-slack-ops', 'ag-1', '2026-11-01T00:00:00.000Z'),
        ('w2', 'mg-tg', 'ag-1', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();
    const { lastWiredAt } = await inspectCentralDb(projectRoot);
    expect(Object.keys(lastWiredAt)).toEqual(['telegram']);
  });

  it('finds the newest active session of an agent group by folder', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    expect(await inspectAgentSession(projectRoot, 'ping_test')).toBeNull();
    const raw = new Database(path.join(projectRoot, 'data', 'v2.db'));
    raw.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT, status TEXT, container_status TEXT, created_at TEXT);
      INSERT INTO agent_groups (id, folder) VALUES ('ag-ping', 'ping_test'), ('ag-other', 'other');
      INSERT INTO sessions VALUES ('s-old', 'ag-ping', 'active', 'stopped', '2026-10-16T10:00:00Z');
      INSERT INTO sessions VALUES ('s-new', 'ag-ping', 'active', 'running', '2026-10-16T11:00:00Z');
      INSERT INTO sessions VALUES ('s-closed', 'ag-ping', 'closed', 'running', '2026-10-16T12:00:00Z');
      INSERT INTO sessions VALUES ('s-other', 'ag-other', 'active', 'running', '2026-10-16T13:00:00Z');
    `);
    raw.close();

    await expect(inspectAgentSession(projectRoot, 'ping_test')).resolves.toEqual({
      agentGroupId: 'ag-ping',
      sessionId: 's-new',
      containerStatus: 'running',
    });
    await expect(inspectAgentSession(projectRoot, 'missing')).resolves.toBeNull();
  });
});
