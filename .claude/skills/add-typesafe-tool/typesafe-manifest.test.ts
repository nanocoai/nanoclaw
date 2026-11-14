/**
 * Guard for the TypeSafe container tool (host tree, vitest).
 *
 * add-typesafe-tool installs a container skill at
 * `container/skills/typesafe-judge/` whose CLI is a Bun script, not a
 * globally-installed binary, so the agent image manifest does not change and
 * no import or typecheck on the host sees the tool. This structural test is
 * the leg that goes red when the installed skill drifts or is deleted.
 *
 * It checks the halves that have to agree for the install to work: the skill
 * files the agent reads, the CLI they point at, and the CLI's credential
 * contract — it must target api.typesafe.ai (the host the gateway rule is
 * registered for) with the placeholder bearer and never read a key itself.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

/** Repo root — the dir holding container/skills, wherever this file is copied to. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'skills'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/skills not found walking up from ' + __dirname);
}

describe('the TypeSafe judge tool is installed in the agent containers', () => {
  const root = repoRoot();
  const skillDir = path.join(root, 'container', 'skills', 'typesafe-judge');
  const cliPath = path.join(skillDir, 'scripts', 'typesafe-judge.ts');

  it('ships the container skill the agent reads', () => {
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^name: typesafe-judge$/m);
    expect(skill).toContain('/app/skills/typesafe-judge/scripts/typesafe-judge.ts');
  });

  it('ships the CLI the skill points at, with its unit tests beside it', () => {
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'scripts', 'typesafe-judge.test.ts'))).toBe(true);
  });

  it('targets api.typesafe.ai with the gateway placeholder and never reads a key', () => {
    const cli = fs.readFileSync(cliPath, 'utf8');
    expect(cli).toContain("'https://api.typesafe.ai/v1/systemone'");
    expect(cli).toContain("PLACEHOLDER_CREDENTIAL = 'placeholder'");
    expect(cli).toMatch(/Authorization: `Bearer \$\{PLACEHOLDER_CREDENTIAL\}`/);
    // No env var, file, or flag ever supplies the credential.
    expect(cli).not.toMatch(/TYPESAFE_API_KEY/);
    expect(cli).not.toMatch(/process\.env/);
  });

  it('has no runtime dependencies beyond Node/Bun built-ins', () => {
    const cli = fs.readFileSync(cliPath, 'utf8');
    const imports = [...cli.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith('node:')).toBe(true);
  });
});
