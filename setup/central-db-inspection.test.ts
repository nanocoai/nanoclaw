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
      owners: 0,
      approvers: 0,
      wiredChannels: [],
      droppedChannels: [],
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
      owners: 0,
      approvers: 0,
      wiredChannels: [],
      droppedChannels: [],
    });

    const inspected = new Database(dbPath, { readonly: true });
    expect(inspected.pragma('journal_mode', { simple: true })).toBe('delete');
    inspected.close();
  });

  it('reports owners, wired channels and chats that are dropped while unwired', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const raw = new Database(path.join(projectRoot, 'data', 'v2.db'));
    raw.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT, denied_at TEXT);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY, messaging_group_id TEXT, agent_group_id TEXT);
      CREATE TABLE user_roles (user_id TEXT, role TEXT, agent_group_id TEXT);
      CREATE TABLE unregistered_senders (channel_type TEXT, platform_id TEXT, reason TEXT, messaging_group_id TEXT);
      INSERT INTO agent_groups VALUES ('ag-1', 'Alpha'), ('ag-2', 'Zulu');
      INSERT INTO messaging_groups VALUES ('mg-cli', 'cli', NULL), ('mg-tg', 'telegram', NULL),
        ('mg-slack', 'slack', NULL), ('mg-discord-denied', 'discord', '2026-10-20T00:00:00Z'),
        ('mg-cli-drop', 'cli', NULL), ('mg-tg-stranger', 'telegram', NULL);
      INSERT INTO messaging_group_agents VALUES ('w1', 'mg-cli', 'ag-1'), ('w2', 'mg-tg', 'ag-1');
      INSERT INTO unregistered_senders VALUES ('slack', 'slack:D1', 'no_agent_wired', 'mg-slack'),
        ('discord', 'discord:1', 'no_agent_wired', 'mg-discord-denied'), ('cli', 'cli:x', 'no_agent_wired', 'mg-cli-drop'),
        ('telegram', 'telegram:9', 'no_agent_wired', 'mg-tg-stranger'), ('telegram', 'telegram:1', 'no_agent_engaged', 'mg-tg');
      -- Channel approval asks about the first group by name, so only U2 counts.
      INSERT INTO user_roles VALUES ('slack:U1', 'admin', 'ag-2'), ('slack:U2', 'admin', 'ag-1');
    `);
    raw.close();

    await expect(inspectCentralDb(projectRoot)).resolves.toMatchObject({
      registeredGroups: 1,
      owners: 0,
      approvers: 1,
      wiredChannels: ['telegram'],
      droppedChannels: ['slack', 'telegram'],
    });
  });

  it('an admin scoped to a group channel approval never asks about is no approver', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const raw = new Database(path.join(projectRoot, 'data', 'v2.db'));
    raw.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE user_roles (user_id TEXT, role TEXT, agent_group_id TEXT);
      INSERT INTO agent_groups VALUES ('ag-1', 'Alpha'), ('ag-2', 'Zulu');
      INSERT INTO user_roles VALUES ('slack:U1', 'admin', 'ag-2');
    `);
    raw.close();
    await expect(inspectCentralDb(projectRoot)).resolves.toMatchObject({ owners: 0, approvers: 0 });
  });

  it('reads a database that predates denied chats without failing setup', async () => {
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const raw = new Database(path.join(projectRoot, 'data', 'v2.db'));
    raw.exec(`
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY, messaging_group_id TEXT, agent_group_id TEXT);
      CREATE TABLE unregistered_senders (channel_type TEXT, platform_id TEXT, reason TEXT, messaging_group_id TEXT);
      INSERT INTO messaging_groups VALUES ('mg-slack', 'slack');
      INSERT INTO unregistered_senders VALUES ('slack', 'slack:D1', 'no_agent_wired', 'mg-slack');
    `);
    raw.close();
    await expect(inspectCentralDb(projectRoot)).resolves.toMatchObject({ droppedChannels: [] });
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
