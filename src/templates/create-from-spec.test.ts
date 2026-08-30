import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, GROUPS_DIR, DATA_DIR, TEMPLATES_DIR } = vi.hoisted(() => {
  const root = '/tmp/nanoclaw-create-from-spec-test';
  return {
    TEST_ROOT: root,
    GROUPS_DIR: `${root}/groups`,
    DATA_DIR: `${root}/data`,
    TEMPLATES_DIR: `${root}/templates`,
  };
});
const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const NANOCLAW_EXTENSION = 'ai.nanoco.nanoclaw';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR,
  DATA_DIR,
  TEMPLATES_DIR,
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
const { buildAgentGroupImageMock } = vi.hoisted(() => ({
  buildAgentGroupImageMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../container-runner.js', () => ({
  buildAgentGroupImage: buildAgentGroupImageMock,
}));

import { closeDb, getAllAgentGroups, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { findTaskSessions } from '../db/sessions.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import { createAgentFromSpec } from './create-from-spec.js';
import { MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES } from './create-spec.js';
import { loadTemplateSnapshot } from './snapshot.js';

function writePlugin(): string {
  const dir = path.join(TEMPLATES_DIR, 'support');
  fs.mkdirSync(path.join(dir, 'skills', 'base-skill'), { recursive: true });
  fs.mkdirSync(path.join(dir, NANOCLAW_EXTENSION, 'context'), { recursive: true });
  fs.mkdirSync(path.join(dir, NANOCLAW_EXTENSION, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'policies'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    `${JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'support' }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    `${JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { unused: { type: 'stdio', command: 'unused-mcp' } },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'skills', 'base-skill', 'SKILL.md'),
    '---\nname: base-skill\ndescription: Base support skill.\n---\n',
  );
  fs.writeFileSync(path.join(dir, NANOCLAW_EXTENSION, 'context', 'playbook.md'), '# Support playbook\n');
  fs.writeFileSync(
    path.join(dir, NANOCLAW_EXTENSION, 'tasks', 'daily-check.md'),
    '---\nschedule: "0 9 * * *"\n---\n\nReview support queues.\n',
  );
  fs.writeFileSync(path.join(dir, 'packages', 'apt.txt'), 'curl\n');
  fs.writeFileSync(path.join(dir, 'packages', 'npm.txt'), 'yaml\n');
  fs.writeFileSync(path.join(dir, 'policies', 'policy.json'), '{"internal":"blocked-policy-internal"}\n');
  return dir;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  writePlugin();
  buildAgentGroupImageMock.mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('Governance AgentCreateSpec v2 -> NanoClaw Agent Plugins 1.0.0 stamping', () => {
  it('stamps a persona-less plugin with exact effective instructions, context, MCP, skills, packages, and paused tasks', async () => {
    const pluginDir = path.join(TEMPLATES_DIR, 'support');
    const group = await createAgentFromSpec({
      version: 2,
      id: 'f87a7d63-1e43-4e70-88a2-2c94623e0812',
      agentId: 'f87a7d63-1e43-4e70-88a2-2c94623e0812',
      name: 'Governed Support',
      folder: 'agent-f87a7d63-1e43-4e70-88a2-2c94623e0812',
      template: { ref: 'support', expectedDigest: loadTemplateSnapshot(pluginDir).digest },
      config: {
        mcpServers: {
          approved: { command: 'approved-mcp', args: ['--safe'] },
          docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        },
        cliScope: 'group',
        assistantName: 'Demi',
        packagesApt: ['jq'],
        packagesNpm: ['csv-parse'],
      },
      provisionedUserId: 'slack:U123',
      templateContributions: {
        standingInstructions: [
          '# External app tools\n\n## Google Calendar\n\n- List calendar events\n\nConnect the app when asked.',
        ],
        contextFiles: [{ name: 'governed/apps.md', content: '# Approved app catalog\n' }],
        skills: [
          {
            name: 'nanoco-app-google-calendar',
            files: {
              'SKILL.md':
                '---\nname: nanoco-app-google-calendar\ndescription: Governed Calendar guidance.\n---\n',
            },
          },
        ],
      },
    });

    expect(group).toMatchObject({
      id: 'f87a7d63-1e43-4e70-88a2-2c94623e0812',
      provisioned_user_id: 'slack:U123',
    });
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const persona = fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf8');
    expect(persona).toContain('List calendar events');
    expect(persona).not.toContain('blocked-policy-internal');
    expect(fs.readFileSync(path.join(groupDir, 'governed', 'apps.md'), 'utf8')).toBe('# Approved app catalog\n');

    const stampedPlugin = path.join(groupDir, 'plugins', 'support');
    expect(JSON.parse(fs.readFileSync(path.join(stampedPlugin, 'plugin.json'), 'utf8'))).toMatchObject({
      $schema: PLUGIN_SCHEMA_URL,
      name: 'support',
    });
    expect(fs.existsSync(path.join(stampedPlugin, 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(stampedPlugin, NANOCLAW_EXTENSION, 'context', 'instructions.md'))).toBe(true);
    expect(fs.existsSync(path.join(stampedPlugin, NANOCLAW_EXTENSION, 'tasks', 'daily-check.md'))).toBe(true);
    expect(fs.existsSync(path.join(stampedPlugin, 'skills', 'base-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(stampedPlugin, 'skills', 'nanoco-app-google-calendar', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(stampedPlugin, 'packages', 'apt.txt'), 'utf8')).toBe('jq\n');
    expect(fs.readFileSync(path.join(stampedPlugin, 'policies', 'policy.json'), 'utf8')).toContain(
      'blocked-policy-internal',
    );

    const config = (await getContainerConfig(group.id))!;
    expect(config.cli_scope).toBe('group');
    expect(config.assistant_name).toBe('Demi');
    expect(JSON.parse(config.packages_apt)).toEqual(['jq']);
    expect(JSON.parse(config.packages_npm)).toEqual(['csv-parse']);
    expect(JSON.parse(config.mcp_servers)).toMatchObject({
      approved: { command: 'approved-mcp', args: ['--safe'], plugin: 'support' },
      docs: { type: 'http', url: 'https://docs.example.com/mcp', plugin: 'support' },
    });
    expect(buildAgentGroupImageMock).toHaveBeenCalledWith(group.id);

    const sessions = await findTaskSessions(group.id);
    expect(sessions).toHaveLength(1);
    const taskDb = new Database(inboundDbPath(group.id, sessions[0]!.id), { readonly: true });
    const task = taskDb.prepare("SELECT status, content FROM messages_in WHERE kind = 'task'").get() as {
      status: string;
      content: string;
    };
    taskDb.close();
    expect(task.status).toBe('paused');
    expect(JSON.parse(task.content)).toMatchObject({ prompt: 'Review support queues.' });
  });

  it('rejects stale digests and invalid contributions before creating a group', async () => {
    const base = {
      version: 2 as const,
      id: 'ag-invalid',
      name: 'Invalid',
      folder: 'invalid',
      template: { ref: 'support', expectedDigest: 'sha256:stale' },
      config: { mcpServers: {}, cliScope: 'disabled' as const, packagesApt: [], packagesNpm: [] },
    };
    await expect(createAgentFromSpec(base)).rejects.toThrow(/digest changed/i);

    const digest = loadTemplateSnapshot(path.join(TEMPLATES_DIR, 'support')).digest;
    await expect(
      createAgentFromSpec({
        ...base,
        template: { ...base.template, expectedDigest: digest },
        templateContributions: {
          contextFiles: [{ name: 'reference.md', content: 'x'.repeat(MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES + 1) }],
        },
      }),
    ).rejects.toThrow(/exceeds/);
    expect(await getAllAgentGroups()).toEqual([]);
  });
});
