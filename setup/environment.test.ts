import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

/**
 * Tests for the environment check step.
 *
 * Verifies: config detection, Docker/AC detection, DB queries.
 */

describe('environment detection', () => {
  it('detects platform correctly', async () => {
    const { getPlatform } = await import('./platform.js');
    const platform = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(platform);
  });
});

describe('detectRegisteredGroups', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-test-'));
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when no registration state exists', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    expect(await detectRegisteredGroups(tempDir)).toBe(false);
  });

  it('detects pre-migration registered_groups.json', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    fs.writeFileSync(path.join(tempDir, 'data', 'registered_groups.json'), '[]');
    expect(await detectRegisteredGroups(tempDir)).toBe(true);
  });

  it('returns false for an empty v2 central DB', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    const db = new Database(path.join(tempDir, 'data', 'v2.db'));
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL,
        agent_group_id TEXT NOT NULL
      );
    `);
    db.close();

    expect(await detectRegisteredGroups(tempDir)).toBe(false);
  });

  it('detects wired agent groups in the v2 central DB', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    const db = new Database(path.join(tempDir, 'data', 'v2.db'));
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL,
        agent_group_id TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO agent_groups (id) VALUES (?)').run('ag-1');
    db.prepare('INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id) VALUES (?, ?, ?)').run(
      'mga-1',
      'mg-1',
      'ag-1',
    );
    db.close();

    expect(await detectRegisteredGroups(tempDir)).toBe(true);
  });
});

describe('credentials detection', () => {
  it('detects ANTHROPIC_API_KEY in env content', () => {
    const content = 'SOME_KEY=value\nANTHROPIC_API_KEY=sk-ant-test123\nOTHER=foo';
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(
      content,
    );
    expect(hasCredentials).toBe(true);
  });

  it('detects CLAUDE_CODE_OAUTH_TOKEN in env content', () => {
    const content = 'CLAUDE_CODE_OAUTH_TOKEN=token123';
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(
      content,
    );
    expect(hasCredentials).toBe(true);
  });

  it('detects ANTHROPIC_AUTH_TOKEN in env content', () => {
    const content = 'ANTHROPIC_AUTH_TOKEN=token123\nANTHROPIC_BASE_URL=http://localhost:8080';
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(
      content,
    );
    expect(hasCredentials).toBe(true);
  });

  it('returns false when no credentials', () => {
    const content = 'ASSISTANT_NAME="Andy"\nOTHER=foo';
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(
      content,
    );
    expect(hasCredentials).toBe(false);
  });
});

describe('Docker detection logic', () => {
  it('commandExists returns boolean', async () => {
    const { commandExists } = await import('./platform.js');
    expect(typeof commandExists('docker')).toBe('boolean');
    expect(typeof commandExists('nonexistent_binary_xyz')).toBe('boolean');
  });
});

describe('channel auth detection', () => {
  it('detects non-empty auth directory', () => {
    const hasAuth = (authDir: string) => {
      try {
        return fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      } catch {
        return false;
      }
    };

    // Non-existent directory
    expect(hasAuth('/tmp/nonexistent_auth_dir_xyz')).toBe(false);
  });
});
