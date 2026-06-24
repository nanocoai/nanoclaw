/**
 * Tests for composeGroupClaudeMd — verifies the composed CLAUDE.md
 * imports the right things, and notably auto-imports per-group
 * `CLAUDE.role.md` when the operator (or a port skill) has written one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { AgentGroup } from './types.js';

const TEST_ROOT = path.join(os.tmpdir(), 'nanoclaw-test-compose');
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: TEST_GROUPS_DIR };
});

vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: () => ({ mcp_servers: '{}', cli_scope: 'group' }),
}));

const { composeGroupClaudeMd } = await import('./claude-md-compose.js');

const GROUP: AgentGroup = {
  id: 'ag-test',
  name: 'Test',
  folder: 'test-group',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function readComposed(): string {
  return fs.readFileSync(path.join(TEST_GROUPS_DIR, GROUP.folder, 'CLAUDE.md'), 'utf-8');
}

describe('composeGroupClaudeMd CLAUDE.role.md auto-import', () => {
  it('does NOT add @./CLAUDE.role.md when the file is missing', () => {
    composeGroupClaudeMd(GROUP);
    expect(readComposed()).not.toContain('@./CLAUDE.role.md');
  });

  it('adds @./CLAUDE.role.md when the file exists', () => {
    const groupDir = path.join(TEST_GROUPS_DIR, GROUP.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.role.md'), '# Role\nYou are Test.\n');

    composeGroupClaudeMd(GROUP);
    expect(readComposed()).toContain('@./CLAUDE.role.md');
  });

  it('imports role.md after the shared base and after fragments', () => {
    const groupDir = path.join(TEST_GROUPS_DIR, GROUP.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.role.md'), '# Role\n');

    composeGroupClaudeMd(GROUP);
    const body = readComposed();
    const sharedIdx = body.indexOf('@./.claude-shared.md');
    const roleIdx = body.indexOf('@./CLAUDE.role.md');
    expect(sharedIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeGreaterThan(sharedIdx);
  });

  it('is idempotent — re-running with role.md already present produces the same body', () => {
    const groupDir = path.join(TEST_GROUPS_DIR, GROUP.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.role.md'), '# Role\n');

    composeGroupClaudeMd(GROUP);
    const first = readComposed();
    composeGroupClaudeMd(GROUP);
    const second = readComposed();
    expect(second).toBe(first);
  });
});
