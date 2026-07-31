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
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import type { AgentGroup } from '../types.js';

const TEST_ROOT = '/tmp/nanoclaw-agents-md-test';

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
  beforeEach(() => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  });

  it('writes the doc untouched when under the cap', () => {
    const g = group('small');
    createAgentGroup(g);
    ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      composeGroupAgentsMd(g, groupDir);
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

  it('never reads or inlines the host memory index', () => {
    const g = group('with-memory');
    createAgentGroup(g);
    ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      const sentinel = path.join(TEST_ROOT, 'host-secret');
      fs.writeFileSync(sentinel, 'must not enter AGENTS.md\n');
      fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
      fs.symlinkSync(sentinel, path.join(groupDir, 'memory', 'index.md'));

      composeGroupAgentsMd(g, groupDir);

      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('supplied by NanoClaw at session startup');
      expect(doc).not.toContain('must not enter AGENTS.md');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('degrades instead of throwing when MCP instructions push the doc over the cap', () => {
    const g = group('oversized');
    createAgentGroup(g);
    ensureContainerConfig(g.id);
    updateContainerConfigJson(g.id, 'mcp_servers', {
      bloated: { command: 'x', instructions: 'y'.repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1024) },
      lean: { command: 'x', instructions: 'short and useful' },
    });
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      composeGroupAgentsMd(g, groupDir); // must not throw

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

describe('composeGroupAgentsMd persona', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  });

  it('inlines the persona as the first section, before the runtime contract', () => {
    const g = group('persona');
    createAgentGroup(g);
    ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'You are an SDR agent.\n');
      composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).toContain('You are an SDR agent.');
      // First markdown heading (the HEADER is an HTML comment, not a `# ` heading).
      const firstHeading = doc.split('\n').find((line) => line.startsWith('# '));
      expect(firstHeading).toBe('# Persona');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('never evicts the persona even when the doc exceeds the cap', () => {
    const g = group('persona-big');
    createAgentGroup(g);
    ensureContainerConfig(g.id);
    updateContainerConfigJson(g.id, 'mcp_servers', {
      bloat: { command: 'x', instructions: 'B'.repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1024) },
    });
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'PERSONA_MARKER body');
      composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(CODEX_PROJECT_DOC_MAX_BYTES);
      expect(doc).toContain('PERSONA_MARKER'); // survived eviction
      expect(doc).toContain('Omitted for size');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  it('omits the persona section when no prepend file is present', () => {
    const g = group('no-persona');
    createAgentGroup(g);
    ensureContainerConfig(g.id);
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    try {
      composeGroupAgentsMd(g, groupDir);
      const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
      expect(doc).not.toContain('# Persona');
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});
