// Integration-point guards for the web-search-plus skill.
//
// The skill's one functional reach-in is the python3 system dependency in
// container/Dockerfile: the wsp engine is pure-stdlib Python, and the base
// image is Node-only, so the apt edit is what makes the skill runnable at all.
// python3 is an apt binary, not an importable package, so neither a behavior
// test nor the build leg can see it — this structural test is the guard
// (skill-guidelines.md, "Dependencies are integration points", case 3).
//
// The copied skill files themselves are pure adds; the wrapper/engine
// assertions below guard against a half-applied or half-removed skill
// (wrapper present but engine missing leaves the agent with a broken tool).
//
// Runs under vitest from the project root:
//   pnpm exec vitest run src/wsp-skill.test.ts

import { readFileSync, statSync } from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const DOCKERFILE = path.resolve(ROOT, 'container/Dockerfile');
const SKILL_DIR = path.resolve(ROOT, 'container/skills/web-search-plus');

describe('container/Dockerfile python3 system dependency', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  it('installs python3 in the system-deps apt-get block', () => {
    // Scope the assertion to the apt-get install command so a python3
    // mention elsewhere (a comment, an env var) can't keep this green.
    const aptBlock = dockerfile.match(/apt-get install -y --no-install-recommends[\s\S]*?(?:&&|\n\n)/);
    expect(aptBlock, 'system-deps apt-get install block not found').not.toBeNull();
    expect(aptBlock![0]).toMatch(/^\s+python3(\s|\\)/m);
  });
});

describe('web-search-plus container skill files', () => {
  it('ships the executable wsp wrapper', () => {
    const st = statSync(path.join(SKILL_DIR, 'bin/wsp'));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o111, 'bin/wsp must be executable').not.toBe(0);
  });

  it('ships the engine CLI entry the wrapper execs', () => {
    expect(statSync(path.join(SKILL_DIR, 'engine/search.py')).isFile()).toBe(true);
  });

  it('ships the SKILL.md the agent loads at runtime', () => {
    const skillMd = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(skillMd).toMatch(/^name: web-search-plus$/m);
  });
});
