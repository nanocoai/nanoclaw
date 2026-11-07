/**
 * The 32KB Codex project-doc cap must DEGRADE, never throw: composeGroupAgentsMd
 * runs inside the provider contribution at every spawn, and a throw there rides
 * wakeContainer's transient-retry contract — host-sweep respawns every 60s
 * forever and the group goes silently dark (a permanent condition disguised as
 * a transient one). Oversized docs drop their largest optional instruction
 * sections, keep the core contract, and say so in the doc.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-agents-md-test/data',
}));

import { composeGroupAgentsMd, CODEX_PROJECT_DOC_MAX_BYTES } from './codex-agents-md.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import type { AgentGroup } from '../types.js';

const TEST_ROOT = '/tmp/nanoclaw-agents-md-test';

// This module is the pre-contract compatibility path: on a contract core the
// canonical template composes AGENTS.md and this spec is never consulted, so
// its cap-handling guards only apply where the legacy path is live.
const legacyIt = fs.existsSync(path.join(process.cwd(), 'src/provider-contracts/realize.ts')) ? it.skip : it;

function group(folder: string): AgentGroup {
  return {
    id: `ag-${folder}`,
    name: folder,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as AgentGroup;
}

describe('composeGroupAgentsMd cap handling', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  });

  legacyIt('writes the doc untouched when under the cap', async () => {
    const g = group('small');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      await composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).not.toContain('Omitted for size');
      // Agent-authored skills must be told a home that is BOTH persistent and
      // codex-discovered (~/.codex/skills). /workspace/agent/skills is not
      // scanned by codex, so authored skills there never trigger.
      expect(doc).toContain('~/.codex/skills');
      expect(doc).toContain('linked memory files');
      expect(doc).not.toContain('memories, data');
      expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  legacyIt('never reads or inlines the host memory index', async () => {
    const g = group('with-memory');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      const sentinel = path.join(TEST_ROOT, 'host-secret');
      fs.writeFileSync(sentinel, 'must not enter AGENTS.md\n');
      fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
      fs.symlinkSync(sentinel, path.join(groupDir, 'memory', 'index.md'));

      await composeGroupAgentsMd(g, groupDir);

      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('supplied by NanoClaw at session startup');
      expect(doc).not.toContain('must not enter AGENTS.md');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  legacyIt('degrades instead of throwing when MCP instructions push the doc over the cap', async () => {
    const g = group('oversized');
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    await updateContainerConfigJson(g.id, 'mcp_servers', {
      bloated: { command: 'x', instructions: 'y'.repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1024) },
      lean: { command: 'x', instructions: 'short and useful' },
    });
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      await composeGroupAgentsMd(g, groupDir); // must not throw

      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
      // Largest optional section dropped, named in the doc; the rest survive.
      expect(doc).toContain('Omitted for size');
      expect(doc).toContain('MCP Server: bloated');
      expect(doc).toContain('short and useful');
      expect(doc).toContain('Memory System');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});

// The persona rules (leads the document, never evicted, absent without a
// prepend file) belong to the shared composer and are pinned in trunk's
// src/project-doc-compose.test.ts. Re-asserting them here would pin trunk
// behavior from a branch that cannot be edited in the same change.
