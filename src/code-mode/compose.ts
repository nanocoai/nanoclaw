/**
 * Code mode, piece B: the dev-instruction surface (T2 composition minimum).
 *
 * The code runner starts the interactive CLI at /workspace/group
 * (code-runner/index.ts), and the CLI auto-reads the CLAUDE.md at its cwd —
 * that file is the one instruction surface a code-mode session gets after the
 * D16 strip. The manual itself ships in the install tree
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

import { configuredDevEnvDriverKind, devEnvMaterialsRoot, materialsPath } from '../dev-env/materials.js';
import { mountPolicy } from '../drivers/index.js';
import { classRequiredByPath } from '../drivers/types.js';
import { log } from '../log.js';

import type { VolumeMount } from '../providers/provider-container-registry.js';

/** The code runner's session cwd (code-runner/index.ts `WORKSPACE_DIR`). */
export const CODE_WORKSPACE_DIR = '/workspace/group';

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
 * one. Caught in review before it shipped (2026-08-17): the k8s driver runs
 * the agent container as the host uid (its LANDMINE A — fsGroup does not
 * apply to hostPath volumes), which owns the 644 stamps outright, so `sed -i`
 * on /workspace/code-mode-skills/<name>/SKILL.md rewrote the "host-owned"
 * governance text for the rest of the session. The
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
 * edit shows through the nested RO mount (the review-caught custody hole
 * devStampDir documents).
 *
 * Failure is never fatal. An instruction surface is worth a session's
 * knowledge, never a session's existence — anything unexpected here costs
 * the manual (logged) and the agent still boots.
 */
export function devInstructionMounts(sessDir: string, scope: string): VolumeMount[] {
  try {
    // The runner's cwd backing dir must exist even when the manual is absent
    // (a degraded install without the file must not cost the session its cwd) —
    // nothing else in the tree creates <sessDir>/group.
    fs.mkdirSync(path.join(sessDir, 'group'), { recursive: true });
  } catch (error) {
    // Already there (possibly owned by a past container) is the common case
    // and is fine — we never write INTO it.
    log.debug('Code mode: workspace dir not created by the host', { sessDir, error: String(error) });
  }
  const mounts: VolumeMount[] = [];
  const source = path.join(process.cwd(), 'container', 'code-mode', 'CLAUDE.md');
  if (fs.existsSync(source)) {
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
  const source = path.join(process.cwd(), 'container', 'code-mode', 'skills');
  let names: string[];
  try {
    names = fs
      .readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // An install tree without the bundle is a degraded install, not a failed
    // session — older release artifacts simply don't carry the dir.
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
      // Fresh stamp every spawn: a skill file deleted upstream must not
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

/**
 * Code mode, piece C: the dev-env access materials, mounted where the agent was
 * told they are (D4's in-sandbox half).
 *
 * `ncl envs get` prints `access.kubeconfig` as a HOST path — material by
 * reference, which is the seam's whole discipline — and a path the agent cannot
 * open is not access. So the claiming group's OWN slice of the materials tree
 * is mounted at the SAME absolute path it has host-side: one path that means
 * the same thing in both worlds, with nothing to translate and no second place
 * for the layout to be decided (see dev-env/materials.ts).
 *
 * Read-only, and NEVER the materials root: every group's children live under
 * that root, and a child kubeconfig is cluster-admin of that child. The slice
 * is the isolation.
 *
 * Class 'allowlisted-extra' by the same reasoning the provider-contributed
 * mounts use: the path is computed in-tree from this install's own data root
 * and the group id, with no operator input anywhere in it — vetted by
 * construction rather than by the operator allowlist (which cannot express this
 * mount anyway: it forces container paths under /workspace/extra).
 */
export function devEnvMaterialMounts(scope: string): VolumeMount[] {
  if (!configuredDevEnvDriverKind()) return []; // dev-env is off; nothing mints, nothing to mount
  const dir = materialsPath(devEnvMaterialsRoot(), scope);
  // A deployment that points its session materials root at (or above) the
  // dev-env one turns this into an 'identity-material' path, which is refused
  // on the agent role — and would deny EVERY code-mode spawn. Losing the mount
  // loudly beats losing the sandbox silently.
  const required = classRequiredByPath(dir, mountPolicy());
  if (required) {
    log.warn('Dev-env materials not mounted: the path is pinned to another mount class', { dir, required });
    return [];
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Same rule as the manual: a mount this function could not prepare costs
    // the mount, never the session.
    log.warn('Dev-env materials not mounted: the slice could not be prepared', { dir, error: String(error) });
    return [];
  }
  return [{ hostPath: dir, containerPath: dir, readonly: true, mountClass: 'allowlisted-extra', scope }];
}
