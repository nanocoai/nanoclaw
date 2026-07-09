import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-create-agent-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const TEMPLATES_DIR = path.join(TEST_ROOT, 'templates');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-create-agent-test/groups',
  DATA_DIR: '/tmp/nanoclaw-create-agent-test/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-create-agent-test/templates',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { createAgentFromTemplate } from './create-agent.js';

function writeTemplate(): void {
  const t = path.join(TEMPLATES_DIR, 'sales', 'sdr');
  fs.mkdirSync(path.join(t, 'context', 'additional_context'), { recursive: true });
  fs.writeFileSync(path.join(t, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  fs.writeFileSync(path.join(t, 'context', 'playbook.md'), '# Playbook\n');
  fs.writeFileSync(path.join(t, 'context', 'additional_context', 'faq.md'), '# FAQ\n');
  fs.writeFileSync(
    path.join(t, '.mcp.json'),
    JSON.stringify({ mcpServers: { hubspot: { command: 'npx', args: ['-y', '@hubspot/mcp-server'] } } }),
  );
  const skillDir = path.join(t, 'skills', 'widget');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: widget\n---\n');
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  writeTemplate();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('createAgentFromTemplate', () => {
  it('writes the persona prepend verbatim — no injected context refs, no .seed.md', () => {
    const g = createAgentFromTemplate('sales/sdr', { name: 'SDR Test' });

    const groupDir = path.join(GROUPS_DIR, g.folder);
    const prepend = fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8');
    expect(prepend).toBe('You are an SDR agent.\n');
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
  });

  it('copies template skills into the group-private Claude-plane skills dir', () => {
    const g = createAgentFromTemplate('sales/sdr', { name: 'SDR Skills' });

    const skill = path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'widget', 'SKILL.md');
    expect(fs.existsSync(skill)).toBe(true);
  });

  it('writes MCP servers to the container config and context extras at their template-relative paths', () => {
    const g = createAgentFromTemplate('sales/sdr', { name: 'SDR Mcp' });

    const cfg = getContainerConfig(g.id);
    expect(cfg).toBeTruthy();
    expect(JSON.parse(cfg!.mcp_servers)).toHaveProperty('hubspot');
    // Extras land relative to the group root, exactly as they sit relative to
    // instructions.md in the template — no context/ prefix in between.
    const groupDir = path.join(GROUPS_DIR, g.folder);
    expect(fs.existsSync(path.join(groupDir, 'playbook.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'additional_context', 'faq.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'context'))).toBe(false);
  });
});
