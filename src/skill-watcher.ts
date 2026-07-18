/**
 * Skill watcher — monitors each agent group's ~/.claude/skills/ directory
 * (host path: data/v2-sessions/<group-id>/.claude-shared/skills/) for new
 * or removed skill entries and kills running containers so they respawn with
 * updated skills on the next inbound message.
 *
 * Skills live in two places:
 *   - container/skills/<name>/          — symlinked skills managed by NanoClaw
 *   - .claude-shared/skills/<name>/     — real directories (manually added or
 *                                         installed via self-customize skill)
 *
 * Both are visible at /home/node/.claude/skills/ inside the container.
 * Only the .claude-shared/ location needs watching — syncSkillSymlinks already
 * reconciles container/skills/ on every spawn, so symlink changes are free.
 * Real-directory skills added while a container is running require a restart.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { isContainerRunning, killContainer } from './container-runner.js';
import { log } from './log.js';

const POLL_INTERVAL_MS = 5_000;
const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');

/** Returns all .claude-shared/skills/ paths that exist on disk. */
function findSkillsDirs(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const dirs: string[] = [];
  for (const groupId of fs.readdirSync(SESSIONS_DIR)) {
    const skillsDir = path.join(SESSIONS_DIR, groupId, '.claude-shared', 'skills');
    if (fs.existsSync(skillsDir)) dirs.push(skillsDir);
  }
  return dirs;
}

/** List skill names (both symlinks and real directories) in a skills dir. */
function listSkills(skillsDir: string): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

function reloadRunningContainers(reason: string): void {
  const sessions = getActiveSessions();
  let killed = 0;
  for (const session of sessions) {
    if (isContainerRunning(session.id)) {
      killContainer(session.id, reason);
      killed++;
    }
  }
  if (killed > 0) {
    log.info('Containers reloaded for skill update', { reason, killed });
  }
}

export function startSkillWatcher(): void {
  // Build initial snapshot: map from skillsDir → Set of skill names.
  const snapshot = new Map<string, Set<string>>();
  for (const dir of findSkillsDirs()) {
    snapshot.set(dir, listSkills(dir));
  }

  const totalSkills = [...snapshot.values()].reduce((n, s) => n + s.size, 0);
  log.info('Skill watcher started', { watchedDirs: snapshot.size, totalSkills });

  setInterval(() => {
    // Pick up any new .claude-shared/skills/ dirs (new agent groups).
    for (const dir of findSkillsDirs()) {
      if (!snapshot.has(dir)) snapshot.set(dir, listSkills(dir));
    }

    for (const [dir, known] of snapshot) {
      const current = listSkills(dir);

      const added = [...current].filter((s) => !known.has(s));
      const removed = [...known].filter((s) => !current.has(s));

      if (added.length === 0 && removed.length === 0) continue;

      snapshot.set(dir, current);

      if (added.length > 0) {
        log.info('New skills detected — reloading containers', { dir, added });
        reloadRunningContainers('skill-added');
      }
      if (removed.length > 0) {
        log.info('Skills removed — reloading containers', { dir, removed });
        reloadRunningContainers('skill-removed');
      }
    }
  }, POLL_INTERVAL_MS);
}
