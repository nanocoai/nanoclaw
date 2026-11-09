import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-restamp-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const TEMPLATES_DIR = path.join(TEST_ROOT, 'templates');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-restamp-test/groups',
  DATA_DIR: '/tmp/nanoclaw-restamp-test/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-restamp-test/templates',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { configFromDb, type McpServerConfig } from '../container-config.js';
import { findTaskSessions } from '../db/sessions.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { createScheduledTask, prepareScheduledTask } from '../modules/scheduling/create.js';
import { resumeTask } from '../mailbox/sqlite/tasks.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import type { AgentGroup } from '../types.js';
import { NANOCLAW_EXTENSION_NS } from './extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from './manifest.js';
import { createAgentFromTemplate } from './create-agent.js';
import { restampAgentFromTemplate, type RestampChange } from './restamp.js';

const TPL = path.join(TEMPLATES_DIR, 'sales', 'sdr');

function withInboundDb<T>(agentGroupId: string, sessionId: string, action: (db: Database.Database) => T): T {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  try {
    return action(db);
  } finally {
    db.close();
  }
}

/** The v1 template every test stamps from. */
function writeTemplateV1(): void {
  fs.rmSync(TPL, { recursive: true, force: true });
  fs.mkdirSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'additional_context'), { recursive: true });
  fs.writeFileSync(path.join(TPL, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'playbook.md'), '# Playbook v1\n');
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'additional_context', 'faq.md'), '# FAQ\n');
  fs.writeFileSync(
    path.join(TPL, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        hubspot: { type: 'stdio', command: 'npx', args: ['-y', '@hubspot/mcp-server'] },
        docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      },
    }),
  );
  writeSkill(TPL, 'widget', 'does widget things v1');
  fs.writeFileSync(path.join(TPL, 'TROUBLESHOOTING.md'), '# When things break v1\n');
  writeTask('weekday-briefing', '0 9 * * 1-5', 'Send the weekday briefing.');
}

/** The v2 template: every plugin-owned surface changed, added, or removed. */
function writeTemplateV2(): void {
  fs.rmSync(TPL, { recursive: true, force: true });
  fs.mkdirSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
  fs.writeFileSync(path.join(TPL, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent v2.\n');
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'playbook.md'), '# Playbook v2\n');
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'guide.md'), '# Guide\n');
  fs.writeFileSync(
    path.join(TPL, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        hubspot: { type: 'stdio', command: 'npx', args: ['-y', '@hubspot/mcp-server@2'] },
        search: { type: 'streamable-http', url: 'https://search.example.com/mcp' },
      },
    }),
  );
  writeSkill(TPL, 'widget', 'does widget things v2');
  writeSkill(TPL, 'lookup', 'looks things up');
  fs.writeFileSync(path.join(TPL, 'TROUBLESHOOTING.md'), '# When things break v2\n');
  writeTask('weekday-briefing', '0 8 * * 1-5', 'Send the improved weekday briefing.');
  writeTask('weekly-report', '0 9 * * 1', 'Send the weekly report.');
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

