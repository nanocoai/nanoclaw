import Database from 'better-sqlite3';
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

import { closeDb, getAllAgentGroups, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { findTaskSessions } from '../db/sessions.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { inboundDbPath } from '../session-manager.js';
import { NANOCLAW_EXTENSION_NS } from './extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from './manifest.js';
import { createAgentFromTemplate } from './create-agent.js';

const TPL = path.join(TEMPLATES_DIR, 'sales', 'sdr');

function writeTemplate(manifestExtras: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'additional_context'), { recursive: true });
  fs.writeFileSync(
    path.join(TPL, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr', ...manifestExtras }),
  );
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'playbook.md'), '# Playbook\n');
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'additional_context', 'faq.md'), '# FAQ\n');
  fs.writeFileSync(
    path.join(TPL, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        hubspot: { type: 'stdio', command: 'npx', args: ['-y', '@hubspot/mcp-server'], cwd: '${PLUGIN_DATA}/state' },
        search: { type: 'stdio', command: './bin/search' },
        docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      },
    }),
  );
  const skillDir = path.join(TPL, 'skills', 'widget');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: widget\ndescription: does widget things\n---\n');
  fs.writeFileSync(path.join(TPL, 'TROUBLESHOOTING.md'), '# When things break\n');
}

function writeTask(name: string, schedule: string, prompt: string, script?: string): void {
  const dir = path.join(TPL, NANOCLAW_EXTENSION_NS, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const scriptBlock = script
    ? `script: |\n${script
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}\n`
    : '';
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nschedule: "${schedule}"\n${scriptBlock}---\n\n${prompt}\n`);
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
    const { group: g, report } = createAgentFromTemplate('sales/sdr', { name: 'SDR Test' });

    const groupDir = path.join(GROUPS_DIR, g.folder);
    const prepend = fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8');
    expect(prepend).toBe('You are an SDR agent.\n');
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
    expect(report).toEqual([]);
    // Every creation path prefixes ids with ag-; ag- consumers (uninstaller
    // classification, dashboard session filters) rely on it.
    expect(g.id).toMatch(/^ag-/);
  });

  it('copies template skills into the group-private Claude-plane skills dir', () => {
    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR Skills' });

    const skill = path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'widget', 'SKILL.md');
    expect(fs.existsSync(skill)).toBe(true);
  });

  it('copies the whole plugin into plugins/<name> and provisions plugin-data/<name>', () => {
    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR Plugin Copy' });

    const pluginDir = path.join(GROUPS_DIR, g.folder, 'plugins', 'sdr');
    // The whole-plugin copy fixes the broken-sibling-reference class of bugs:
    // files outside skills/ and the extension dir (e.g. TROUBLESHOOTING.md)
    // now exist next to the skills that reference them.
    expect(fs.existsSync(path.join(pluginDir, 'TROUBLESHOOTING.md'))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, 'skills', 'widget', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(GROUPS_DIR, g.folder, 'plugin-data', 'sdr'))).toBe(true);
    // hubspot declares cwd ${PLUGIN_DATA}/state: the stamp pre-creates it so
    // the server's first launch doesn't die on a missing directory.
    expect(fs.existsSync(path.join(GROUPS_DIR, g.folder, 'plugin-data', 'sdr', 'state'))).toBe(true);
  });

  it('records the ownership marker on every server and pluginRoot on stdio only', () => {
    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR Mcp' });

    const servers = JSON.parse(getContainerConfig(g.id)!.mcp_servers);
    expect(servers.hubspot).toMatchObject({ command: 'npx', pluginRoot: '/workspace/agent/plugins/sdr' });
    expect(servers.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' });
    // Declared cwd wins; an omitted one defaults to the plugin root (spec §7.2.1).
    expect(servers.hubspot.cwd).toBe('${PLUGIN_DATA}/state');
    expect(servers.search.cwd).toBe('${PLUGIN_ROOT}');
  });

  it('refuses a template whose task names collide on the truncated id slug', () => {
    // Both names slug to the same 24-char prefix; the collision must surface
    // at first stamp, not on the first later restamp.
    writeTask('a'.repeat(30), '0 9 * * *', 'First.');
    writeTask(`${'a'.repeat(30)}b`, '0 9 * * *', 'Second.');

    expect(() => createAgentFromTemplate('sales/sdr', { name: 'SDR Collide' })).toThrow(/collide on id slug/);
    expect(getAllAgentGroups()).toHaveLength(0);
  });

  it('writes context extras at their template-relative paths', () => {
    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR Extras' });

    const groupDir = path.join(GROUPS_DIR, g.folder);
    expect(fs.existsSync(path.join(groupDir, 'playbook.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'additional_context', 'faq.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'context'))).toBe(false);
  });

  it('derives the display name: explicit option → extension agentName → folder leaf', () => {
    fs.rmSync(TPL, { recursive: true, force: true });
    writeTemplate({ extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'Sales Development Rep' } } });
    const { group: named } = createAgentFromTemplate('sales/sdr');
    expect(named.name).toBe('Sales Development Rep');

    fs.rmSync(TPL, { recursive: true, force: true });
    writeTemplate();
    const { group: fallback } = createAgentFromTemplate('sales/sdr');
    expect(fallback.name).toBe('sdr');

    fs.rmSync(TPL, { recursive: true, force: true });
    writeTemplate({ extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'Ignored' } } });
    const { group: explicit } = createAgentFromTemplate('sales/sdr', { name: 'Chosen' });
    expect(explicit.name).toBe('Chosen');
  });

  it('stamps a persona-less conformant plugin: no prepend file, group still complete', () => {
    fs.rmSync(TPL, { recursive: true, force: true });
    fs.mkdirSync(path.join(TPL, 'skills', 'greet'), { recursive: true });
    fs.writeFileSync(path.join(TPL, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'greeter' }));
    fs.writeFileSync(path.join(TPL, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: says hi\n---\n');

    const { group: g, report } = createAgentFromTemplate('sales/sdr');

    expect(g.name).toBe('sdr'); // folder leaf, not the manifest name
    expect(fs.existsSync(path.join(GROUPS_DIR, g.folder, PERSONA_PREPEND_FILE))).toBe(false);
    expect(fs.existsSync(path.join(GROUPS_DIR, g.folder, 'plugins', 'greeter', 'plugin.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'greet', 'SKILL.md')),
    ).toBe(true);
    expect(report).toEqual([]);
  });

  it('surfaces the reader report to the caller', () => {
    fs.writeFileSync(
      path.join(TPL, 'plugin.json'),
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr', publisher: 'acme' }),
    );
    const { report } = createAgentFromTemplate('sales/sdr', { name: 'SDR Report' });
    expect(report).toEqual([expect.stringContaining('unknown field "publisher"')]);
  });

  it('rejects a template containing a symlink before any group state is created', () => {
    fs.symlinkSync('/etc/hosts', path.join(TPL, 'stolen'));

    expect(() => createAgentFromTemplate('sales/sdr', { name: 'Evil' })).toThrow(/symlink/);
    expect(getAllAgentGroups()).toEqual([]);
  });

  it('creates template tasks paused through the normal isolated task-session path', () => {
    writeTask('weekday-briefing', '0 9 * * 1-5', 'Send the weekday briefing.');

    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR Tasks' });
    const sessions = findTaskSessions(g.id);
    expect(sessions).toHaveLength(1);

    const db = new Database(inboundDbPath(g.id, sessions[0].id), { readonly: true });
    const row = db
      .prepare("SELECT status, recurrence, process_after, content FROM messages_in WHERE kind = 'task'")
      .get() as { status: string; recurrence: string; process_after: string; content: string };
    db.close();

    expect(row.status).toBe('paused');
    expect(row.recurrence).toBe('0 9 * * 1-5');
    expect(new Date(row.process_after).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.parse(row.content)).toMatchObject({
      prompt: 'Send the weekday briefing.',
      script: null,
      originSessionId: null,
    });
    expect(fs.existsSync(path.join(GROUPS_DIR, g.folder, 'tasks', 'weekday-briefing.md'))).toBe(false);
  });

  it('stamps a valid timezone onto the config row and grounds template task first runs in it', () => {
    writeTask('daily-digest', '0 9 * * *', 'Send the digest.');

    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR TZ', timezone: 'Asia/Tokyo' });
    expect(getContainerConfig(g.id)?.timezone).toBe('Asia/Tokyo');

    const sessions = findTaskSessions(g.id);
    const db = new Database(inboundDbPath(g.id, sessions[0].id), { readonly: true });
    const row = db.prepare("SELECT process_after FROM messages_in WHERE kind = 'task'").get() as {
      process_after: string;
    };
    db.close();

    // 09:00 in Tokyo (no DST) is always 00:00 UTC. A first run computed in the
    // install-global timezone would only produce this if the test host itself
    // ran in JST.
    expect(row.process_after).toMatch(/T00:00:00/);
  });

  it('ignores an invalid timezone — the group follows the install default', () => {
    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'SDR Bad TZ', timezone: 'Not/AZone' });
    expect(getContainerConfig(g.id)?.timezone).toBeNull();
  });

  it('forwards multiline scripts unchanged through the shared task creation path', () => {
    const script = 'count=2\necho \'{"wakeAgent": true, "data": {"count": 2}}\'';
    writeTask('alert-watch', '*/15 * * * *', 'Investigate new alerts.', script);

    const { group: g } = createAgentFromTemplate('sales/sdr', { name: 'Scripted Tasks' });
    const sessions = findTaskSessions(g.id);
    expect(sessions).toHaveLength(1);

    const db = new Database(inboundDbPath(g.id, sessions[0].id), { readonly: true });
    const row = db.prepare("SELECT status, recurrence, content FROM messages_in WHERE kind = 'task'").get() as {
      status: string;
      recurrence: string;
      content: string;
    };
    db.close();

    expect(row.status).toBe('paused');
    expect(row.recurrence).toBe('*/15 * * * *');
    expect(JSON.parse(row.content)).toMatchObject({
      script: `${script}\n`,
      originSessionId: null,
    });
  });

  it.each([
    ['invalid cron', 'not a cron', /invalid --recurrence/],
    ['too-frequent cron', '* * * * *', /has not been scheduled/],
  ])('rejects %s before creating the agent group', (_case, schedule, expected) => {
    writeTask('broken', schedule, 'Never created.');

    expect(() => createAgentFromTemplate('sales/sdr', { name: 'Broken Tasks' })).toThrow(expected);
    expect(getAllAgentGroups()).toEqual([]);
    expect(fs.existsSync(path.join(GROUPS_DIR, 'broken-tasks'))).toBe(false);
  });
});
