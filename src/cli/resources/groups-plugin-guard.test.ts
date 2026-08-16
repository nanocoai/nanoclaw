/**
 * Plugin-owned MCP servers are template content: the config verbs must refuse
 * to overwrite or delete them (the sanctioned change path is restamping via
 * `groups create --template`), while servers without the marker stay fully
 * editable. Runs through dispatch() with the host caller — the same path an
 * approved agent request replays through.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-cli-plugin-guard';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-cli-plugin-guard/groups',
  DATA_DIR: '/tmp/nanoclaw-test-cli-plugin-guard/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-test-cli-plugin-guard/templates',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { NANOCLAW_EXTENSION_NS } from '../../templates/extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from '../../templates/manifest.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

function writeTemplate(): void {
  const tpl = path.join(TEST_ROOT, 'templates', 'sdr');
  fs.mkdirSync(path.join(tpl, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  fs.writeFileSync(path.join(tpl, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  fs.writeFileSync(
    path.join(tpl, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' } },
    }),
  );
}

async function run(command: string, args: Record<string, unknown>) {
  return dispatch({ id: 'req-1', command, args }, { caller: 'host' });
}

let groupId: string;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  writeTemplate();
  groupId = createAgentFromTemplate('sdr', { name: 'SDR' }).group.id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('plugin-owned MCP server guard (ncl groups config)', () => {
  it('refuses to overwrite a plugin-owned server', async () => {
    const res = await run('groups-config-add-mcp-server', {
      id: groupId,
      name: 'docs',
      url: 'https://evil.example.com/mcp',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/owned by plugin "sdr".*restamp/);
    expect(JSON.parse(getContainerConfig(groupId)!.mcp_servers).docs.url).toBe('https://mcp.example.com/mcp');
  });

  it('refuses to remove a plugin-owned server', async () => {
    const res = await run('groups-config-remove-mcp-server', { id: groupId, name: 'docs' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/owned by plugin "sdr"/);
    expect(JSON.parse(getContainerConfig(groupId)!.mcp_servers).docs).toBeDefined();
  });

  it('leaves unmarked servers fully editable', async () => {
    const added = await run('groups-config-add-mcp-server', {
      id: groupId,
      name: 'mine',
      url: 'https://mine.example.com/mcp',
    });
    expect(added.ok).toBe(true);
    const removed = await run('groups-config-remove-mcp-server', { id: groupId, name: 'mine' });
    expect(removed.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(groupId)!.mcp_servers).mine).toBeUndefined();
  });
});

describe('ncl groups create --template on an already-stamped plugin', () => {
  it('previews the in-place update without --yes and applies with it', async () => {
    fs.writeFileSync(
      path.join(TEST_ROOT, 'templates', 'sdr', NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'),
      'You are an SDR agent v2.\n',
    );

    const dryRun = await run('groups-create', { template: 'sdr' });
    expect(dryRun.ok).toBe(true);
    if (dryRun.ok) {
      expect(dryRun.data).toMatchObject({ applied: false, group: { id: groupId } });
      expect(dryRun.human).toMatch(/DRY RUN/);
      expect(dryRun.human).toMatch(/--new/);
    }

    const applied = await run('groups-create', { template: 'sdr', yes: true });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.data).toMatchObject({ applied: true, group: { id: groupId } });
  });

  it('rejects --folder combined with --template instead of silently ignoring it', async () => {
    const res = await run('groups-create', { template: 'sdr', folder: 'custom-folder' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/--folder applies only to bare creates/);
  });

  it('surfaces the migration error for a pre-plugin template on the CLI path', async () => {
    // Regression: the carriage probe must not die on a raw ENOENT before the
    // reader's friendly error — this is the exact command the [BREAKING]
    // changelog entry points users at.
    const legacy = path.join(TEST_ROOT, 'templates', 'legacy');
    fs.mkdirSync(path.join(legacy, 'context'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'context', 'instructions.md'), 'old layout\n');

    const res = await run('groups-create', { template: 'legacy' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/predates the plugin format/);
  });

  it('stamps a second agent with --new, then requires --id while both exist', async () => {
    const second = await run('groups-create', { template: 'sdr', new: true });
    expect(second.ok).toBe(true);
    const secondId = second.ok ? (second.data as { id: string }).id : '';
    expect(secondId).not.toBe(groupId);

    const ambiguous = await run('groups-create', { template: 'sdr' });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error.message).toMatch(/2 groups already carry this plugin.*--id/s);

    const targeted = await run('groups-create', { template: 'sdr', id: secondId });
    expect(targeted.ok).toBe(true);
    if (targeted.ok) expect(targeted.data).toMatchObject({ applied: false, group: { id: secondId } });
  });
});
