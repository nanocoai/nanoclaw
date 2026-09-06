import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectHostHealth } from './health.js';

describe('collectHostHealth', () => {
  it('reports zero groups and policies as explicit empty resources', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE agent_message_policies (from_agent_group_id TEXT, to_agent_group_id TEXT, approver TEXT, created_at TEXT);
    `);
    const report = collectHostHealth(process.cwd(), db);
    expect(report.status).toBe('healthy');
    expect(report.resources.groups).toEqual({ state: 'empty', count: 0 });
    expect(report.resources.policies).toEqual({ state: 'empty', count: 0 });
    expect(report.process.pid).toBeGreaterThan(0);
    db.close();
  });

  it('counts only skills loaded into per-group session stores', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-health-'));
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE agent_message_policies (from_agent_group_id TEXT, to_agent_group_id TEXT, approver TEXT, created_at TEXT);
    `);

    try {
      fs.mkdirSync(path.join(root, '.claude', 'skills', 'bundled'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, '.claude', 'skills', 'bundled', 'SKILL.md'), '# Bundled');
      const installed = path.join(root, 'data', 'v2-sessions', 'agent-1', '.claude-shared', 'skills', 'installed');
      fs.mkdirSync(installed, { recursive: true });
      fs.writeFileSync(path.join(installed, 'SKILL.md'), '# Installed');

      expect(collectHostHealth(root, db).resources.skills).toEqual({
        state: 'loaded',
        count: 1,
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
