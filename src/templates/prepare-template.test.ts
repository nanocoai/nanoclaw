import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentCreateSpec } from './create-spec.js';
import { parseTemplate } from './parse.js';
import { prepareTemplateForCreateSpec } from './prepare-template.js';
import { loadTemplateSnapshot } from './snapshot.js';

const TEST_ROOT = '/tmp/nanoclaw-prepare-template-test';
const SOURCE_DIR = path.join(TEST_ROOT, 'source');
const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const NANOCLAW_EXTENSION = 'ai.nanoco.nanoclaw';

function writeSourceTemplate(): void {
  const contextDir = path.join(SOURCE_DIR, NANOCLAW_EXTENSION, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(path.join(SOURCE_DIR, 'skills', 'existing'), { recursive: true });
  fs.mkdirSync(path.join(SOURCE_DIR, 'packages'), { recursive: true });
  fs.writeFileSync(
    path.join(SOURCE_DIR, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'support' }),
  );
  fs.writeFileSync(path.join(contextDir, 'instructions.md'), 'You are a support agent.\n');
  fs.writeFileSync(path.join(contextDir, 'playbook.md'), '# Playbook\n');
  fs.writeFileSync(
    path.join(SOURCE_DIR, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { legacy: { type: 'stdio', command: 'legacy-mcp' } },
    }),
  );
  fs.writeFileSync(
    path.join(SOURCE_DIR, 'skills', 'existing', 'SKILL.md'),
    '---\nname: existing\ndescription: Existing test skill.\n---\n',
  );
  fs.writeFileSync(path.join(SOURCE_DIR, 'packages', 'apt.txt'), 'curl\n');
  fs.writeFileSync(path.join(SOURCE_DIR, 'packages', 'npm.txt'), 'yaml\n');
}

function spec(overrides: Partial<AgentCreateSpec> = {}): AgentCreateSpec {
  return {
    version: 2,
    id: 'ag-prepared',
    name: 'Prepared',
    folder: 'prepared',
    template: { ref: 'support', expectedDigest: loadTemplateSnapshot(SOURCE_DIR).digest },
    config: {
      mcpServers: { approved: { command: 'approved-mcp' } },
      cliScope: 'group',
      packagesApt: ['jq'],
      packagesNpm: ['csv-parse'],
    },
    templateContributions: {
      standingInstructions: ['# Tools\n\nUse Google Calendar to list events.'],
      contextFiles: [{ name: 'reference/limits.md', content: '# Limits\n' }],
      skills: [
        {
          name: 'nanoco-app-google-calendar',
          files: {
            'SKILL.md': '---\nname: nanoco-app-google-calendar\ndescription: Calendar guidance.\n---\n',
            'references/events.md': '# Events\n',
          },
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  writeSourceTemplate();
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('prepareTemplateForCreateSpec', () => {
  it('creates a normal effective template without modifying the source', () => {
    const prepared = prepareTemplateForCreateSpec(SOURCE_DIR, spec());
    try {
      const parsed = parseTemplate(prepared.dir);
      const snapshot = loadTemplateSnapshot(prepared.dir);

      expect(parsed.instructions).toBe('You are a support agent.\n\n# Tools\n\nUse Google Calendar to list events.');
      expect(parsed.mcpServers).toEqual({ approved: { command: 'approved-mcp', args: [], env: {} } });
      expect(parsed.contextExtras.map((file) => file.name).sort()).toEqual(['playbook.md', 'reference/limits.md']);
      expect(parsed.skills.map((skill) => skill.name).sort()).toEqual(['existing', 'nanoco-app-google-calendar']);
      expect(snapshot.packages).toEqual({ apt: ['jq'], npm: ['csv-parse'] });

      expect(fs.readFileSync(path.join(SOURCE_DIR, NANOCLAW_EXTENSION, 'context', 'instructions.md'), 'utf8')).toBe(
        'You are a support agent.\n',
      );
      expect(loadTemplateSnapshot(SOURCE_DIR).packages).toEqual({ apt: ['curl'], npm: ['yaml'] });
      expect(parseTemplate(SOURCE_DIR).mcpServers).toHaveProperty('legacy');
      expect(fs.existsSync(path.join(SOURCE_DIR, 'skills', 'nanoco-app-google-calendar'))).toBe(false);
    } finally {
      const preparedDir = prepared.dir;
      prepared.cleanup();
      expect(fs.existsSync(preparedDir)).toBe(false);
    }
  });

  it('adds governed standing instructions and context to a persona-less conforming plugin', () => {
    fs.rmSync(path.join(SOURCE_DIR, NANOCLAW_EXTENSION), { recursive: true, force: true });

    const prepared = prepareTemplateForCreateSpec(SOURCE_DIR, spec());
    try {
      const parsed = parseTemplate(prepared.dir);
      expect(parsed.instructions).toBe('# Tools\n\nUse Google Calendar to list events.');
      expect(parsed.contextExtras.map((file) => file.name)).toEqual(['reference/limits.md']);
    } finally {
      prepared.cleanup();
    }
  });

  it('rejects source-dependent context and skill collisions', () => {
    expect(() =>
      prepareTemplateForCreateSpec(
        SOURCE_DIR,
        spec({
          templateContributions: {
            contextFiles: [{ name: 'playbook.md', content: 'replacement' }],
          },
        }),
      ),
    ).toThrow(/context file collides/);

    expect(() =>
      prepareTemplateForCreateSpec(
        SOURCE_DIR,
        spec({
          templateContributions: {
            skills: [{ name: 'existing', files: { 'SKILL.md': 'replacement' } }],
          },
        }),
      ),
    ).toThrow(/skill collides/);
  });
});
