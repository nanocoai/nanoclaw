import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultResolveRemote } from '../scripts/skill-apply.js';

export interface SkillCompanion {
  skill: string;
  branch?: string;
}

const companionsBySkill = new Map<string, readonly SkillCompanion[]>();

/** Declare ordered skills applied after a base skill. */
export function registerSkillCompanions(baseSkill: string, companions: readonly SkillCompanion[]): void {
  companionsBySkill.set(baseSkill, companions);
}

export function getSkillCompanions(baseSkill: string): readonly SkillCompanion[] {
  return companionsBySkill.get(baseSkill) ?? [];
}

/** Materialize a branch-backed companion that is not already in the checkout. */
export function materializeSkillCompanion(
  companion: SkillCompanion,
  projectRoot: string,
  deps: {
    exec?: (command: string) => string;
    resolveRemote?: (branch: string) => string;
  } = {},
): boolean {
  const dir = `.claude/skills/${companion.skill}`;
  if (existsSync(join(projectRoot, dir, 'SKILL.md'))) return true;
  if (!companion.branch) return false;
  const exec =
    deps.exec ??
    ((command: string) => execSync(command, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  try {
    const remote = (deps.resolveRemote ?? ((branch) => defaultResolveRemote(branch, projectRoot)))(companion.branch);
    exec(`git fetch ${remote} ${companion.branch}`);
    const files = exec(`git ls-tree -r --name-only '${remote}/${companion.branch}' -- '${dir}'`)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length === 0) return false;
    for (const file of files) {
      mkdirSync(dirname(join(projectRoot, file)), { recursive: true });
      exec(`git show '${remote}/${companion.branch}:${file}' > '${file}'`);
    }
    return true;
  } catch {
    rmSync(join(projectRoot, dir), { recursive: true, force: true });
    return false;
  }
}

registerSkillCompanions('add-slack', [
  { skill: 'slack-a2a-rooms', branch: 'channels' },
  { skill: 'slack-agent-flow', branch: 'channels' },
]);
