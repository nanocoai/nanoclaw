/**
 * Code mode: the dev-instruction surface.
 *
 * The code runner starts the interactive CLI at /workspace/group
 * (code-runner/index.ts), and the CLI auto-reads the CLAUDE.md at its cwd —
 * that file is the one instruction surface a code-mode session gets after the
 * composition strip. The manual itself ships in the install tree
 * (container/code-mode/CLAUDE.md), but it cannot bind onto the agent straight
 * from there: the install-surface rule is an enumerated release-surface
 * allowlist (drivers `surfaceRoots`) that does not name it, and every other
 * class would refuse the path. So it takes the container.json route instead —
 * host-stamped into the group's sessions subtree on every spawn, then
 * nested-RO-mounted over the RW workspace: 'group-state' by the sessions-root
 * rule, host-owned words the agent reads but cannot edit. Never via ~/.claude,
 * which is RW agent-editable group state — and never under <sessDir> itself,
 * which IS the RW /workspace (see devStampDir).
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

import type { VolumeMount } from '../providers/provider-container-registry.js';

/** The code runner's session cwd (code-runner/index.ts `WORKSPACE_DIR`). */
export const CODE_WORKSPACE_DIR = '/workspace/group';

/** The bundle's home in the install tree: the manual beside a `skills/` dir of skill dirs. */
export const CODE_MODE_BUNDLE_DIR = path.join('container', 'code-mode');

/** The skills the bundle ships; a tree missing one of these is degraded. */
export const BUNDLED_DEV_SKILLS: readonly string[] = ['dev-git', 'dev-toolchains'];

export interface CodeModeBundleStatus {
  /** container/code-mode/CLAUDE.md is present. */
  manual: boolean;
  /** Skill dirs present under container/code-mode/skills/. */
  skills: string[];
  /** Bundled skills the tree lacks. */
  missingSkills: string[];
}

/**
 * What of the instruction surface this install tree carries. The stamping
 * below is fail-open by design (an instruction file is never worth a
 * session), so a tree without the bundle must be LOUD somewhere else: the
 * sandbox verbs read this and warn (`sandboxes new`, `sandboxes list`).
 */
