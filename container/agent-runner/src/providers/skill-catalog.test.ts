import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'bun:test';

import { composeAvailableSkills, listAvailableSkills } from './skill-catalog.js';

function makeSkillsDir(skills: { name: string; frontmatter?: string; body?: string }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  for (const s of skills) {
    const skillDir = path.join(dir, s.name);
    fs.mkdirSync(skillDir, { recursive: true });
    const body = s.body ?? '# Body';
    const content = s.frontmatter ? `---\n${s.frontmatter}\n---\n${body}` : body;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  }
  return dir;
}

describe('listAvailableSkills', () => {
  it('returns an empty list when the skills dir does not exist', () => {
    expect(listAvailableSkills(path.join(os.tmpdir(), 'no-such-' + Date.now()))).toEqual([]);
  });

  it('parses name + description from frontmatter', () => {
    const dir = makeSkillsDir([
      { name: 'make-website', frontmatter: 'name: make-website\ndescription: Build and publish a website.' },
      { name: 'wiki', frontmatter: 'name: wiki\ndescription: Maintain a persistent wiki.' },
    ]);
    const out = listAvailableSkills(dir);
    expect(out).toEqual([
      { name: 'make-website', description: 'Build and publish a website.' },
      { name: 'wiki', description: 'Maintain a persistent wiki.' },
    ]);
  });

  it('skips skills without a description (frontmatter or none)', () => {
    const dir = makeSkillsDir([
      { name: 'good', frontmatter: 'name: good\ndescription: Has one.' },
      { name: 'no-desc', frontmatter: 'name: no-desc' },
      { name: 'no-frontmatter' },
    ]);
    const out = listAvailableSkills(dir);
    expect(out.map((e) => e.name)).toEqual(['good']);
  });

  it('falls back to directory name when frontmatter omits the name field', () => {
    const dir = makeSkillsDir([{ name: 'fallback', frontmatter: 'description: Has description but no name field.' }]);
    expect(listAvailableSkills(dir)).toEqual([
      { name: 'fallback', description: 'Has description but no name field.' },
    ]);
  });

  it('strips quoted descriptions', () => {
    const dir = makeSkillsDir([{ name: 'q', frontmatter: 'description: "A quoted description."' }]);
    expect(listAvailableSkills(dir)).toEqual([{ name: 'q', description: 'A quoted description.' }]);
  });

  it('sorts skills deterministically (alphabetical by directory name)', () => {
    const dir = makeSkillsDir([
      { name: 'zulu', frontmatter: 'name: zulu\ndescription: Z.' },
      { name: 'alpha', frontmatter: 'name: alpha\ndescription: A.' },
      { name: 'mike', frontmatter: 'name: mike\ndescription: M.' },
    ]);
    const out = listAvailableSkills(dir).map((e) => e.name);
    expect(out).toEqual(['alpha', 'mike', 'zulu']);
  });
});

describe('composeAvailableSkills', () => {
  it('returns undefined when no eligible skills exist', () => {
    const dir = makeSkillsDir([{ name: 'naked', body: '# Just a body, no frontmatter' }]);
    expect(composeAvailableSkills(dir)).toBeUndefined();
  });

  it('returns undefined when the dir does not exist', () => {
    expect(composeAvailableSkills(path.join(os.tmpdir(), 'no-such-' + Date.now()))).toBeUndefined();
  });

  it('emits a markdown section with discovery instructions and the entry list', () => {
    const dir = makeSkillsDir([
      { name: 'make-website', frontmatter: 'name: make-website\ndescription: Build and publish a website.' },
      { name: 'wiki', frontmatter: 'name: wiki\ndescription: Maintain a persistent wiki.' },
    ]);
    const out = composeAvailableSkills(dir)!;
    expect(out).toContain('# Available skills');
    expect(out).toContain('Read /app/skills/<name>/SKILL.md');
    expect(out).toContain('**make-website** — Build and publish a website.');
    expect(out).toContain('**wiki** — Maintain a persistent wiki.');
  });
});
