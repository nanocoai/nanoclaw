import fs from 'fs';
import path from 'path';

import { DATA_DIR, DEFAULT_AGENT_PROVIDER, GROUPS_DIR } from './config.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { writeTextIfAbsent } from './fs-hygiene.js';
import { stageGroupPersona } from './group-persona.js';
import { log } from './log.js';
import { migrateClaudeMemorySettings } from './migrate-claude-memory-settings.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      autoMemoryEnabled: false,
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The provider project document is regenerated on every spawn. Initial
 * standing instructions are staged once in the provider-neutral prepend file.
 */
export function initGroupFilesystem(
  group: AgentGroup,
  opts?: { instructions?: string; provider?: string | null },
): void {
  const initialized: string[] = [];

  // `opts.provider` absent means "caller has no provider opinion" — for a
  // brand-new group that resolves to the instance default, so the scaffold and
  // the stamped config row both match it. A caller that knows the provider
  // (subagent → parent's, spawn → resolved, setup → operator's pick) passes it
  // explicitly — including `claude` — which pins the group and skips the
  // default. ensureContainerConfig is INSERT OR IGNORE, so this only stamps a
  // genuinely new group; existing rows are never touched.
  const providerHint = (opts?.provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();

  // Default agent surfaces apply unless the provider declares (at registration)
  // that it provides its own.
  const defaultSurfaces = !providerProvidesAgentSurfaces(providerHint);

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // Run-log directory. Created here rather than lazily on first append so it
  // exists as a bind source at spawn time — see `buildMounts`.
  fs.mkdirSync(path.join(groupDir, 'tasks'), { recursive: true });

  if (opts?.instructions && stageGroupPersona(groupDir, opts.instructions)) {
    initialized.push('instructions.prepend.md');
  }

  // Ensure container_configs row exists in the DB. Idempotent — no-op if
  // the row already exists (e.g. created by backfill or group creation). On a
  // fresh row, stamp the resolved provider hint so a new group is created on
  // the instance default (or the caller's explicit pick).
  ensureContainerConfig(group.id, providerHint);
  initialized.push('container_configs');

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  if (defaultSurfaces) {
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      initialized.push('.claude-shared');
    }

    // `.claude-shared` is mounted at /home/node/.claude and Claude keeps its
    // own state there, so both entries below can already exist — and can
    // exist as something other than what we expect. Claim the name and
    // reconcile on EEXIST, rather than asking whether it is free and then
    // acting on an answer that describes the resolved target rather than the
    // name, and that is stale by the time we use it.
    const settingsFile = path.join(claudeDir, 'settings.json');
    if (writeTextIfAbsent(settingsFile, DEFAULT_SETTINGS_JSON)) {
      initialized.push('settings.json');
    } else if (migrateClaudeMemorySettings(settingsFile)) {
      initialized.push('settings.json (reconciled Claude settings)');
    }

    // Skills directory — created empty here; symlinks are synced at spawn
    // time by container-runner.ts based on container.json skills selection.
    // Non-recursive, so that "already there" is reported rather than assumed:
    // `{ recursive: true }` is silent about what it found.
    const skillsDst = path.join(claudeDir, 'skills');
    try {
      fs.mkdirSync(skillsDst);
      initialized.push('skills/');
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
      const entry = fs.lstatSync(skillsDst);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        log.warn('Per-group skills path is not a directory; leaving it alone', { skillsDst });
      }
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}
