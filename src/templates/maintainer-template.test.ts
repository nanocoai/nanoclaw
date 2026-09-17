/**
 * The in-tree `templates/maintainer` plugin must parse cleanly with the real
 * template reader: four skills, one paused task, a persona, and no report
 * lines (a report line means a component was silently skipped at stamp
 * time). The template's long-term home is nanocoai/nanoclaw-templates; this
 * test skips itself once the directory is gone from this repo.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';

const dir = path.resolve(process.cwd(), 'templates', 'maintainer');

describe.skipIf(!fs.existsSync(dir))('templates/maintainer', () => {
  const tpl = parseTemplate(dir);

  it('parses with nothing skipped', () => {
    expect(tpl.name).toBe('maintainer');
    expect(tpl.agentName).toBe('Maintainer');
    expect(tpl.report).toEqual([]);
  });

  it('ships the four skills and the weekly digest task', () => {
    expect(tpl.skills.map((s) => s.name)).toEqual(['dedupe-issues', 'rank-backlog', 'route-pr', 'triage-issues']);
    expect(tpl.tasks.map((t) => [t.name, t.schedule])).toEqual([['weekly-digest', '0 9 * * 1']]);
  });

  it('carries a persona that routes judgments through typesafe-judge and forbids merging and closing', () => {
    expect(tpl.instructions).toContain('typesafe-judge');
    expect(tpl.instructions).toMatch(/never merge, never close/);
    expect(tpl.contextExtras.map((c) => c.name)).toEqual(['additional_context/labels.md']);
  });

  it('declares no MCP servers and no secrets', () => {
    expect(tpl.mcpServers).toEqual({});
    const gh = fs.readFileSync(path.join(dir, 'scripts', 'gh.ts'), 'utf8');
    expect(gh).not.toMatch(/Authorization['"]?:\s*[`'"]/);
    expect(gh).not.toMatch(/process\.env/);
  });
});
