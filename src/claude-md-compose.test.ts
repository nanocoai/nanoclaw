import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Override GROUPS_DIR so composition writes into a throwaway dir, not the repo.
// Literal duplicated below (vi.mock is hoisted above const initialization).
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-compose/groups' };
});

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { initTestDb, closeDb, runMigrations } from './db/index.js';
import type { AgentGroup } from './types.js';

const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-compose/groups';

const group: AgentGroup = {
  id: 'ag-test',
  name: 'Test Agent',
  folder: 'test-group',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
});

describe('composeGroupClaudeMd', () => {
  it('imports CLAUDE.local.md so per-group memory reaches the agent', () => {
    composeGroupClaudeMd(group);

    const composed = fs.readFileSync(path.join(TEST_GROUPS_DIR, group.folder, 'CLAUDE.md'), 'utf8');

    expect(composed).toContain('@./CLAUDE.local.md');
  });
});
