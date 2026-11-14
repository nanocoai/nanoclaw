/**
 * Skill files.txt manifest / mirror drift guard.
 *
 * Every skill that owns in-tree code lists its files in its skill folder's
 * `files.txt` (one repo-relative path per line) and carries a generated
 * mirror under `<skill-folder>/files/`, produced by
 * `scripts/sync-skill-files.sh <skill-path>`. Skill folders live at any of
 * three layers:
 *
 *   .claude/skills/<name>/                          (top-level skills)
 *   .claude/skills/recipes/<recipe>/                (a recipe's own files)
 *   .claude/skills/recipes/<recipe>/skills/<name>/  (recipe components)
 *
 * The in-tree file is canonical. This test asserts, for every manifest at
 * every layer:
 *   1. every listed path exists in the tree, and
 *   2. each listed file matches its mirror byte-for-byte (re-run the sync
 *      script after editing canon — a missing files/ mirror is a failure,
 *      not a skip).
 *
 * A fixture-driven suite additionally guards the discovery and the script's
 * `--all` glob: dropping any layer from the scan goes red even while the
 * repo has no manifests at that layer yet.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, afterAll } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-skill-files.sh');

interface Manifest {
  skill: string;
  files: string[];
  mirrorDir: string;
}

/** Skill folders at all three layers, relative to .claude/skills/. */
function skillDirs(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  const dirs = fs.readdirSync(skillsDir).filter((name) => name !== 'recipes');
  const recipesDir = path.join(skillsDir, 'recipes');
  if (fs.existsSync(recipesDir)) {
    for (const recipe of fs.readdirSync(recipesDir)) {
      dirs.push(path.join('recipes', recipe));
      const componentsDir = path.join(recipesDir, recipe, 'skills');
      if (!fs.existsSync(componentsDir)) continue;
      for (const component of fs.readdirSync(componentsDir)) {
        dirs.push(path.join('recipes', recipe, 'skills', component));
      }
    }
  }
  return dirs;
}

function readManifests(root: string): Manifest[] {
  const skillsDir = path.join(root, '.claude', 'skills');
  return skillDirs(skillsDir)
    .filter((rel) => fs.existsSync(path.join(skillsDir, rel, 'files.txt')))
    .map((rel) => ({
      skill: rel,
      mirrorDir: path.join(skillsDir, rel, 'files'),
      files: fs
        .readFileSync(path.join(skillsDir, rel, 'files.txt'), 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter((line) => line.length > 0),
    }));
}

describe('skill file manifests', () => {
  const manifests = readManifests(REPO_ROOT);

  it('scans the skills directory', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, '.claude', 'skills'))).toBe(true);
  });

  it.each(manifests.map((m) => [m.skill, m] as const))(
    '%s: every listed path exists in the tree',
    (_skill, manifest) => {
      const missing = manifest.files.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
      expect(missing).toEqual([]);
    },
  );

  it.each(manifests.map((m) => [m.skill, m] as const))(
    '%s: files/ mirror matches the in-tree canon byte-for-byte',
    (_skill, manifest) => {
      const drifted: string[] = [];
      for (const f of manifest.files) {
        const canon = path.join(REPO_ROOT, f);
        const mirror = path.join(manifest.mirrorDir, f);
        if (!fs.existsSync(mirror)) {
          drifted.push(`${f} (mirror missing — run scripts/sync-skill-files.sh ${manifest.skill})`);
          continue;
        }
        if (!fs.readFileSync(canon).equals(fs.readFileSync(mirror))) {
          drifted.push(`${f} (drifted — run scripts/sync-skill-files.sh ${manifest.skill})`);
        }
      }
      expect(drifted).toEqual([]);
    },
  );
});

describe('skill-sync infra covers all three skill layers (fixture)', () => {
  // A throwaway repo with one manifest per layer. The sync script computes
  // REPO_ROOT from its own location, so it gets copied into the fixture.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-fixture-'));
  const topDir = path.join(fixtureRoot, '.claude', 'skills', 'demo-top');
  const recipeDir = path.join(fixtureRoot, '.claude', 'skills', 'recipes', 'demo-recipe');
  const nestedDir = path.join(fixtureRoot, '.claude', 'skills', 'recipes', 'demo-recipe', 'skills', 'demo-component');

  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(SYNC_SCRIPT, path.join(fixtureRoot, 'scripts', 'sync-skill-files.sh'));

  fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'src', 'top-canon.ts'), 'export const layer = "top";\n');
  fs.writeFileSync(path.join(fixtureRoot, 'src', 'recipe-canon.ts'), 'export const layer = "recipe";\n');
  fs.writeFileSync(path.join(fixtureRoot, 'src', 'nested-canon.ts'), 'export const layer = "nested";\n');

  fs.mkdirSync(topDir, { recursive: true });
  fs.writeFileSync(path.join(topDir, 'files.txt'), 'src/top-canon.ts\n');
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(path.join(recipeDir, 'files.txt'), 'src/recipe-canon.ts\n');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'files.txt'), 'src/nested-canon.ts\n');

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runSync(...args: string[]): { status: number | null; stderr: string } {
    const res = spawnSync('bash', [path.join(fixtureRoot, 'scripts', 'sync-skill-files.sh'), ...args], {
      encoding: 'utf8',
    });
    return { status: res.status, stderr: res.stderr };
  }

  it('discovery sees manifests at all three layers', () => {
    const manifests = readManifests(fixtureRoot);
    expect(manifests.map((m) => m.skill).sort()).toEqual([
      'demo-top',
      path.join('recipes', 'demo-recipe'),
      path.join('recipes', 'demo-recipe', 'skills', 'demo-component'),
    ]);
  });

  it('--all syncs mirrors at all three layers', () => {
    const res = runSync('--all');
    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(topDir, 'files', 'src', 'top-canon.ts'), 'utf8')).toBe(
      'export const layer = "top";\n',
    );
    expect(fs.readFileSync(path.join(recipeDir, 'files', 'src', 'recipe-canon.ts'), 'utf8')).toBe(
      'export const layer = "recipe";\n',
    );
    expect(fs.readFileSync(path.join(nestedDir, 'files', 'src', 'nested-canon.ts'), 'utf8')).toBe(
      'export const layer = "nested";\n',
    );
  });

  it('--all --check flags drift at the nested layer', () => {
    fs.appendFileSync(path.join(fixtureRoot, 'src', 'nested-canon.ts'), '// drift\n');
    const res = runSync('--all', '--check');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('DRIFTED: src/nested-canon.ts');

    // Re-sync the single nested skill by path, then --check passes again.
    const resync = runSync('recipes/demo-recipe/skills/demo-component');
    expect(resync.status).toBe(0);
    expect(runSync('--all', '--check').status).toBe(0);
  });
});
