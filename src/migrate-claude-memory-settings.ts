import fs from 'fs';

import { log } from './log.js';

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
const LEGACY_MEMORY_SESSION_START_COMMAND = 'bun /app/src/memory-hook.ts';

/**
 * Claude Code reaps transcripts older than this (its default is 30 days) on a
 * timer inside any session sharing the config dir. A group's sessions share
 * one .claude-shared, so a warm session's cleanup reaps a cold sibling's
 * transcript before that sibling ever wakes to rotate and archive it. 3650 is
 * the value Claude Code's own validation message suggests for long retention.
 */
export const CLEANUP_PERIOD_DAYS = 3650;

/** Reconcile existing Claude settings with NanoClaw's shared memory system. */
export function migrateClaudeMemorySettings(settingsFile: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (!isRecord(parsed)) {
      log.warn('Claude settings root is not an object; leaving it unchanged', { settingsFile });
      return false;
    }

    let changed = false;
    if (parsed.autoMemoryEnabled !== false) {
      parsed.autoMemoryEnabled = false;
      changed = true;
    }

    // Fill the gap only — an operator who picked their own retention keeps it.
    // Anything non-numeric is not a choice we can honour: Claude Code rejects
    // it, which would disable the retention setting entirely.
    if (typeof parsed.cleanupPeriodDays !== 'number') {
      parsed.cleanupPeriodDays = CLEANUP_PERIOD_DAYS;
      changed = true;
    }

    const env = isRecord(parsed.env) ? parsed.env : {};
    if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') {
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      changed = true;
    }
    if (parsed.env !== env) {
      parsed.env = env;
      changed = true;
    }

    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
    const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const nextSessionStart = existingSessionStart
      .map(removeLegacyNanoClawMemoryHook)
      .filter((entry) => entry !== undefined);
    if (JSON.stringify(nextSessionStart) !== JSON.stringify(existingSessionStart)) {
      if (nextSessionStart.length > 0) hooks.SessionStart = nextSessionStart;
      else delete hooks.SessionStart;
      changed = true;
    }

    const preCompact = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
    if (!JSON.stringify(preCompact).includes(PRE_COMPACT_COMMAND)) {
      preCompact.push({ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] });
      hooks.PreCompact = preCompact;
      changed = true;
    }
    if (parsed.hooks !== hooks) {
      parsed.hooks = hooks;
      changed = true;
    }

    if (!changed) return false;
    writeAtomic(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
    return true;
  } catch (err) {
    log.warn('Failed to reconcile Claude settings; leaving them unchanged', {
      settingsFile,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function removeLegacyNanoClawMemoryHook(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const remaining = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return hook.command !== LEGACY_MEMORY_SESSION_START_COMMAND;
  });
  return remaining.length > 0 ? { ...value, hooks: remaining } : undefined;
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename consumed the temp file, or creation failed before it existed.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