export function codeModeBundleStatus(root: string = process.cwd()): CodeModeBundleStatus {
  const manual = fs.existsSync(path.join(root, CODE_MODE_BUNDLE_DIR, 'CLAUDE.md'));
  let skills: string[] = [];
  try {
    skills = fs
      .readdirSync(path.join(root, CODE_MODE_BUNDLE_DIR, 'skills'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && fs.existsSync(path.join(root, CODE_MODE_BUNDLE_DIR, 'skills', entry.name, 'SKILL.md')),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No skills dir at all: reported as every bundled skill missing.
  }
  return { manual, skills, missingSkills: BUNDLED_DEV_SKILLS.filter((name) => !skills.includes(name)) };
}

/** One operator-facing line per missing piece; empty when the bundle is whole. */
export function codeModeBundleWarnings(status: CodeModeBundleStatus = codeModeBundleStatus()): string[] {
  const warnings: string[] = [];
  if (!status.manual) {
    warnings.push(
      `code mode: the operating manual is missing from this checkout (${CODE_MODE_BUNDLE_DIR}/CLAUDE.md) — ` +
        'the agent boots without instructions; restore the file or update the checkout',
    );
  }
  if (status.missingSkills.length > 0) {
    warnings.push(
      `code mode: dev skills missing from this checkout (${status.missingSkills.join(', ')} under ` +
        `${CODE_MODE_BUNDLE_DIR}/skills/) — the agent boots without them`,
    );
  }
  return warnings;
}

/** Host-side name of the stamped manual, inside the session's stamp dir. */
export const DEV_INSTRUCTION_FILE = 'code-mode-CLAUDE.md';

/** Host-side dir of the stamped skill bundle, inside the session's stamp dir. */
export const DEV_SKILLS_STAMP_DIR = 'code-mode-skills';

/**
 * Host-side stamp root for a session's dev-instruction surface: a SIBLING of
 * the session dir (`<v2-sessions>/<group>/.code-mode-stamps/<sessionId>`),
 * never a path inside it.
 *
 * <sessDir> itself is bind-mounted RW at /workspace, so a stamp under it is
 * the same inode twice: RO at the nested mount the CLI reads, RW at its
 * /workspace path — and an edit at the RW path shows straight through the RO
 * one. Caught in review: a driver that runs
 * the agent container as the host uid (fsGroup does not apply to hostPath
 * volumes) owns the 644 stamps outright, so `sed -i`
 * on /workspace/code-mode-skills/<name>/SKILL.md rewrote the "host-owned"
 * operating instructions for the rest of the session. The
 * sibling stays under the group's sessions subtree — the 'group-state' rule
 * still vouches for it — but appears nowhere in the container except the RO
 * mounts composed here. Per-session so a spawning sibling session never
 * re-stamps over files a live session has mounted.
 */
export function devStampDir(sessDir: string): string {
  return path.join(path.dirname(sessDir), '.code-mode-stamps', path.basename(sessDir));
}

/**
 * A skill dir's name becomes a container mount path segment; refuse anything
 * outside a closed charset rather than trusting whatever the install tree
 * grew. Fail-closed: a name this cannot vouch for costs that skill, only.
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Stamp the dev-instruction surface for a code-mode session and return its
 * mounts: the operating manual plus the dev skill bundle (devSkillMounts).
 *
 * The stamp lands OUTSIDE the session dir entirely (devStampDir), for two
 * measured reasons. Not into `<sessDir>/group`: that is the container's own
 * working directory, and one left root-owned by a past root container
 * EACCES'd the host's write on every session that predated the move out.
 * And not anywhere else under `<sessDir>` either: that dir IS the RW
 * /workspace, so a stamp there is agent-editable at its RW path and the
 * edit shows through the nested RO mount (the custody hole
 * devStampDir documents).
 *
 * Failure is never fatal. An instruction surface is worth a session's
 * knowledge, never a session's existence — anything unexpected here costs
 * the manual (logged) and the agent still boots.
 */
export function devInstructionMounts(sessDir: string, scope: string): VolumeMount[] {
  try {
    // The runner's cwd backing dir must exist even when the manual is absent
    // (a degraded install without the file must not cost the session its cwd).
    // buildMounts prepares it in every mode too; repeated here so this helper
    // holds on its own.
    fs.mkdirSync(path.join(sessDir, 'group'), { recursive: true });
  } catch (error) {
    // Already there (possibly owned by a past container) is the common case
    // and is fine — we never write INTO it.
    log.debug('Code mode: workspace dir not created by the host', { sessDir, error: String(error) });
  }
  const mounts: VolumeMount[] = [];
  const source = path.join(process.cwd(), CODE_MODE_BUNDLE_DIR, 'CLAUDE.md');
  if (!fs.existsSync(source)) {
    // Fail-open, but never silent: the spawn goes on and the log says why
    // the agent has no manual (the sandbox verbs repeat it to the operator).
    log.warn('Code mode: operating manual missing from the install tree — the agent boots without it', { source });
  } else {
    const stamped = path.join(devStampDir(sessDir), DEV_INSTRUCTION_FILE);
    try {
      fs.mkdirSync(devStampDir(sessDir), { recursive: true });
      fs.copyFileSync(source, stamped);
      mounts.push({
        hostPath: stamped,
        containerPath: `${CODE_WORKSPACE_DIR}/CLAUDE.md`,
        readonly: true,
        mountClass: 'group-state',
        scope,
      });
    } catch (error) {
      log.warn('Code mode: operating manual not stamped — the agent boots without it', {
        sessDir,
        error: String(error),
      });
    }
  }
  mounts.push(...devSkillMounts(sessDir, scope));
  return mounts;
}

/**
 * Stamp the dev skill bundle (container/code-mode/skills/<name>/) for a
 * code-mode session and return one mount per skill.
 *
 * Same route as the manual, generalized: the bundle ships in the install tree
 * but cannot bind from there (not in the drivers' `surfaceRoots`), so each
 * skill dir is host-stamped into `<stampDir>/code-mode-skills/<name>/` —
 * outside `<sessDir>` altogether, because that dir is the RW /workspace and
 * a stamp under it would be agent-editable through the back of the RO mount
 * (devStampDir has the incident) — and nested-RO-mounted at the CLI's skill
 * discovery path under the cwd. 'group-state' by the sessions-root rule:
 * host-owned words the agent reads but cannot edit.
 *
 * Never throws, same rule as every code-mode mount function: anything
 * unexpected costs that skill's mount (logged), never the session.
 */
export function devSkillMounts(sessDir: string, scope: string): VolumeMount[] {
  const source = path.join(process.cwd(), CODE_MODE_BUNDLE_DIR, 'skills');
  let names: string[];
  try {
    names = fs
      .readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // An install tree without the bundle is a degraded install, not a failed
    // session — but a loud one (the sandbox verbs repeat this to the operator).
    log.warn('Code mode: dev skill bundle missing from the install tree — the agent boots without it', { source });
    return [];
  }
  const mounts: VolumeMount[] = [];
  for (const name of names) {
    if (!SKILL_NAME_RE.test(name)) {
      log.warn('Code mode: dev skill name refused — outside the closed charset', { name });
      continue;
    }
    const stamped = path.join(devStampDir(sessDir), DEV_SKILLS_STAMP_DIR, name);
    try {
      // Fresh stamp every spawn: a skill file removed from the install tree must not
      // survive here through a stale copy from a previous boot.
      fs.rmSync(stamped, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(stamped), { recursive: true });
      fs.cpSync(path.join(source, name), stamped, { recursive: true });
    } catch (error) {
      log.warn('Code mode: dev skill not stamped — the agent boots without it', {
        name,
        sessDir,
        error: String(error),
      });
      continue;
    }
    mounts.push({
      hostPath: stamped,
      containerPath: `${CODE_WORKSPACE_DIR}/.claude/skills/${name}`,
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }
  return mounts;
}
