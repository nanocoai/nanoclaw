import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NANOCLAW_EXTENSION_NS } from './extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from './manifest.js';
import { parseTemplate } from './parse.js';
import { readPluginSkills } from './skills.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-parse-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeManifest(overrides: Record<string, unknown> = {}): void {
  write('plugin.json', JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr', ...overrides }));
}

function writeMcp(servers: Record<string, unknown>): void {
  write('mcp.json', JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: servers }));
}

function writeSkill(name: string, frontmatter = `---\nname: ${name}\ndescription: does things\n---\n`): void {
  write(`skills/${name}/SKILL.md`, `${frontmatter}\nBody.`);
}

describe('parseTemplate', () => {
  it('parses a full plugin: manifest, skills, mcp, and the NanoClaw extension', () => {
    writeManifest({
      version: '1.0.0',
      description: 'SDR agent',
      extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'SDR Agent' } },
    });
    writeSkill('sdr-agent');
    writeMcp({
      hubspot: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@hubspot/mcp-server@0.4.0'],
        env: { PRIVATE_APP_ACCESS_TOKEN: 'placeholder' },
      },
      docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    });
    write(`${NANOCLAW_EXTENSION_NS}/context/instructions.md`, 'Be helpful.\n\n');
    write(`${NANOCLAW_EXTENSION_NS}/context/playbook.md`, '# Playbook');
    write(`${NANOCLAW_EXTENSION_NS}/context/additional_context/faq.md`, '# FAQ');
    write(`${NANOCLAW_EXTENSION_NS}/tasks/daily-briefing.md`, '---\nschedule: 0 8 * * *\n---\n\nSend the briefing.\n');

    const tpl = parseTemplate(dir);

    expect(tpl.name).toBe('sdr');
    expect(tpl.agentName).toBe('SDR Agent');
    expect(tpl.mcpServers).toEqual({
      hubspot: {
        command: 'npx',
        args: ['-y', '@hubspot/mcp-server@0.4.0'],
        env: { PRIVATE_APP_ACCESS_TOKEN: 'placeholder' },
      },
      docs: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });
    expect(tpl.instructions).toBe('Be helpful.');
    expect(tpl.contextExtras.map((c) => c.name)).toEqual(['additional_context/faq.md', 'playbook.md']);
    expect(tpl.skills.map((s) => s.name)).toEqual(['sdr-agent']);
    expect(tpl.tasks).toEqual([
      {
        name: 'daily-briefing',
        schedule: '0 8 * * *',
        prompt: 'Send the briefing.',
        source: `${NANOCLAW_EXTENSION_NS}/tasks/daily-briefing.md`,
      },
    ]);
    expect(tpl.dir).toBe(path.resolve(dir));
    expect(tpl.report).toEqual([]);
  });

  it('stamps a plain conformant plugin with no NanoClaw extension (persona-less)', () => {
    writeManifest();
    writeSkill('greet');

    const tpl = parseTemplate(dir);

    expect(tpl.instructions).toBeUndefined();
    expect(tpl.agentName).toBeUndefined();
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.contextExtras).toEqual([]);
    expect(tpl.tasks).toEqual([]);
    expect(tpl.skills.map((s) => s.name)).toEqual(['greet']);
    expect(tpl.report).toEqual([]);
  });

  it('emits the migration error for the pre-plugin template layout', () => {
    write('context/instructions.md', 'Old-style template.');
    expect(() => parseTemplate(dir)).toThrow(/predates the plugin format.*re-fetch/s);
  });

  it('rejects a directory that is not a plugin at all', () => {
    write('README.md', 'not a plugin');
    expect(() => parseTemplate(dir)).toThrow(/plugin\.json not found/);
  });

  it('rejects the whole plugin when the tree contains a symlink', () => {
    writeManifest();
    fs.symlinkSync('/etc/hosts', path.join(dir, 'skills'));
    expect(() => parseTemplate(dir)).toThrow(/symlink/);
  });

  describe('manifest (fatal vs non-fatal)', () => {
    it.each([
      ['missing $schema', { $schema: undefined }, /\$schema must be/],
      [
        'wrong $schema version',
        { $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' },
        /\$schema must be/,
      ],
      ['uppercase name', { name: 'SDR' }, /name must be/],
      ['name with -- run', { name: 'a--b' }, /name must be/],
      ['name with .. run', { name: 'a..b' }, /name must be/],
      ['name starting with hyphen', { name: '-a' }, /name must be/],
      ['name over 64 chars', { name: 'a'.repeat(65) }, /name must be/],
      ['non-string version', { version: 2 }, /version must be a string/],
      ['non-string keywords entry', { keywords: ['ok', 3] }, /keywords must be/],
      ['author with unknown field', { author: { name: 'x', twitter: '@x' } }, /unknown field "twitter"/],
      ['non-object author', { author: 'me' }, /author must be an object/],
    ])('rejects the plugin on %s', (_case, overrides, message) => {
      writeManifest(overrides as Record<string, unknown>);
      expect(() => parseTemplate(dir)).toThrow(message);
    });

    it('reports and ignores unknown top-level fields and a non-object extensions', () => {
      writeManifest({ publisher: 'acme', extensions: 'nope' });
      const tpl = parseTemplate(dir);
      expect(tpl.report).toEqual(
        expect.arrayContaining([
          expect.stringContaining('unknown field "publisher"'),
          expect.stringContaining('extensions is not an object'),
        ]),
      );
    });

    it('rejects invalid JSON in plugin.json', () => {
      write('plugin.json', '{nope');
      expect(() => parseTemplate(dir)).toThrow(/not valid JSON/);
    });
  });

  describe('skills component', () => {
    it('skips non-conforming skills with a named report and keeps the rest', () => {
      writeManifest();
      writeSkill('good');
      write('skills/no-skill-md/notes.txt', 'x');
      writeSkill('no-description', '---\nname: x\n---\n');
      writeSkill('no-frontmatter', 'just a body\n');
      write('skills/README.md', 'stray file, not a skill');

      const tpl = parseTemplate(dir);

      expect(tpl.skills.map((s) => s.name)).toEqual(['good']);
      expect(tpl.report).toEqual([
        'skills/no-description: skipped: SKILL.md frontmatter is missing "description"',
        'skills/no-frontmatter: skipped: SKILL.md is missing YAML frontmatter',
        'skills/no-skill-md: skipped: no SKILL.md',
      ]);
    });

    it('skips the whole component when skills is a file', () => {
      writeManifest();
      write('skills', 'not a directory');
      const tpl = parseTemplate(dir);
      expect(tpl.skills).toEqual([]);
      expect(tpl.report).toEqual(['skills: not a directory; skills component skipped']);
    });
  });

  describe('mcp component', () => {
    it.each([
      ['bad JSON', 'garbage', /not valid JSON/],
      ['wrong $schema', JSON.stringify({ $schema: 'https://x', mcpServers: {} }), /\$schema must be/],
      [
        'extra top-level field',
        JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: {}, extra: 1 }),
        /exactly \$schema and mcpServers/,
      ],
    ])('skips the whole MCP component on %s but keeps loading the plugin', (_case, content, message) => {
      writeManifest();
      writeSkill('good');
      write('mcp.json', content);

      const tpl = parseTemplate(dir);

      expect(tpl.mcpServers).toEqual({});
      expect(tpl.skills).toHaveLength(1);
      expect(tpl.report.join('\n')).toMatch(message);
    });

    it.each([
      ['sse transport', { type: 'sse', url: 'https://mcp.example.com/mcp' }, /unsupported transport "sse"/],
      ['missing type', { command: 'server' }, /type must be "stdio" or "streamable-http"/],
      ['internal http spelling', { type: 'http', url: 'https://mcp.example.com/mcp' }, /type must be/],
      ['unknown field', { type: 'stdio', command: 'server', timeout: 5 }, /unknown field "timeout"/],
      ['insecure url', { type: 'streamable-http', url: 'http://mcp.example.com/mcp' }, /HTTPS/],
      [
        'host-gateway url',
        { type: 'streamable-http', url: 'https://host.docker.internal/mcp' },
        /reaches the container host/,
      ],
      ['cwd escaping the root', { type: 'stdio', command: 'server', cwd: './../evil' }, /cwd escapes the plugin root/],
      ['free-form cwd', { type: 'stdio', command: 'server', cwd: '/etc' }, /cwd must be/],
      ['shell-string command', { type: 'stdio', command: 'sh -c evil' }, /single token/],
      ['placeholder in command', { type: 'stdio', command: '${PLUGIN_ROOT}/bin' }, /expansion/],
      ['command escaping the root', { type: 'stdio', command: './../evil' }, /escapes the plugin root/],
      ['non-relative path command', { type: 'stdio', command: 'bin/server' }, /bare executable name/],
      [
        'reserved env key',
        { type: 'stdio', command: 'server', env: { PLUGIN_ROOT: '/x' } },
        /must not define "PLUGIN_ROOT"/,
      ],
      [
        'invalid env key',
        { type: 'stdio', command: 'server', env: { 'BAD KEY': 'v' } },
        /valid environment variable name/,
      ],
      [
        'plain-http host-gateway url',
        { type: 'streamable-http', url: 'http://host.docker.internal/mcp' },
        /reaches the container host/,
      ],
    ])('skips a server with %s and keeps the rest', (_case, server, message) => {
      writeManifest();
      writeMcp({ bad: server, good: { type: 'stdio', command: 'server' } });

      const tpl = parseTemplate(dir);

      expect(Object.keys(tpl.mcpServers)).toEqual(['good']);
      expect(tpl.report.join('\n')).toMatch(/server "bad" skipped/);
      expect(tpl.report.join('\n')).toMatch(message);
    });

    it('accepts plain-HTTP URLs for loopback hosts', () => {
      writeManifest();
      writeMcp({
        v4: { type: 'streamable-http', url: 'http://127.0.0.1:9000/mcp' },
        v6: { type: 'streamable-http', url: 'http://[::1]:9000/mcp' },
      });

      const tpl = parseTemplate(dir);

      expect(Object.keys(tpl.mcpServers)).toEqual(['v4', 'v6']);
      expect(tpl.report).toEqual([]);
    });

    it('skips a server whose name fails the shared name validation', () => {
      writeManifest();
      writeMcp({
        'my.server': { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
        good: { type: 'stdio', command: 'server' },
      });

      const tpl = parseTemplate(dir);

      expect(Object.keys(tpl.mcpServers)).toEqual(['good']);
      expect(tpl.report.join('\n')).toMatch(/server "my\.server" skipped:.*1-64 characters/);
    });

    it('accepts a ./-relative command and placeholder headers', () => {
      writeManifest();
      writeMcp({
        local: { type: 'stdio', command: './server/run.js', args: ['${PLUGIN_DATA}/cache'] },
        api: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'placeholder' } },
      });

      const tpl = parseTemplate(dir);

      expect(tpl.mcpServers.local).toMatchObject({ command: './server/run.js' });
      expect(tpl.mcpServers.api).toEqual({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'placeholder' },
      });
      expect(tpl.report).toEqual([]);
    });

    it('accepts a well-formed cwd in each fixed form', () => {
      writeManifest();
      writeMcp({
        rel: { type: 'stdio', command: 'server', cwd: './work' },
        root: { type: 'stdio', command: 'server', cwd: '${PLUGIN_ROOT}/sub' },
        data: { type: 'stdio', command: 'server', cwd: '${PLUGIN_DATA}' },
      });

      const tpl = parseTemplate(dir);

      expect(tpl.mcpServers.rel).toMatchObject({ cwd: './work' });
      expect(tpl.mcpServers.root).toMatchObject({ cwd: '${PLUGIN_ROOT}/sub' });
      expect(tpl.mcpServers.data).toMatchObject({ cwd: '${PLUGIN_DATA}' });
      expect(tpl.report).toEqual([]);
    });

    it('rejects the whole plugin when an env value matches a known secret format', () => {
      writeManifest();
      writeMcp({ crm: { type: 'stdio', command: 'server', env: { API_KEY: 'sk-live-1234567890' } } });
      expect(() => parseTemplate(dir)).toThrow(/looks like a real credential.*placeholder/s);
    });

    it('rejects the whole plugin when a header value matches a known secret format', () => {
      writeManifest();
      writeMcp({
        api: { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'ghp_abc123' } },
      });
      expect(() => parseTemplate(dir)).toThrow(/looks like a real credential/);
    });

    it('rejects a known secret format behind an auth-scheme prefix (Bearer sk-…)', () => {
      writeManifest();
      writeMcp({
        api: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer sk-proj-AbC123RealLookingKey456' },
        },
      });
      expect(() => parseTemplate(dir)).toThrow(/looks like a real credential/);
    });

    it('keeps "Bearer placeholder" on the warn-only path', () => {
      writeManifest();
      writeMcp({
        api: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
      });

      const tpl = parseTemplate(dir);

      expect(tpl.mcpServers.api).toBeDefined();
      expect(tpl.report.join('\n')).toMatch(/Authorization.*placeholder convention/);
    });

    it('warns (but keeps the server) on a secret-shaped key with an unrecognized value', () => {
      writeManifest();
      writeMcp({ crm: { type: 'stdio', command: 'server', env: { EXA_API_KEY: 'onecli-managed' } } });

      const tpl = parseTemplate(dir);

      expect(tpl.mcpServers.crm).toBeDefined();
      expect(tpl.report.join('\n')).toMatch(/EXA_API_KEY.*placeholder convention/);
    });

    it('reports a legacy .mcp.json without reading it', () => {
      writeManifest();
      write('.mcp.json', JSON.stringify({ mcpServers: { old: { command: 'server' } } }));

      const tpl = parseTemplate(dir);

      expect(tpl.mcpServers).toEqual({});
      expect(tpl.report).toEqual(['.mcp.json: ignored (legacy name); rename it to mcp.json']);
    });
  });

  describe('NanoClaw extension', () => {
    it('reports and ignores a malformed agentName and unknown extension keys', () => {
      writeManifest({ extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 7, color: 'red' } } });
      const tpl = parseTemplate(dir);
      expect(tpl.agentName).toBeUndefined();
      expect(tpl.report).toEqual(
        expect.arrayContaining([
          expect.stringContaining('agentName must be a nonempty string'),
          expect.stringContaining('.color is not recognized'),
        ]),
      );
    });

    it('silently keeps foreign extension namespaces', () => {
      writeManifest({ extensions: { 'com.example.other': { anything: true } } });
      expect(parseTemplate(dir).report).toEqual([]);
    });

    it.each([
      ['missing frontmatter', 'Run it.', /must start with ---/],
      ['unknown field', '---\ncron: 0 9 * * *\n---\nRun it.', /only schedule and script/],
      ['invalid YAML', '---\nschedule: "0 9 * * *\n---\nRun it.', /invalid YAML frontmatter/],
      ['non-string schedule', '---\nschedule: 9\n---\nRun it.', /schedule must be a nonempty string/],
      ['empty script', '---\nschedule: 0 9 * * *\nscript: "  "\n---\nRun it.', /script must be a nonempty string/],
      ['empty prompt', '---\nschedule: 0 9 * * *\n---\n', /prompt is required/],
    ])('rejects a task with %s', (_case, content, expected) => {
      writeManifest();
      write(`${NANOCLAW_EXTENSION_NS}/tasks/broken.md`, content);
      expect(() => parseTemplate(dir)).toThrow(expected);
    });

    it('accepts a multiline script and a single-line script', () => {
      writeManifest();
      write(
        `${NANOCLAW_EXTENSION_NS}/tasks/check.md`,
        '---\nschedule: "0 9 * * *"\nscript: echo wake\n---\nCheck it.\n',
      );
      expect(parseTemplate(dir).tasks[0].script).toBe('echo wake');
    });
  });

  it('throws when the folder does not exist', () => {
    expect(() => parseTemplate(path.join(dir, 'nope'))).toThrow(/not found/i);
  });
});

describe('readPluginSkills (direct)', () => {
  it('skips a symlinked skill directory even when called outside the walk gate', () => {
    write('skills/real/SKILL.md', '---\nname: real\ndescription: ok\n---\n');
    fs.mkdirSync(path.join(dir, 'elsewhere'));
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'skills', 'linked'));

    const { skills, report } = readPluginSkills(dir);

    expect(skills.map((s) => s.name)).toEqual(['real']);
    expect(report).toEqual(['skills/linked: skipped: symlinks are not allowed in plugins']);
  });
});
