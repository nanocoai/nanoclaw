/**
 * Provider-agnostic template-skill materialization.
 *
 * A template stamps its skills as REAL directories into the group-private store
 * `data/v2-sessions/<group-id>/.claude-shared/skills/<name>` (src/templates/create-agent.ts).
 * Claude reads that store directly — it is mounted at `~/.claude/skills`, and
 * real dirs survive the symlink-only skill-link prune. Every OTHER surfaces-owning
 * provider (codex, opencode, pi, …) reads a DIFFERENT per-group skills directory,
 * often READ-ONLY-mounted, so the skills must be copied there host-side, before
 * the container starts.
 *
 * This is the single shared spot that does that copy. Each provider's host-side
 * container contribution calls it once with its own skills dir (codex →
 * `.agents/skills`; a future provider → whatever it reads). Adding a provider
 * therefore adds one call, not a new mirror implementation. The copied dirs are
 * real (not symlinks), so they survive providers' symlink-only prunes and persist
 * across respawns.
 *
 * This module is a main-owned seam that provider payloads (on the `providers`
 * donor branch) import — mirrors src/group-persona.ts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/** The group-private store templates stamp skills into (Claude's read plane). */
function templateSkillsSource(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

/**
 * Copy a group's template skills into a provider's per-group skills directory.
 * No-op if the group has no template skills, or if `destSkillsDir` IS the source
 * (Claude, which reads the source directly — copying onto itself would delete it).
 * Idempotent: overwrites each template skill so edits propagate on respawn. It
 * manages only its own skill dirs — other entries in the destination (e.g. a
 * provider's shared-skill symlinks) are left untouched.
 */
export function materializeTemplateSkills(agentGroupId: string, destSkillsDir: string): void {
  const src = templateSkillsSource(agentGroupId);
  if (!fs.existsSync(src)) return;
  if (path.resolve(src) === path.resolve(destSkillsDir)) return;

  fs.mkdirSync(destSkillsDir, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (!fs.statSync(path.join(src, name)).isDirectory()) continue;
    const dest = path.join(destSkillsDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(src, name), dest, { recursive: true });
  }
}