function writeTask(name: string, schedule: string, prompt: string): void {
  const dir = path.join(TPL, NANOCLAW_EXTENSION_NS, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nschedule: "${schedule}"\n---\n\n${prompt}\n`);
}

async function servers(groupId: string): Promise<Record<string, McpServerConfig>> {
  return JSON.parse((await getContainerConfig(groupId))!.mcp_servers) as Record<string, McpServerConfig>;
}

async function liveTasks(
  groupId: string,
): Promise<Array<{ series_id: string; status: string; recurrence: string; prompt: string }>> {
  const rows: Array<{ series_id: string; status: string; recurrence: string; prompt: string }> = [];
  for (const session of await findTaskSessions(groupId)) {
    const db = new Database(inboundDbPath(groupId, session.id), { readonly: true });
    for (const row of db
      .prepare(
        "SELECT series_id, status, recurrence, content FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')",
      )
      .all() as Array<{ series_id: string; status: string; recurrence: string; content: string }>) {
      rows.push({ ...row, prompt: (JSON.parse(row.content) as { prompt: string }).prompt });
    }
    db.close();
  }
  return rows;
}

/** Every task series id in the group, across all rows regardless of status. */
async function allTaskSeries(groupId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const session of await findTaskSessions(groupId)) {
    const db = new Database(inboundDbPath(groupId, session.id), { readonly: true });
    for (const row of db.prepare("SELECT DISTINCT series_id FROM messages_in WHERE kind = 'task'").all() as Array<{
      series_id: string;
    }>) {
      ids.add(row.series_id);
    }
    db.close();
  }
  return [...ids];
}

function change(changes: RestampChange[], surface: RestampChange['surface'], name: string): RestampChange {
  const found = changes.find((c) => c.surface === surface && c.name === name);
  expect(found, `${surface}/${name} missing from plan`).toBeDefined();
  return found!;
}

async function stamp(): Promise<AgentGroup> {
  return (await createAgentFromTemplate('sales/sdr', { name: 'SDR' })).group;
}

const overlaySkill = (groupId: string, skill: string): string =>
  path.join(DATA_DIR, 'v2-sessions', groupId, '.claude-shared', 'skills', skill, 'SKILL.md');

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  writeTemplateV1();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('plugin ownership marker', () => {
  it('stamps the plugin marker on every server and pluginRoot on stdio only', async () => {
    const g = await stamp();
    const s = await servers(g.id);
    expect(s.hubspot).toMatchObject({ plugin: 'sdr', pluginRoot: '/workspace/agent/plugins/sdr' });
    expect(s.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' });
  });

  it('never ships the marker to the container config', async () => {
    const g = await stamp();
    const config = configFromDb((await getContainerConfig(g.id))!, g);
    expect(config.mcpServers.hubspot).not.toHaveProperty('plugin');
    expect(config.mcpServers.hubspot).toHaveProperty('pluginRoot');
    expect(config.mcpServers.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp' });
  });
});

describe('restampAgentFromTemplate', () => {
  it('throws when the group does not carry the plugin', async () => {
    const g: AgentGroup = {
      id: 'ag-bare',
      name: 'Bare',
      folder: 'bare',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    await createAgentGroup(g);
    await ensureContainerConfig(g.id);
    await expect(restampAgentFromTemplate('sales/sdr', g.id, { apply: false })).rejects.toThrow(
      /does not carry plugin "sdr"/,
    );
  });

  it('reports all-unchanged when the template did not change', async () => {
    const g = await stamp();
    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });
    expect(result.changes.every((c) => c.action === 'unchanged')).toBe(true);
    expect(result.note).toMatch(/Nothing to apply/);
  });

  it('treats an exec-bit-only template change as an update', async () => {
    // The copier preserves the executable bit, so a chmod-only revision must
    // ship on restamp instead of comparing as byte-identical.
    const g = await stamp();
    fs.chmodSync(path.join(TPL, 'plugin.json'), 0o755);
    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: false });
    expect(result.changes.find((c) => c.surface === 'plugin')?.action).toBe('update');
  });

  it('recreates a missing ${PLUGIN_DATA} cwd dir even when plugin files are unchanged', async () => {
    // The adoption path: same template ref, but the dir is absent (an older
    // engine skipped cwd servers at stamp time, or the agent deleted it).
    // plugin-data scaffold must heal without a plugin-file diff.
    fs.writeFileSync(
      path.join(TPL, 'mcp.json'),
      JSON.stringify({
        $schema: MCP_SCHEMA_URL,
        mcpServers: { hubspot: { type: 'stdio', command: 'npx', cwd: '${PLUGIN_DATA}/state' } },
      }),
    );
    const g = await stamp();
    const stateDir = path.join(GROUPS_DIR, g.folder, 'plugin-data', 'sdr', 'state');
    fs.rmSync(stateDir, { recursive: true });

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(result.changes.find((c) => c.surface === 'plugin')?.action).toBe('unchanged');
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it('dry run reports every change but mutates nothing', async () => {
    const g = await stamp();
    const groupDir = path.join(GROUPS_DIR, g.folder);
    writeTemplateV2();

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: false });

    expect(result.applied).toBe(false);
    expect(change(result.changes, 'persona', PERSONA_PREPEND_FILE).action).toBe('update');
    expect(change(result.changes, 'context', 'playbook.md').action).toBe('update');
    expect(change(result.changes, 'context', 'additional_context/faq.md').action).toBe('remove');
    expect(change(result.changes, 'context', 'guide.md').action).toBe('create');
    expect(change(result.changes, 'skill', 'widget').action).toBe('update');
    expect(change(result.changes, 'skill', 'lookup').action).toBe('create');
    expect(change(result.changes, 'mcp-server', 'hubspot').action).toBe('update');
    expect(change(result.changes, 'mcp-server', 'docs').action).toBe('remove');
    expect(change(result.changes, 'mcp-server', 'search').action).toBe('create');
    expect(change(result.changes, 'task', 'weekday-briefing').action).toBe('update');
    expect(change(result.changes, 'task', 'weekly-report').action).toBe('create');

    // Nothing moved: files, config, and tasks are still v1.
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are an SDR agent.\n');
    expect(fs.existsSync(path.join(groupDir, 'additional_context', 'faq.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'guide.md'))).toBe(false);
    expect((await servers(g.id)).docs).toBeDefined();
    expect((await servers(g.id)).search).toBeUndefined();
    expect(await liveTasks(g.id)).toHaveLength(1);
    expect(fs.readFileSync(path.join(groupDir, 'plugins', 'sdr', 'TROUBLESHOOTING.md'), 'utf-8')).toContain('v1');
  });

  it('applies the full update across every plugin-owned surface', async () => {
    const g = await stamp();
    const groupDir = path.join(GROUPS_DIR, g.folder);
    // Operator state that must survive: a user-added server, a workspace file,
    // an agent-authored overlay skill, plugin-data content, a resumed task.
    await updateContainerConfigJson(g.id, 'mcp_servers', {
      ...(await servers(g.id)),
      mine: { type: 'http', url: 'https://mine.example.com/mcp' },
    });
    fs.writeFileSync(path.join(groupDir, 'notes.md'), 'agent notes\n');
    fs.mkdirSync(path.dirname(overlaySkill(g.id, 'own')), { recursive: true });
    fs.writeFileSync(overlaySkill(g.id, 'own'), '---\nname: own\ndescription: agent made\n---\n');
    fs.writeFileSync(path.join(groupDir, 'plugin-data', 'sdr', 'state.json'), '{"seen": 3}\n');
    const series = (await liveTasks(g.id))[0].series_id;
    for (const session of await findTaskSessions(g.id)) {
      withInboundDb(g.id, session.id, (db) => resumeTask(db, series));
    }
    writeTemplateV2();

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(result.applied).toBe(true);
    expect(result.note).toMatch(/groups restart/);
    // Plugin dir replaced wholesale.
    expect(fs.readFileSync(path.join(groupDir, 'plugins', 'sdr', 'TROUBLESHOOTING.md'), 'utf-8')).toContain('v2');
    // Persona + context reset to the template.
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are an SDR agent v2.\n');
    expect(fs.readFileSync(path.join(groupDir, 'playbook.md'), 'utf-8')).toBe('# Playbook v2\n');
    expect(fs.existsSync(path.join(groupDir, 'additional_context', 'faq.md'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, 'guide.md'), 'utf-8')).toBe('# Guide\n');
    // Skills overlay refreshed; agent-authored skill untouched.
    expect(fs.readFileSync(overlaySkill(g.id, 'widget'), 'utf-8')).toContain('v2');
    expect(fs.existsSync(overlaySkill(g.id, 'lookup'))).toBe(true);
    expect(fs.existsSync(overlaySkill(g.id, 'own'))).toBe(true);
    // MCP: plugin set swapped, user server untouched.
    const s = await servers(g.id);
    expect(s.hubspot).toMatchObject({ args: ['-y', '@hubspot/mcp-server@2'], plugin: 'sdr' });
    expect(s.docs).toBeUndefined();
    expect(s.search).toMatchObject({ type: 'http', plugin: 'sdr' });
    expect(s.mine).toEqual({ type: 'http', url: 'https://mine.example.com/mcp' });
    // Operator files survive.
    expect(fs.readFileSync(path.join(groupDir, 'notes.md'), 'utf-8')).toBe('agent notes\n');
    expect(fs.readFileSync(path.join(groupDir, 'plugin-data', 'sdr', 'state.json'), 'utf-8')).toBe('{"seen": 3}\n');
    // Tasks: definition updated in place, resumed status kept; new task paused.
    const tasks = await liveTasks(g.id);
    const briefing = tasks.find((t) => t.series_id === series)!;
    expect(briefing.status).toBe('pending');
    expect(briefing.recurrence).toBe('0 8 * * 1-5');
    expect(briefing.prompt).toBe('Send the improved weekday briefing.');
    const report = tasks.find((t) => t.series_id.startsWith('weekly-report-'))!;
    expect(report.status).toBe('paused');
  });

  it('flags locally customized files and resets them on apply', async () => {
    const g = await stamp();
    const groupDir = path.join(GROUPS_DIR, g.folder);
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'My hand-tuned persona.\n');
    fs.writeFileSync(path.join(groupDir, 'playbook.md'), '# My playbook\n');
    fs.writeFileSync(overlaySkill(g.id, 'widget'), '---\nname: widget\ndescription: my tweak\n---\n');
    writeTemplateV2();

    const plan = await restampAgentFromTemplate('sales/sdr', g.id, { apply: false });
    expect(change(plan.changes, 'persona', PERSONA_PREPEND_FILE).customized).toBe(true);
    expect(change(plan.changes, 'context', 'playbook.md').customized).toBe(true);
    expect(change(plan.changes, 'skill', 'widget').customized).toBe(true);
    // Unmodified surfaces are not flagged.
    expect(change(plan.changes, 'context', 'guide.md').customized).toBeUndefined();

    await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are an SDR agent v2.\n');
    expect(fs.readFileSync(path.join(groupDir, 'playbook.md'), 'utf-8')).toBe('# Playbook v2\n');
    expect(fs.readFileSync(overlaySkill(g.id, 'widget'), 'utf-8')).toContain('v2');
  });

  it('never clobbers a user-added server whose name a new plugin server takes', async () => {
    const g = await stamp();
    await updateContainerConfigJson(g.id, 'mcp_servers', {
      ...(await servers(g.id)),
      search: { type: 'http', url: 'https://mine.example.com/mcp' },
    });
    writeTemplateV2();

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(change(result.changes, 'mcp-server', 'search').action).toBe('skip');
    expect((await servers(g.id)).search).toEqual({ type: 'http', url: 'https://mine.example.com/mcp' });
  });

  it('neutralizes planted file symlinks instead of writing through them', async () => {
    const g = await stamp();
    const groupDir = path.join(GROUPS_DIR, g.folder);
    const victim = path.join(TEST_ROOT, 'victim.txt');
    fs.writeFileSync(victim, 'precious\n');
    fs.rmSync(path.join(groupDir, PERSONA_PREPEND_FILE));
    fs.symlinkSync(victim, path.join(groupDir, PERSONA_PREPEND_FILE));
    fs.rmSync(path.join(groupDir, 'playbook.md'));
    fs.symlinkSync(victim, path.join(groupDir, 'playbook.md'));
    writeTemplateV2();

    await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious\n');
    expect(fs.lstatSync(path.join(groupDir, PERSONA_PREPEND_FILE)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are an SDR agent v2.\n');
    expect(fs.readFileSync(path.join(groupDir, 'playbook.md'), 'utf-8')).toBe('# Playbook v2\n');
  });

  it('refuses to write context through a symlinked directory', async () => {
    const g = await stamp();
    const groupDir = path.join(GROUPS_DIR, g.folder);
    const outside = path.join(TEST_ROOT, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(path.join(groupDir, 'additional_context'), { recursive: true });
    fs.symlinkSync(outside, path.join(groupDir, 'additional_context'));
    writeTemplateV2();
    // v2 keeps a file under additional_context/ so the write op fires.
    const extraDir = path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'additional_context');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, 'faq.md'), '# FAQ v2\n');

    await expect(restampAgentFromTemplate('sales/sdr', g.id, { apply: true })).rejects.toThrow(/resolves outside/);
    expect(fs.existsSync(path.join(outside, 'faq.md'))).toBe(false);
  });

  it('refuses to write skills through a symlinked overlay root', async () => {
    const g = await stamp();
    const outside = path.join(TEST_ROOT, 'outside-skills');
    fs.mkdirSync(outside, { recursive: true });
    const overlayRoot = path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills');
    fs.rmSync(overlayRoot, { recursive: true });
    fs.symlinkSync(outside, overlayRoot);
    writeTemplateV2();

    await expect(restampAgentFromTemplate('sales/sdr', g.id, { apply: true })).rejects.toThrow(/resolves outside/);
    expect(fs.existsSync(path.join(outside, 'widget'))).toBe(false);
  });

  it('plans over a dangling symlink in the overlay without crashing', async () => {
    const g = await stamp();
    fs.symlinkSync(
      '/nonexistent-target',
      path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'widget', 'ghost'),
    );

    const plan = await restampAgentFromTemplate('sales/sdr', g.id, { apply: false });
    expect(change(plan.changes, 'skill', 'widget').action).toBe('unchanged');
  });

  it('skips instead of duplicating a series that is re-arming between runs', async () => {
    const g = await stamp();
    const series = (await liveTasks(g.id))[0].series_id;
    // Simulate the ≤60s window: the run completed, the sweep has not re-armed
    // the next occurrence yet (recurrence still set on the completed row).
    for (const session of await findTaskSessions(g.id)) {
      withInboundDb(g.id, session.id, (db) =>
        db.prepare("UPDATE messages_in SET status = 'completed' WHERE series_id = ?").run(series),
      );
    }
    writeTemplateV2();

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    const row = change(result.changes, 'task', 'weekday-briefing');
    expect(row.action).toBe('skip');
    expect(row.note).toMatch(/re-arming/);
    // No duplicate series was created for the briefing; the new template task was.
    const seriesIds = (await allTaskSeries(g.id)).filter((id) => id.startsWith('weekday-briefing-'));
    expect(seriesIds).toEqual([series]);
    expect((await liveTasks(g.id)).some((t) => t.series_id.startsWith('weekly-report-'))).toBe(true);
  });

  it('deletes a dropped series even while it is re-arming', async () => {
    const g = await stamp();
    const series = (await liveTasks(g.id))[0].series_id;
    for (const session of await findTaskSessions(g.id)) {
      withInboundDb(g.id, session.id, (db) =>
        db.prepare("UPDATE messages_in SET status = 'completed' WHERE series_id = ?").run(series),
      );
    }
    writeTemplateV2();
    fs.rmSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'tasks'), { recursive: true });

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(change(result.changes, 'task', 'weekday-briefing').action).toBe('remove');
    expect(await allTaskSeries(g.id)).toEqual([]);
  });

  it('updates the stamped series, not a newer user task with the same name', async () => {
    const g = await stamp();
    const stamped = (await liveTasks(g.id))[0].series_id;
    const prepared = prepareScheduledTask({
      name: 'weekday-briefing',
      prompt: 'My own briefing.',
      recurrence: '0 12 * * 1-5',
      timezone: 'UTC',
    });
    const mine = (await createScheduledTask(g.id, prepared, { status: 'pending' })).row.seriesId!;
    writeTemplateV2();

    await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    const tasks = await liveTasks(g.id);
    expect(tasks.find((t) => t.series_id === mine)!.prompt).toBe('My own briefing.');
    expect(tasks.find((t) => t.series_id === stamped)!.prompt).toBe('Send the improved weekday briefing.');
  });

  it('treats a rename that preserves the slug as an update, never remove+create', async () => {
    const g = await stamp();
    const series = (await liveTasks(g.id))[0].series_id;
    writeTemplateV2();
    fs.rmSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'tasks'), { recursive: true });
    // Same slug as v1's weekday-briefing, different name casing.
    writeTask('Weekday-Briefing', '0 8 * * 1-5', 'Renamed but same series.');

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(result.changes.filter((c) => c.surface === 'task' && c.action === 'remove')).toEqual([]);
    const tasks = await liveTasks(g.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].series_id).toBe(series);
    expect(tasks[0].prompt).toBe('Renamed but same series.');
  });

  it('rejects a template whose task names collide on the truncated id slug', async () => {
    const g = await stamp();
    writeTask('a'.repeat(30), '0 9 * * *', 'One.');
    writeTask('a'.repeat(31), '0 9 * * *', 'Two.');

    await expect(restampAgentFromTemplate('sales/sdr', g.id, { apply: false })).rejects.toThrow(/collide on id slug/);
  });

  it('removes a skill and deletes a task series the new template dropped', async () => {
    const g = await stamp();
    writeTemplateV2();
    // v3 = v2 without the widget skill and without any tasks.
    fs.rmSync(path.join(TPL, 'skills', 'widget'), { recursive: true });
    fs.rmSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'tasks'), { recursive: true });

    const result = await restampAgentFromTemplate('sales/sdr', g.id, { apply: true });

    expect(change(result.changes, 'skill', 'widget').action).toBe('remove');
    expect(change(result.changes, 'task', 'weekday-briefing').action).toBe('remove');
    expect(fs.existsSync(overlaySkill(g.id, 'widget'))).toBe(false);
    expect(await liveTasks(g.id)).toHaveLength(0);
  });
});
